(function () {

const LightweightCharts = (window as any).LightweightCharts;

interface ChartInstance {
  chart: any;
  series: any;
  symbol: string;
  activeRange: string;
  resizeObserver?: ResizeObserver;
}

/** One tile in the headline strip. */
interface StatTile {
  label: string;
  icon: string;
  value: string;
  sub: string;
  route: string;
  title: string;
  tone?: string;
  subTone?: string;
}

/** An allocation cap plus where the account currently sits against it. */
interface CapRow {
  asset: string;
  exchange: string;
  cap: number;
  target: number;
  /** Current share of that one account, or null when it can't be worked out. */
  share: number | null;
  enabled: boolean;
  overBy: number | null;
}

class HomeController {
  private unsubscribe: (() => void) | null = null;
  private charts: Map<string, ChartInstance> = new Map();
  private allPairs: any[] = [];
  private tickerTimer: ReturnType<typeof setInterval> | null = null;
  private chartTimer: ReturnType<typeof setInterval> | null = null;
  private holdingsTimer: ReturnType<typeof setInterval> | null = null;
  private watchlistSymbols: string[] = [];
  private activeSymbol: string | null = null;
  private pfHistory: { reload: () => void; destroy: () => void } | null = null;
  private historyTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly ACTIVE_KEY = 'cyrus_live_active_symbol';
  /** How often the valuation is re-pulled while the page stays open. */
  private static readonly HOLDINGS_INTERVAL = 5 * 60_000;

  private flowTab: 'automations' | 'orders' = 'automations';

  // Everything the panels below are rendered from. Each loader fills its own
  // slice and re-renders; nothing waits on anything else.
  private holdings: any = null;
  private holdingsSig = '';
  private holdingsError = false;
  private rules: any[] = [];
  private rulesLoaded = false;
  private rulesError = false;
  private logs: any[] = [];
  private logsLoaded = false;
  private logsAt = 0;
  private worker: any = null;

  constructor() {
    this.init();
  }

  private init(): void {
    this.initCollapsibleSections();
    this.bindFlowTabs();
    this.attachEventListeners();
    this.loadDashboardData();
    // Portfolio value-over-time chart disabled for now.
    // this.initPortfolioHistory();

    this.unsubscribe = ExchangeStore.onUpdate(() => {
      this.renderFromStore();
      this.loadRules();
      this.loadHoldings();
      this.loadActivity();
    });

    this.tickerTimer = setInterval(() => this.refreshAllTickers(), 5_000);
    this.chartTimer = setInterval(() => this.refreshAllChartData(), 60_000);
    this.holdingsTimer = setInterval(() => this.loadHoldings(true), HomeController.HOLDINGS_INTERVAL);
    // Portfolio history chart disabled for now.
    // this.historyTimer = setInterval(() => this.pfHistory?.reload(), 5 * 60_000);

    const observer = new MutationObserver(() => {
      if (!document.getElementById('live-data-charts')) {
        if (this.unsubscribe) this.unsubscribe();
        if (this.tickerTimer) { clearInterval(this.tickerTimer); this.tickerTimer = null; }
        if (this.chartTimer) { clearInterval(this.chartTimer); this.chartTimer = null; }
        if (this.holdingsTimer) { clearInterval(this.holdingsTimer); this.holdingsTimer = null; }
        if (this.historyTimer) { clearInterval(this.historyTimer); this.historyTimer = null; }
        if (this.pfHistory) { this.pfHistory.destroy(); this.pfHistory = null; }
        this.destroyAllCharts();
        observer.disconnect();
      }
    });
    const content = document.getElementById('app-content');
    if (content) observer.observe(content, { childList: true });
  }

  private bindFlowTabs(): void {
    document.getElementById('overview-flow-tab-strip')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.rules-tab-btn') as HTMLElement | null;
      if (!btn) return;
      const tab = btn.getAttribute('data-tab') as 'automations' | 'orders';
      if (!tab || tab === this.flowTab) return;
      this.flowTab = tab;
      document.querySelectorAll('#overview-flow-tab-strip .rules-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const flowChart = document.getElementById('overview-flow-chart');
      const ordersChart = document.getElementById('overview-orders-chart');
      const openLink = document.getElementById('overview-flow-open-link');
      flowChart?.classList.toggle('d-none', tab !== 'automations');
      ordersChart?.classList.toggle('d-none', tab !== 'orders');
      if (openLink) openLink.setAttribute('data-route', tab === 'automations' ? 'commands' : 'openorders');
      if (tab === 'orders') {
        OrderFlow.render(ordersChart!, ExchangeStore.openOrders);
      }
    });
  }

  private initCollapsibleSections(): void {
    document.querySelectorAll('.section-header[data-collapse]').forEach((header) => {
      const key = header.getAttribute('data-collapse')!;
      const section = header.closest('.overview-section') as HTMLElement | null;
      if (!section) return;

      // Restore collapsed state from sessionStorage
      if (sessionStorage.getItem(`section-collapsed-${key}`) === '1') {
        section.classList.add('collapsed');
      }

      header.addEventListener('click', (e) => {
        // Buttons and the "Open" links inside the header do their own thing.
        if ((e.target as HTMLElement).closest('button, a')) return;
        const isCollapsed = section.classList.toggle('collapsed');
        sessionStorage.setItem(`section-collapsed-${key}`, isCollapsed ? '1' : '0');
      });
    });
  }

  private attachEventListeners(): void {
    // Stat tiles and panel links navigate via their data-route attribute
    // (handled globally by the router), so no per-card click wiring is needed.

    document.getElementById('ov-refresh')?.addEventListener('click', () => this.refreshAll());

    // Live Data: Add Crypto button
    document.getElementById('add-crypto-btn')?.addEventListener('click', () => {
      this.showAddCryptoModal();
    });
    document.getElementById('add-crypto-modal-close')?.addEventListener('click', () => {
      this.hideAddCryptoModal();
    });
    document.getElementById('add-crypto-modal')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'add-crypto-modal') {
        this.hideAddCryptoModal();
      }
    });
    document.getElementById('add-crypto-search')?.addEventListener('input', (e) => {
      this.filterPairs((e.target as HTMLInputElement).value);
    });

    // Live Data: switch the active chart (selection saved locally).
    document.getElementById('live-data-selector')?.addEventListener('change', (e) => {
      const symbol = (e.target as HTMLSelectElement).value;
      if (!symbol || symbol === this.activeSymbol) return;
      this.activeSymbol = symbol;
      localStorage.setItem(HomeController.ACTIVE_KEY, symbol);
      this.renderActiveChart();
    });
  }

  private loadDashboardData(): void {
    this.renderFromStore();
    this.loadRules();
    this.loadHoldings();
    this.loadActivity();
    this.loadWatchlist();
  }

  /** Pull everything this page shows again, ignoring the usual caches. */
  private async refreshAll(): Promise<void> {
    const btn = document.getElementById('ov-refresh');
    btn?.classList.add('is-busy');
    ExchangeStore.invalidateConnectionData();
    try {
      await Promise.all([
        ExchangeStore.refreshOrders(),
        this.loadHoldings(true),
        this.loadRules(),
        this.loadActivity(true),
      ]);
    } finally {
      btn?.classList.remove('is-busy');
    }
  }

  /** Create the portfolio value-over-time chart beside the allocation doughnut. */
  private initPortfolioHistory(): void {
    const el = document.getElementById('portfolio-history');
    if (!el || this.pfHistory) return;

    this.pfHistory = PortfolioHistoryChart.create(el, {
      isDark: !document.body.classList.contains('theme-light'),
      fetch: (range: string) => {
        const isAll = ExchangeStore.isAllMode();
        const connId: number | 'all' = isAll
          ? 'all'
          : (typeof ExchangeStore.activeMode === 'number' ? ExchangeStore.activeMode : 'all');
        return ExchangeController.getPortfolioHistory(range, connId);
      },
    });
  }

  // ── Holdings / portfolio ────────────────────────────────────────

  /**
   * One call to /market/holdings feeds the doughnut, the value and 24h tiles,
   * the biggest-holdings panel and the live shares behind the allocation caps.
   * It only re-runs when the selected exchange changes, on the 5-minute timer,
   * or when the user asks for a refresh.
   */
  private async loadHoldings(force = false): Promise<void> {
    const sig = `${ExchangeStore.activeMode}:${ExchangeStore.connections.length}`;
    if (!force && sig === this.holdingsSig) return;
    this.holdingsSig = sig;

    const chartEl = document.getElementById('portfolio-chart');
    if (ExchangeStore.connections.length === 0) {
      this.holdings = { total_usd: 0, positions: [] };
      this.holdingsError = false;
      this.renderPortfolio();
      return;
    }

    if (!this.holdings && chartEl) {
      chartEl.innerHTML = '<div class="pf-empty"><i class="fa-solid fa-circle-notch fa-spin"></i><p>Valuing your holdings…</p></div>';
    }

    const connId: number | 'all' = ExchangeStore.isAllMode() || typeof ExchangeStore.activeMode !== 'number'
      ? 'all'
      : ExchangeStore.activeMode;

    try {
      const token = AuthController.getToken();
      if (!token) return;
      const resp = await MarketData.getHoldings(token, connId);
      // The selection may have moved on while the request was in flight.
      if (this.holdingsSig !== sig) return;
      this.holdings = resp.data || { total_usd: 0, positions: [] };
      this.holdingsError = false;
    } catch {
      if (this.holdingsSig !== sig) return;
      this.holdingsError = true;
      if (!this.holdings) this.holdings = { total_usd: 0, positions: [] };
    }

    this.renderPortfolio();
    this.pfHistory?.reload();
  }

  /** Everything that depends on the holdings payload. */
  private renderPortfolio(): void {
    const chartEl = document.getElementById('portfolio-chart');
    const positions: any[] = this.holdings?.positions || [];
    if (chartEl) {
      PortfolioChart.render(chartEl, positions, Number(this.holdings?.total_usd || 0));
    }
    this.renderHoldingsList();
    this.renderCaps();
    this.renderStats();
    this.renderMeta();
  }

  /** Total 24h move in dollars, and what that was as a percentage. */
  private dayChange(): { usd: number; pct: number } | null {
    const positions: any[] = this.holdings?.positions || [];
    const priced = positions.filter(p => p.value_change_24h_usd != null);
    if (priced.length === 0) return null;
    const usd = priced.reduce((sum, p) => sum + Number(p.value_change_24h_usd || 0), 0);
    const total = Number(this.holdings?.total_usd || 0);
    const prior = total - usd;
    return { usd, pct: prior > 0 ? (usd / prior) * 100 : 0 };
  }

  private renderHoldingsList(): void {
    const host = document.getElementById('ov-holdings-list');
    if (!host) return;

    const positions: any[] = (this.holdings?.positions || []).slice();
    const chip = document.getElementById('ov-holdings-chip');
    if (chip) {
      chip.textContent = `${positions.length} asset${positions.length === 1 ? '' : 's'}`;
      chip.classList.toggle('d-none', positions.length === 0);
    }

    if (positions.length === 0) {
      host.innerHTML = this.holdingsError
        ? '<p class="ov-empty"><i class="fa-solid fa-triangle-exclamation"></i>Could not value your holdings right now.</p>'
        : '<p class="ov-empty"><i class="fa-solid fa-coins"></i>No holdings on this account yet.</p>';
      return;
    }

    const top = positions.slice(0, 5);
    const rest = positions.slice(5);
    const restValue = rest.reduce((sum, p) => sum + Number(p.usd_value || 0), 0);

    const rows = top.map((p) => {
      const info = p.info || {};
      const price = info.price ?? p.unit_price;
      const change = info.change_24h_pct;

      return `<div class="ov-row ov-hold">
        <span class="ov-hold-name">
          <span class="ov-badge">${this.escapeHtml(p.asset)}</span>
          <span>${this.escapeHtml(p.is_cash ? 'Cash balance' : (info.name || ''))}</span>
        </span>
        ${p.is_cash ? '<span class="ov-spark"></span>' : this.sparkline(info.sparkline_7d, info.change_7d_pct)}
        <span class="ov-num ov-hold-price">
          ${p.is_cash ? '<span class="ov-sub">—</span>' : this.fmtPrice(price)}
          ${p.is_cash ? '' : `<span class="ov-sub ${this.tone(change)}">${this.fmtPct(change)}</span>`}
        </span>
        <span class="ov-num ov-hold-value">
          ${this.fmtUsd(p.usd_value)}
          <span class="ov-sub">${this.fmtPct(p.weight_percent, false)}</span>
        </span>
      </div>`;
    }).join('');

    const foot = rest.length
      ? `<div class="ov-foot"><span>+${rest.length} more holding${rest.length === 1 ? '' : 's'}</span><span>${this.fmtUsd(restValue)}</span></div>`
      : '';

    host.innerHTML = rows + foot;
  }

  // ── Limit orders ────────────────────────────────────────────────

  /** The resting limit orders inside the store's open-order snapshot. */
  private limitOrders(): any[] {
    return ExchangeStore.openOrders.filter(o =>
      (o.type || '').toLowerCase().includes('limit'));
  }

  private orderValue(order: any): number {
    const price = this.toNumber(order.price);
    const volume = this.toNumber(order.volume);
    return price * volume;
  }

  private renderLimitOrders(): void {
    const host = document.getElementById('ov-limit-list');
    if (!host) return;

    const orders = this.limitOrders();
    const buys = orders.filter(o => String(o.side).toLowerCase() === 'buy');
    const sells = orders.filter(o => String(o.side).toLowerCase() === 'sell');

    const chip = document.getElementById('ov-limit-chip');
    if (chip) {
      chip.textContent = orders.length ? `${orders.length}` : '';
      chip.classList.toggle('d-none', orders.length === 0);
    }

    if (ExchangeStore.error && orders.length === 0) {
      host.innerHTML = '<p class="ov-empty"><i class="fa-solid fa-triangle-exclamation"></i>Could not reach the exchange for orders.</p>';
      return;
    }

    if (orders.length === 0) {
      host.innerHTML = '<p class="ov-empty"><i class="fa-solid fa-arrow-right-arrow-left"></i>'
        + 'No resting limit orders. <a href="#" data-route="limitorders">Place one</a></p>';
      return;
    }

    const split = `<div class="ov-split-bar">
      <span class="ov-split-half">
        <span class="ov-split-label ov-up">${buys.length} Buy</span>
        <span class="ov-split-value">${this.fmtUsd(buys.reduce((s, o) => s + this.orderValue(o), 0))}</span>
      </span>
      <span class="ov-split-half">
        <span class="ov-split-label ov-down">${sells.length} Sell</span>
        <span class="ov-split-value">${this.fmtUsd(sells.reduce((s, o) => s + this.orderValue(o), 0))}</span>
      </span>
    </div>`;

    // Newest first — the ones just laddered out are the ones worth a look.
    const sorted = orders.slice().sort((a, b) => (b.opentm || 0) - (a.opentm || 0));
    const shown = sorted.slice(0, 5);
    const isAll = ExchangeStore.isAllMode();

    const rows = shown.map((o) => {
      const side = String(o.side).toLowerCase() === 'sell' ? 'sell' : 'buy';
      return `<div class="ov-row ov-order">
        <span class="ov-side ov-side-${side}">${side.toUpperCase()}</span>
        <span class="ov-order-pair">
          ${this.escapeHtml(o.pair)}
          ${isAll ? `<span class="ov-sub">${this.escapeHtml(o.exchangeName || '')}</span>` : ''}
        </span>
        <span class="ov-num ov-order-price">
          ${this.fmtPrice(this.toNumber(o.price))}
          <span class="ov-sub">${this.escapeHtml(this.fmtAmount(this.toNumber(o.volume)))}</span>
        </span>
        <span class="ov-num ov-order-total">
          ${this.fmtUsd(this.orderValue(o))}
          <span class="ov-sub">${this.relTime(o.opentm)}</span>
        </span>
      </div>`;
    }).join('');

    const hidden = orders.length - shown.length;
    const foot = hidden > 0
      ? `<div class="ov-foot"><span>+${hidden} more resting order${hidden === 1 ? '' : 's'}</span><span></span></div>`
      : '';

    host.innerHTML = split + rows + foot;
  }

  // ── Allocation caps (Balancer) ──────────────────────────────────

  /**
   * Each connection's own asset weights, worked out from the per-venue values
   * in the holdings payload. The balancer caps one account at a time, so an
   * aggregated weight would be the wrong number to compare a cap against.
   */
  private connectionWeights(): { share: Map<string, number>; total: Map<number, number> } {
    const total = new Map<number, number>();
    const value = new Map<string, number>();

    for (const p of (this.holdings?.positions || [])) {
      const asset = String(p.asset).toUpperCase();
      for (const v of (p.venues || [])) {
        const id = Number(v.connection_id);
        const usd = Number(v.usd_value || 0);
        total.set(id, (total.get(id) || 0) + usd);
        value.set(`${id}:${asset}`, (value.get(`${id}:${asset}`) || 0) + usd);
      }
    }

    const share = new Map<string, number>();
    for (const [key, usd] of value) {
      const id = Number(key.split(':')[0]);
      const accountTotal = total.get(id) || 0;
      if (accountTotal > 0) share.set(key, (usd / accountTotal) * 100);
    }
    return { share, total };
  }

  private capRows(): CapRow[] {
    const { share, total } = this.connectionWeights();
    const isAll = ExchangeStore.isAllMode();
    const activeId = ExchangeStore.activeMode;

    const rows = this.rules
      .filter(r => r.trigger_type === 'allocation_threshold')
      .filter(r => isAll || r.trigger_exchange_id === activeId)
      .map((r) => {
        const asset = String(r.action_asset || r.trigger_asset || '').toUpperCase();
        const connId = Number(r.trigger_exchange_id);
        const cap = this.toNumber(r.trigger_allocation_percent);
        // Mirrors AutomationRule.allocation_target(): five points below the cap
        // when the user hasn't set a landing point.
        const rawTarget = r.rebalance_target_percent != null && r.rebalance_target_percent !== ''
          ? this.toNumber(r.rebalance_target_percent)
          : cap - 5;
        const target = Math.max(0, Math.min(rawTarget, cap));
        const accountTotal = total.get(connId);
        const current = accountTotal != null && accountTotal > 0
          ? (share.get(`${connId}:${asset}`) ?? 0)
          : null;
        const over = current != null && cap > 0 && current >= cap;

        return {
          asset,
          exchange: ExchangeStore.getExchangeName(connId),
          cap,
          target,
          share: current,
          enabled: r.is_active !== false,
          overBy: over && accountTotal ? ((current! - target) / 100) * accountTotal : null,
        } as CapRow;
      });

    // Over its cap first, then whatever is closest to one.
    rows.sort((a, b) => {
      const aOver = a.overBy != null ? 1 : 0;
      const bOver = b.overBy != null ? 1 : 0;
      if (aOver !== bOver) return bOver - aOver;
      const aRatio = a.share != null && a.cap > 0 ? a.share / a.cap : -1;
      const bRatio = b.share != null && b.cap > 0 ? b.share / b.cap : -1;
      if (aRatio !== bRatio) return bRatio - aRatio;
      return a.asset.localeCompare(b.asset);
    });
    return rows;
  }

  private renderCaps(): void {
    const host = document.getElementById('ov-caps-list');
    if (!host) return;

    const rows = this.rulesLoaded ? this.capRows() : [];
    const overCount = rows.filter(r => r.overBy != null).length;

    const chip = document.getElementById('ov-caps-chip');
    if (chip) {
      chip.textContent = overCount > 0 ? `${overCount} over cap` : '';
      chip.classList.toggle('d-none', overCount === 0);
      chip.classList.toggle('ov-warn', overCount > 0);
    }

    if (this.rulesError) {
      host.innerHTML = '<p class="ov-empty"><i class="fa-solid fa-triangle-exclamation"></i>Could not load your caps right now.</p>';
      return;
    }
    if (!this.rulesLoaded) return;

    if (rows.length === 0) {
      host.innerHTML = '<p class="ov-empty"><i class="fa-solid fa-scale-balanced"></i>'
        + 'No allocation caps set. <a href="#" data-route="rebalancer">Set one up</a></p>';
      return;
    }

    const shown = rows.slice(0, 4);
    const isAll = ExchangeStore.isAllMode();

    const body = shown.map((r) => {
      // Each bar is scaled to its own cap so "how close am I" is the thing you
      // read, rather than every bar sitting in the first third of the track.
      const scale = Math.max(r.cap, r.share ?? 0) * 1.3 || 100;
      const fill = r.share != null ? Math.min(100, (r.share / scale) * 100) : 0;
      const mark = Math.min(100, (r.cap / scale) * 100);
      const cls = r.overBy != null ? ' ov-cap-over' : (!r.enabled ? ' ov-cap-paused' : '');

      return `<div class="ov-row ov-cap${cls}">
        <span>
          <span class="ov-badge">${this.escapeHtml(r.asset)}</span>
          ${isAll ? `<span class="ov-sub">${this.escapeHtml(r.exchange)}</span>` : ''}
        </span>
        <span class="ov-cap-bar" title="${this.escapeAttr(`${this.fmtPct(r.share, false)} of ${r.exchange}, cap ${this.fmtPct(r.cap, false)}`)}">
          <span class="ov-cap-fill" style="width:${fill.toFixed(1)}%"></span>
          <span class="ov-cap-mark" style="left:${mark.toFixed(1)}%"></span>
        </span>
        <span class="ov-num ov-cap-nums">
          ${r.share != null ? this.fmtPct(r.share, false) : '—'} / ${this.fmtPct(r.cap, false)}
          <span class="ov-sub ${r.overBy != null ? 'ov-warn' : ''}">${
            !r.enabled ? 'paused'
              : r.overBy != null ? `trim ${this.fmtUsd(r.overBy)}`
              : `down to ${this.fmtPct(r.target, false)}`
          }</span>
        </span>
      </div>`;
    }).join('');

    const hidden = rows.length - shown.length;
    const foot = hidden > 0
      ? `<div class="ov-foot"><span>+${hidden} more cap${hidden === 1 ? '' : 's'}</span><span></span></div>`
      : '';

    host.innerHTML = body + foot;
  }

  // ── Automations: rules, activity, worker ────────────────────────

  private async loadRules(): Promise<void> {
    try {
      this.rules = await AutomationController.getRules();
      this.rulesLoaded = true;
      this.rulesError = false;
    } catch {
      this.rules = [];
      this.rulesLoaded = false;
      this.rulesError = true;
    }

    const isAll = ExchangeStore.isAllMode();
    const activeId = ExchangeStore.activeMode;
    const scoped = isAll
      ? this.rules
      : this.rules.filter((r: any) => r.trigger_exchange_id === activeId);

    const flowChart = document.getElementById('overview-flow-chart');
    if (flowChart) {
      RuleFlow.render(flowChart, scoped, {
        exchangeName: (id) => ExchangeStore.getExchangeName(id),
        // Same affordance as the Automations page, but the editor lives there —
        // hand the rule over and let that page open it.
        onSelectRule: (rule) => router.navigate('commands', { editRuleId: String(rule.id) }),
      });
    }

    this.renderCaps();
    this.renderActivity();
    this.renderStats();
  }

  /** Rules in scope for the selected exchange. */
  private scopedRules(): any[] {
    if (ExchangeStore.isAllMode()) return this.rules;
    return this.rules.filter((r: any) => r.trigger_exchange_id === ExchangeStore.activeMode);
  }

  /**
   * Recent runs plus the worker's own liveness. Throttled to once a minute
   * because the store notifies on both its order and address refreshes.
   */
  private async loadActivity(force = false): Promise<void> {
    if (!force && this.logsAt && Date.now() - this.logsAt < 60_000) return;
    this.logsAt = Date.now();

    const [logs, worker] = await Promise.all([
      AutomationController.getLogs(12).catch(() => null),
      AutomationController.getWorkerStatus().catch(() => null),
    ]);

    if (logs) { this.logs = logs; this.logsLoaded = true; }
    this.worker = worker;

    this.renderActivity();
  }

  private renderActivity(): void {
    const host = document.getElementById('ov-activity-list');
    if (!host) return;

    const badge = document.getElementById('ov-worker');
    if (badge) {
      if (!this.worker) {
        badge.className = 'ov-worker';
        badge.innerHTML = '';
      } else {
        const up = this.worker.healthy === true;
        badge.className = `ov-worker ${up ? 'ov-worker-up' : 'ov-worker-down'}`;
        badge.innerHTML = `<span class="ov-worker-dot"></span>${up ? 'engine live' : 'engine down'}`;
        badge.setAttribute('title', up
          ? `Automation worker checked in ${this.relTime(Date.now() - (Number(this.worker.age_seconds) || 0) * 1000)}`
          : `Automation worker is ${this.worker.state || 'not running'}`);
      }
    }

    if (!this.logsLoaded) return;

    // Only runs of rules on the selected exchange — unless the rule list itself
    // failed to load, in which case scope is unknown and everything is shown.
    const inScope = new Set(this.scopedRules().map((r: any) => r.id));
    const names = new Map<number, string>(this.rules.map((r: any) => [r.id, r.rule_name]));
    const logs = this.logs
      .filter(l => !this.rulesLoaded || inScope.has(l.rule_id))
      .slice(0, 5);

    if (logs.length === 0) {
      host.innerHTML = '<p class="ov-empty"><i class="fa-solid fa-bolt"></i>'
        + 'Nothing has run yet. <a href="#" data-route="commands">Build an automation</a></p>';
      return;
    }

    host.innerHTML = logs.map((l) => {
      const status = ['success', 'error', 'skipped'].includes(l.status) ? l.status : 'skipped';
      const detail = l.action_result || l.action_executed || l.trigger_event || '';
      return `<div class="ov-row ov-act ov-act-${status}">
        <span class="ov-act-dot"></span>
        <span class="ov-act-body">
          <span class="ov-act-rule">${this.escapeHtml(names.get(l.rule_id) || 'Automation')}</span>
          <span class="ov-act-detail" title="${this.escapeAttr(detail)}">${this.escapeHtml(detail)}</span>
        </span>
        <span class="ov-act-time">${this.relTime(l.created_at)}</span>
      </div>`;
    }).join('');
  }

  // ── Headline tiles + header meta ────────────────────────────────

  private renderStats(): void {
    const host = document.getElementById('ov-stats');
    if (!host) return;

    const positions: any[] = this.holdings?.positions || [];
    const coins = positions.filter(p => !p.is_cash).length;
    const cash = positions.filter(p => p.is_cash)
      .reduce((sum, p) => sum + Number(p.usd_value || 0), 0);
    const valued = this.holdings != null;
    const change = this.dayChange();

    const orders = ExchangeStore.openOrders;
    const ordersKnown = !ExchangeStore.error || orders.length > 0;
    const pairs = new Set(orders.map(o => o.pair)).size;
    const limits = this.limitOrders();
    const buys = limits.filter(o => String(o.side).toLowerCase() === 'buy').length;

    const rules = this.scopedRules();
    const active = rules.filter((r: any) => r.is_active !== false).length;
    const paused = rules.length - active;
    const caps = this.capRows();
    const overCaps = caps.filter(c => c.overBy != null).length;

    const tiles: StatTile[] = [
      {
        label: 'Portfolio',
        icon: 'fa-wallet',
        value: valued ? this.fmtUsd(this.holdings.total_usd) : '—',
        sub: valued
          ? `${coins} coin${coins === 1 ? '' : 's'}${cash > 0 ? ` · ${this.fmtUsd(cash)} cash` : ''}`
          : 'Valuing…',
        route: 'holdings',
        title: 'Total value of everything you hold',
      },
      {
        label: '24h change',
        icon: change && change.usd < 0 ? 'fa-arrow-trend-down' : 'fa-arrow-trend-up',
        value: change ? `${change.usd >= 0 ? '+' : '−'}${this.fmtUsd(Math.abs(change.usd))}` : '—',
        sub: change ? `${this.fmtPct(change.pct)} of portfolio` : 'No market data',
        tone: change ? this.tone(change.usd) : undefined,
        route: 'holdings',
        title: 'What the last day did to your portfolio in dollars',
      },
      {
        label: 'Open orders',
        icon: 'fa-clock-rotate-left',
        value: ordersKnown ? String(orders.length) : '—',
        sub: ordersKnown
          ? (orders.length ? `across ${pairs} pair${pairs === 1 ? '' : 's'}` : 'nothing working')
          : 'Exchange unreachable',
        route: 'openorders',
        title: 'Every order currently working on the exchange',
      },
      {
        label: 'Limit orders',
        icon: 'fa-arrow-right-arrow-left',
        value: ordersKnown ? String(limits.length) : '—',
        sub: limits.length ? `${buys} buy · ${limits.length - buys} sell` : 'none resting',
        route: 'limitorders',
        title: 'Resting limit orders waiting for their price',
      },
      {
        label: 'Automations',
        icon: 'fa-bolt',
        value: this.rulesLoaded ? String(active) : '—',
        sub: !this.rulesLoaded ? 'Loading…'
          : paused > 0 ? `${paused} paused` : (active ? 'all active' : 'none yet'),
        route: 'commands',
        title: 'Rules the automation worker is watching',
      },
      {
        label: 'Allocation caps',
        icon: 'fa-scale-balanced',
        value: this.rulesLoaded ? String(caps.length) : '—',
        sub: !this.rulesLoaded ? 'Loading…'
          : overCaps > 0 ? `${overCaps} over cap` : (caps.length ? 'within caps' : 'none set'),
        subTone: overCaps > 0 ? 'ov-warn' : undefined,
        route: 'rebalancer',
        title: 'How much of the account any one coin may become',
      },
    ];

    host.innerHTML = tiles.map(t => `
      <a href="#" class="ov-stat" data-route="${t.route}" title="${this.escapeAttr(t.title)}">
        <span class="ov-stat-label"><i class="fa-solid ${t.icon}"></i>${this.escapeHtml(t.label)}</span>
        <span class="ov-stat-value ${t.tone || ''}">${t.value}</span>
        <span class="ov-stat-sub ${t.subTone || ''}">${this.escapeHtml(t.sub)}</span>
      </a>`).join('');
  }

  private renderMeta(): void {
    const el = document.getElementById('ov-meta');
    if (!el) return;

    const parts: string[] = [];
    const count = ExchangeStore.connections.length;
    if (count > 0) parts.push(`${count} exchange${count === 1 ? '' : 's'} connected`);
    if (ExchangeStore.lastUpdated) parts.push(`updated ${this.relTime(ExchangeStore.lastUpdated.getTime())}`);

    const stale = Number(this.holdings?.market_data_stale_seconds || 0);
    const warn = this.holdings && this.holdings.market_data_live === false;
    if (warn) {
      const mins = Math.round(stale / 60);
      parts.push(stale > 0
        ? `market data ${mins >= 60 ? `${Math.round(mins / 60)}h` : `${Math.max(1, mins)}m`} old`
        : 'market data unavailable');
    }

    el.textContent = parts.join(' · ');
    el.classList.toggle('ov-meta-warn', !!warn);
  }

  // ── Live Data / Charts ──────────────────────────────────────────

  private async loadWatchlist(): Promise<void> {
    try {
      const token = AuthController.getToken();
      if (!token) return;
      const resp = await WatchlistData.getWatchlist(token);
      const items: any[] = resp.data || [];
      this.watchlistSymbols = items.map((i: any) => i.symbol);

      if (this.watchlistSymbols.length === 0) {
        this.activeSymbol = null;
        this.populateSelector();
        this.destroyAllCharts();
        this.showEmptyState();
        return;
      }

      // Restore the last viewed chart (saved locally, not in the DB).
      const saved = localStorage.getItem(HomeController.ACTIVE_KEY);
      this.activeSymbol = saved && this.watchlistSymbols.includes(saved)
        ? saved
        : this.watchlistSymbols[0];

      this.populateSelector();
      await this.renderActiveChart();
    } catch {
      // silently fail — empty state shows
    }
  }

  /** Fill the chart selector with the watched symbols. */
  private populateSelector(): void {
    const sel = document.getElementById('live-data-selector') as HTMLSelectElement | null;
    if (!sel) return;
    sel.innerHTML = this.watchlistSymbols
      .map((s) => `<option value="${this.escapeHtml(s)}">${this.escapeHtml(s)}</option>`)
      .join('');
    if (this.activeSymbol) sel.value = this.activeSymbol;
    sel.classList.toggle('d-none', this.watchlistSymbols.length === 0);
  }

  private async renderActiveChart(): Promise<void> {
    const symbol = this.activeSymbol;
    if (!symbol) return;

    this.hideEmptyState();
    const container = document.getElementById('live-data-charts');
    if (!container) return;

    // Only one chart is shown at a time — tear down any previous one.
    this.destroyAllCharts();
    container.querySelectorAll('.chart-card').forEach((el) => el.remove());

    const cardId = this.symbolToId(symbol);
    const savedRange = localStorage.getItem(`chart-range-${symbol}`) || '1D';

    const card = document.createElement('div');
    card.className = 'chart-card';
    card.id = `chart-card-${cardId}`;
    card.setAttribute('data-symbol', symbol);
    card.innerHTML = `
      <div class="chart-header">
        <div class="chart-header-left">
          <span class="chart-symbol">${this.escapeHtml(symbol)}</span>
          <span class="chart-price" id="chart-price-${cardId}">--</span>
          <span class="chart-change" id="chart-change-${cardId}"></span>
        </div>
        <button class="chart-remove-btn" data-symbol="${this.escapeHtml(symbol)}" title="Remove">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
      <div class="time-range-selector" id="time-range-${cardId}">
        ${['1H','12H','1D','1W','1M','3M','YTD','1Y'].map(r =>
          `<button class="time-range-btn${r === savedRange ? ' active' : ''}" data-range="${r}">${r}</button>`
        ).join('\n        ')}
      </div>
      <div class="chart-container" id="chart-el-${cardId}"></div>
    `;
    container.appendChild(card);

    // Remove button
    card.querySelector('.chart-remove-btn')?.addEventListener('click', () => {
      this.removeCrypto(symbol);
    });

    // Time range buttons
    card.querySelectorAll('.time-range-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const range = (e.currentTarget as HTMLElement).getAttribute('data-range') || '1D';
        card.querySelectorAll('.time-range-btn').forEach(b => b.classList.remove('active'));
        (e.currentTarget as HTMLElement).classList.add('active');
        localStorage.setItem(`chart-range-${symbol}`, range);
        this.loadChartData(symbol, range);
      });
    });

    // Create lightweight-charts instance
    const chartEl = document.getElementById(`chart-el-${cardId}`);
    if (!chartEl) return;

    const isDark = !document.body.classList.contains('theme-light');
    const gridColor    = isDark ? 'rgba(148,163,184,0.05)' : 'rgba(0,0,0,0.05)';
    const borderColor  = isDark ? 'rgba(148,163,184,0.10)' : 'rgba(0,0,0,0.10)';
    const textColor    = isDark ? '#64748b' : '#64748b';
    const chart = LightweightCharts.createChart(chartEl, {
      width: chartEl.clientWidth,
      height: 280,
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor,
        fontSize: 11,
      },
      grid: {
        vertLines: { color: gridColor },
        horzLines: { color: gridColor },
      },
      rightPriceScale: {
        borderColor,
        scaleMargins: { top: 0.12, bottom: 0.08 },
      },
      timeScale: {
        borderColor,
        timeVisible: true,
        fixLeftEdge: true,
        fixRightEdge: true,
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: {
          color: 'rgba(6, 182, 212, 0.4)',
          labelBackgroundColor: '#0891b2',
        },
        horzLine: {
          color: 'rgba(6, 182, 212, 0.4)',
          labelBackgroundColor: '#0891b2',
        },
      },
      handleScroll: false,
      handleScale: false,
    });

    const series = chart.addSeries(LightweightCharts.AreaSeries, {
      topColor: isDark ? 'rgba(6, 182, 212, 0.22)' : 'rgba(6, 182, 212, 0.18)',
      bottomColor: 'rgba(6, 182, 212, 0.0)',
      lineColor: '#06b6d4',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 8, minMove: 0.00000001 },
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineColor: 'rgba(6, 182, 212, 0.4)',
      priceLineWidth: 1,
      priceLineStyle: LightweightCharts.LineStyle?.Dashed ?? 1,
    });

    const inst: ChartInstance = { chart, series, symbol, activeRange: savedRange };
    this.charts.set(symbol, inst);

    // Responsive resize — skip if the chart was disposed or replaced.
    const resizeObserver = new ResizeObserver(() => {
      if (this.charts.get(symbol) !== inst) return;
      if (chartEl.clientWidth > 0) {
        try {
          chart.applyOptions({ width: chartEl.clientWidth });
          chart.timeScale().fitContent();
        } catch { /* disposed */ }
      }
    });
    resizeObserver.observe(chartEl);
    inst.resizeObserver = resizeObserver;

    await this.loadChartData(symbol, savedRange);
    this.loadTicker(symbol);
  }

  private async loadChartData(symbol: string, range: string): Promise<void> {
    const inst = this.charts.get(symbol);
    if (!inst) return;
    inst.activeRange = range;

    try {
      const token = AuthController.getToken();
      if (!token) return;
      const resp = await MarketData.getOHLCV(token, symbol, range);
      // The chart may have been disposed/replaced while awaiting data.
      if (this.charts.get(symbol) !== inst) return;
      const candles: any[] = resp.data || [];
      const lineData = candles.map((c: any) => ({ time: c.time, value: c.close }));

      // Adapt price precision to actual values
      const maxPrice = Math.max(...candles.map((c: any) => c.close), 0);
      let precision: number;
      let minMove: number;
      if (maxPrice >= 1)        { precision = 2; minMove = 0.01; }
      else if (maxPrice >= 0.01) { precision = 4; minMove = 0.0001; }
      else if (maxPrice >= 0.0001) { precision = 6; minMove = 0.000001; }
      else                       { precision = 8; minMove = 0.00000001; }
      inst.series.applyOptions({ priceFormat: { type: 'price', precision, minMove } });

      inst.series.setData(lineData);
      const hideTime = ['3M', 'YTD', '1Y', '5Y', 'ALL'].includes(range);
      inst.chart.applyOptions({ timeScale: { timeVisible: !hideTime } });
      inst.chart.timeScale().fitContent();

      // Update percent change based on chart data range
      const cardId = this.symbolToId(symbol);
      const changeEl = document.getElementById(`chart-change-${cardId}`);
      if (changeEl && candles.length >= 2) {
        const first = candles[0].open;
        const last = candles[candles.length - 1].close;
        const pct = first !== 0 ? ((last - first) / first) * 100 : 0;
        changeEl.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
        changeEl.className = `chart-change ${pct >= 0 ? 'price-positive' : 'price-negative'}`;
      }
    } catch (err: any) {
      // Show a visible error inside the chart card so silent failures are obvious
      const cardId = this.symbolToId(symbol);
      const chartContainerEl = document.getElementById(`chart-el-${cardId}`);
      if (chartContainerEl && this.charts.get(symbol) === inst) {
        chartContainerEl.innerHTML = `<div class="chart-error"><i class="fa-solid fa-triangle-exclamation"></i> Failed to load data${err?.message ? ': ' + err.message : ''}</div>`;
      }
    }
  }

  private async loadTicker(symbol: string): Promise<void> {
    const cardId = this.symbolToId(symbol);
    try {
      const token = AuthController.getToken();
      if (!token) return;
      const resp = await MarketData.getTicker(token, symbol);
      const t = resp.data;
      if (!t) return;

      const priceEl = document.getElementById(`chart-price-${cardId}`);

      if (priceEl && t.last != null) {
        const price = Number(t.last);
        const fracDigits = price >= 1 ? 2 : price >= 0.01 ? 4 : 8;
        priceEl.textContent = `$${price.toLocaleString(undefined, { minimumFractionDigits: fracDigits, maximumFractionDigits: fracDigits })}`;
      }
    } catch {
      // leave as --
    }
  }

  private async removeCrypto(symbol: string): Promise<void> {
    try {
      const token = AuthController.getToken();
      if (token) {
        await WatchlistData.removeFromWatchlist(token, symbol);
      }
    } catch {
      // continue removing from UI anyway
    }

    this.watchlistSymbols = this.watchlistSymbols.filter((s) => s !== symbol);

    const inst = this.charts.get(symbol);
    if (inst) {
      try { inst.resizeObserver?.disconnect(); } catch {}
      inst.chart.remove();
      this.charts.delete(symbol);
    }
    const cardId = this.symbolToId(symbol);
    document.getElementById(`chart-card-${cardId}`)?.remove();

    // If we removed the active chart, fall back to another (or the empty state).
    if (this.activeSymbol === symbol) {
      this.activeSymbol = this.watchlistSymbols[0] || null;
      if (this.activeSymbol) localStorage.setItem(HomeController.ACTIVE_KEY, this.activeSymbol);
      else localStorage.removeItem(HomeController.ACTIVE_KEY);
    }

    this.populateSelector();
    if (this.activeSymbol) {
      await this.renderActiveChart();
    } else {
      this.showEmptyState();
    }
  }

  private async showAddCryptoModal(): Promise<void> {
    const modal = document.getElementById('add-crypto-modal');
    modal?.classList.remove('d-none');
    (document.getElementById('add-crypto-search') as HTMLInputElement).value = '';

    if (this.allPairs.length === 0) {
      try {
        const token = AuthController.getToken();
        if (!token) return;
        const resp = await MarketData.getPairs(token);
        this.allPairs = resp.data || [];
      } catch {
        const list = document.getElementById('add-crypto-list');
        if (list) list.innerHTML = '<p class="add-crypto-loading">Failed to load pairs</p>';
        return;
      }
    }
    this.filterPairs('');
  }

  private hideAddCryptoModal(): void {
    document.getElementById('add-crypto-modal')?.classList.add('d-none');
  }

  private filterPairs(query: string): void {
    const list = document.getElementById('add-crypto-list');
    if (!list) return;

    const q = query.toLowerCase().trim();
    const watchedSymbols = new Set(this.watchlistSymbols);
    const filtered = this.allPairs.filter((p: any) => {
      if (watchedSymbols.has(p.symbol)) return false;
      if (!q) return true;
      return p.symbol.toLowerCase().includes(q) || p.base.toLowerCase().includes(q);
    });

    if (filtered.length === 0) {
      list.innerHTML = '<p class="add-crypto-loading">No matching pairs</p>';
      return;
    }

    list.innerHTML = filtered.slice(0, 50).map((p: any) => {
      return `<button class="add-crypto-item" data-symbol="${this.escapeHtml(p.symbol)}">
        <span class="add-crypto-item-base">${this.escapeHtml(p.base)}</span>
        <span class="add-crypto-item-symbol">${this.escapeHtml(p.symbol)}</span>
      </button>`;
    }).join('');

    list.querySelectorAll('.add-crypto-item').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const sym = (e.currentTarget as HTMLElement).getAttribute('data-symbol');
        if (sym) await this.addCrypto(sym);
      });
    });
  }

  private async addCrypto(symbol: string): Promise<void> {
    if (this.watchlistSymbols.includes(symbol)) return;

    try {
      const token = AuthController.getToken();
      if (token) {
        await WatchlistData.addToWatchlist(token, symbol);
      }
    } catch {
      // continue rendering even if save fails
    }

    this.watchlistSymbols.push(symbol);
    this.activeSymbol = symbol;
    localStorage.setItem(HomeController.ACTIVE_KEY, symbol);

    this.hideAddCryptoModal();
    this.populateSelector();
    await this.renderActiveChart();
  }

  private showEmptyState(): void {
    document.getElementById('live-data-empty')?.classList.remove('d-none');
  }

  private hideEmptyState(): void {
    document.getElementById('live-data-empty')?.classList.add('d-none');
  }

  private async refreshAllTickers(): Promise<void> {
    for (const [symbol] of this.charts) {
      try { await this.loadTicker(symbol); } catch { /* skip */ }
    }
  }

  private async refreshAllChartData(): Promise<void> {
    for (const [symbol, inst] of this.charts) {
      try { await this.loadChartData(symbol, inst.activeRange); } catch { /* skip */ }
    }
  }

  private destroyAllCharts(): void {
    this.charts.forEach((inst) => {
      try { inst.resizeObserver?.disconnect(); } catch {}
      try { inst.chart.remove(); } catch {}
    });
    this.charts.clear();
  }

  private symbolToId(symbol: string): string {
    return symbol.replace(/[^a-zA-Z0-9]/g, '_');
  }

  // ── Store-driven sections ───────────────────────────────────────

  private renderFromStore(): void {
    const isAll = ExchangeStore.isAllMode();

    const subtitle = document.getElementById('page-subtitle');
    if (subtitle) {
      subtitle.textContent = isAll
        ? 'A quick look at your accounts'
        : `A quick look at your ${ExchangeStore.getExchangeName(ExchangeStore.activeMode as number)} account`;
    }

    if (!ExchangeStore.error) {
      const ordersChart = document.getElementById('overview-orders-chart');
      if (ordersChart) OrderFlow.render(ordersChart, ExchangeStore.openOrders);
    }

    this.renderLimitOrders();
    this.renderStats();
    this.renderMeta();
  }

  // ── Formatting ──────────────────────────────────────────────────

  private toNumber(value: any): number {
    const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
    return Number.isFinite(n) ? n : 0;
  }

  private fmtUsd(value: any): string {
    const n = this.toNumber(value);
    const abs = Math.abs(n);
    if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
    if (abs >= 1000) return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (abs >= 1) return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (abs === 0) return '$0';
    return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }

  private fmtPrice(value: any): string {
    const n = this.toNumber(value);
    if (n === 0) return '—';
    const digits = n >= 1000 ? 0 : n >= 1 ? 2 : n >= 0.01 ? 4 : 8;
    return '$' + n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  private fmtAmount(value: any): string {
    const n = this.toNumber(value);
    if (n === 0) return '0';
    if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
    return n.toLocaleString(undefined, { maximumFractionDigits: 8 });
  }

  private fmtPct(value: any, signed = true): string {
    if (value == null || value === '') return '—';
    const n = this.toNumber(value);
    const sign = signed && n > 0 ? '+' : '';
    return `${sign}${n.toFixed(Math.abs(n) < 10 ? 2 : 1)}%`;
  }

  private tone(value: any): string {
    const n = this.toNumber(value);
    if (n > 0) return 'ov-up';
    if (n < 0) return 'ov-down';
    return '';
  }

  /** "just now" / "35m" / "6h" / "3d" — accepts a timestamp or a date string.
   *
   *  Backend timestamps are UTC but arrive without a zone (SQLite's
   *  CURRENT_TIMESTAMP as "YYYY-MM-DD HH:MM:SS", datetime.isoformat() with a
   *  "T"), and Date.parse reads a zone-less string as *local* time. Both shapes
   *  get a "Z" so the offset isn't applied twice. */
  private relTime(value: any): string {
    if (value == null || value === '') return '';
    let ms: number;
    if (typeof value === 'number') {
      ms = value;
    } else {
      let text = String(value).trim().replace(' ', 'T');
      if (!/(Z|[+-]\d{2}:?\d{2})$/.test(text)) text += 'Z';
      ms = Date.parse(text);
    }
    if (!Number.isFinite(ms)) return '';
    const secs = Math.max(0, (Date.now() - ms) / 1000);
    if (secs < 60) return 'just now';
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
  }

  /** Inline 7-day sparkline — enough to see the shape of the week. */
  private sparkline(series: number[] | undefined, change: number | null | undefined): string {
    if (!series || series.length < 2) return '<span class="ov-spark"></span>';
    const W = 54, H = 22;
    const min = Math.min(...series);
    const max = Math.max(...series);
    const span = max - min || 1;
    const points = series.map((v, i) => {
      const x = (i / (series.length - 1)) * W;
      const y = H - ((v - min) / span) * (H - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const cls = this.toNumber(change) < 0 ? 'ov-spark-down' : 'ov-spark-up';
    return `<svg class="ov-spark ${cls}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"
      role="img" aria-label="7 day price trend"><polyline points="${points}"></polyline></svg>`;
  }

  private escapeHtml(str: any): string {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  }

  /** escapeHtml leaves quotes alone, which isn't safe inside an attribute. */
  private escapeAttr(str: any): string {
    return this.escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
}

new HomeController();

})();
