(function () {

const LightweightCharts = (window as any).LightweightCharts;

interface ChartInstance {
  chart: any;
  series: any;
  symbol: string;
  activeRange: string;
  resizeObserver?: ResizeObserver;
}

class HomeController {
  private unsubscribe: (() => void) | null = null;
  private charts: Map<string, ChartInstance> = new Map();
  private allPairs: any[] = [];
  private tickerTimer: ReturnType<typeof setInterval> | null = null;
  private chartTimer: ReturnType<typeof setInterval> | null = null;
  private watchlistSymbols: string[] = [];
  private activeSymbol: string | null = null;
  private portfolioSig = '';
  private static readonly ACTIVE_KEY = 'cyrus_live_active_symbol';

  private flowTab: 'automations' | 'orders' = 'automations';

  constructor() {
    this.init();
  }

  private init(): void {
    this.initCollapsibleSections();
    this.bindFlowTabs();
    this.attachEventListeners();
    this.loadDashboardData();

    this.unsubscribe = ExchangeStore.onUpdate(() => {
      this.renderFromStore();
      this.loadCommandsCount();
      this.refreshPortfolio();
    });

    this.tickerTimer = setInterval(() => this.refreshAllTickers(), 5_000);
    this.chartTimer = setInterval(() => this.refreshAllChartData(), 60_000);

    const observer = new MutationObserver(() => {
      if (!document.getElementById('live-data-charts')) {
        if (this.unsubscribe) this.unsubscribe();
        if (this.tickerTimer) { clearInterval(this.tickerTimer); this.tickerTimer = null; }
        if (this.chartTimer) { clearInterval(this.chartTimer); this.chartTimer = null; }
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
        // Don't collapse when clicking buttons inside the header
        if ((e.target as HTMLElement).closest('button')) return;
        const isCollapsed = section.classList.toggle('collapsed');
        sessionStorage.setItem(`section-collapsed-${key}`, isCollapsed ? '1' : '0');
      });
    });
  }

  private attachEventListeners(): void {
    // Summary cards navigate via their data-route attribute (handled globally
    // by the router), so no per-card click wiring is needed here.

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
    this.setCardValue('custom-commands-count', '0');

    this.renderFromStore();
    this.loadCommandsCount();
    this.refreshPortfolio();
    this.loadWatchlist();
  }

  /** Reload the portfolio only when the exchange mode or connection set changes. */
  private refreshPortfolio(): void {
    const sig = `${ExchangeStore.activeMode}:${ExchangeStore.connections.length}`;
    if (sig === this.portfolioSig) return;
    this.portfolioSig = sig;
    this.loadPortfolio();
  }

  private async loadPortfolio(): Promise<void> {
    const chartEl = document.getElementById('portfolio-chart');
    if (!chartEl) return;

    const isAll = ExchangeStore.isAllMode();
    const targets = isAll
      ? ExchangeStore.connections.map((c: any) => c.id)
      : (typeof ExchangeStore.activeMode === 'number' ? [ExchangeStore.activeMode] : []);

    if (targets.length === 0) {
      PortfolioChart.render(chartEl, [], 0);
      return;
    }

    chartEl.innerHTML = '<div class="pf-empty"><i class="fa-solid fa-circle-notch fa-spin"></i><p>Valuing your holdings…</p></div>';

    try {
      const results = await Promise.all(targets.map((id: number) =>
        ExchangeController.getPortfolio(id).catch(() => ({ positions: [], total_usd: 0 }))
      ));

      // Aggregate the same asset across exchanges.
      const byAsset = new Map<string, { asset: string; amount: number; usd_value: number }>();
      let total = 0;
      for (const r of results) {
        for (const p of (r.positions || [])) {
          const cur = byAsset.get(p.asset);
          if (cur) { cur.amount += p.amount; cur.usd_value += p.usd_value; }
          else byAsset.set(p.asset, { asset: p.asset, amount: p.amount, usd_value: p.usd_value });
          total += p.usd_value;
        }
      }
      const positions = [...byAsset.values()].sort((a, b) => b.usd_value - a.usd_value);
      PortfolioChart.render(chartEl, positions, total);
    } catch {
      PortfolioChart.render(chartEl, [], 0);
    }
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

  // ── Existing dashboard sections ─────────────────────────────────

  private renderFromStore(): void {
    const isAll = ExchangeStore.isAllMode();

    // Update subtitle
    const subtitle = document.getElementById('page-subtitle');
    if (subtitle) {
      subtitle.textContent = isAll
        ? 'A quick look at your accounts'
        : `A quick look at your ${ExchangeStore.getExchangeName(ExchangeStore.activeMode as number)} account`;
    }

    if (ExchangeStore.error) {
      this.setCardValue('open-orders-count', '--');
    } else {
      this.setCardValue('open-orders-count', ExchangeStore.openOrders.length.toString());
      const ordersChart = document.getElementById('overview-orders-chart');
      if (ordersChart) OrderFlow.render(ordersChart, ExchangeStore.openOrders);
    }
  }

  private async loadCommandsCount(): Promise<void> {
    try {
      const rules = await AutomationController.getRules();
      const isAll = ExchangeStore.isAllMode();
      const activeId = ExchangeStore.activeMode;
      const filteredRules = isAll
        ? rules
        : rules.filter((r: any) => r.trigger_exchange_id === activeId);
      this.setCardValue('custom-commands-count', filteredRules.length.toString());

      const flowChart = document.getElementById('overview-flow-chart');
      if (flowChart) RuleFlow.render(flowChart, filteredRules, { exchangeName: (id) => ExchangeStore.getExchangeName(id) });
    } catch {
      this.setCardValue('custom-commands-count', '--');
    }
  }

  private setCardValue(id: string, value: string): void {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }
}

new HomeController();

})();