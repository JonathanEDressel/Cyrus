(function () {

const LightweightCharts = (window as any).LightweightCharts;

interface ChartInstance {
  chart: any;
  series: any;
  symbol: string;
  activeRange: string;
}

class HomeController {
  private unsubscribe: (() => void) | null = null;
  private charts: Map<string, ChartInstance> = new Map();
  private allPairs: any[] = [];
  private tickerTimer: ReturnType<typeof setInterval> | null = null;
  private chartTimer: ReturnType<typeof setInterval> | null = null;
  private draggedSymbol: string | null = null;

  constructor() {
    this.init();
  }

  private init(): void {
    this.initCollapsibleSections();
    this.attachEventListeners();
    this.loadDashboardData();

    this.unsubscribe = ExchangeStore.onUpdate(() => this.renderFromStore());

    this.tickerTimer = setInterval(() => this.refreshAllTickers(), 5_000);
    this.chartTimer = setInterval(() => this.refreshAllChartData(), 60_000);

    const observer = new MutationObserver(() => {
      if (!document.getElementById('orders-tbody')) {
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
    document.getElementById('view-all-positions')?.addEventListener('click', () => {
      router.navigate('positions');
    });
    document.getElementById('view-all-orders')?.addEventListener('click', () => {
      router.navigate('openorders');
    });
    document.getElementById('view-all-commands')?.addEventListener('click', () => {
      router.navigate('commands');
    });
    document.getElementById('view-all-commands2')?.addEventListener('click', () => {
      router.navigate('commands');
    });

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
  }

  private loadDashboardData(): void {
    this.setCardValue('total-balance', '$0.00');
    this.setCardValue('open-positions-count', '0');
    this.setCardValue('custom-commands-count', '0');

    this.setTableEmpty('positions-tbody', 6, 'No open positions');

    this.renderFromStore();
    this.loadCommands();
    this.loadLogs();
    this.loadWatchlist();
  }

  // ── Live Data / Charts ──────────────────────────────────────────

  private async loadWatchlist(): Promise<void> {
    try {
      const token = AuthController.getToken();
      if (!token) return;
      const resp = await WatchlistData.getWatchlist(token);
      const items: any[] = resp.data || [];
      if (items.length === 0) {
        this.showEmptyState();
        return;
      }
      this.hideEmptyState();
      for (const item of items) {
        await this.renderChartCard(item.symbol);
      }
    } catch {
      // silently fail — empty state shows
    }
  }

  private async renderChartCard(symbol: string): Promise<void> {
    if (this.charts.has(symbol)) return;

    this.hideEmptyState();
    const container = document.getElementById('live-data-charts');
    if (!container) return;

    const cardId = this.symbolToId(symbol);
    const savedRange = localStorage.getItem(`chart-range-${symbol}`) || '1D';

    const card = document.createElement('div');
    card.className = 'chart-card';
    card.id = `chart-card-${cardId}`;
    card.draggable = true;
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

    // Drag-and-drop handlers
    card.addEventListener('dragstart', (e) => {
      this.draggedSymbol = symbol;
      card.classList.add('dragging');
      e.dataTransfer!.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      this.draggedSymbol = null;
      card.classList.remove('dragging');
      container.querySelectorAll('.chart-card.drag-over').forEach(el => el.classList.remove('drag-over'));
    });
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      if (this.draggedSymbol && this.draggedSymbol !== symbol) {
        card.classList.add('drag-over');
      }
    });
    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
    });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      if (!this.draggedSymbol || this.draggedSymbol === symbol) return;
      const draggedId = this.symbolToId(this.draggedSymbol);
      const draggedCard = document.getElementById(`chart-card-${draggedId}`);
      if (!draggedCard) return;
      // Insert dragged card before this card
      container.insertBefore(draggedCard, card);
      this.persistOrder();
    });

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

    const isDark = document.body.classList.contains('theme-light') ? false : true;
    const chart = LightweightCharts.createChart(chartEl, {
      width: chartEl.clientWidth,
      height: 250,
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: isDark ? '#94a3b8' : '#475569',
      },
      grid: {
        vertLines: { color: isDark ? 'rgba(148,163,184,0.06)' : 'rgba(0,0,0,0.06)' },
        horzLines: { color: isDark ? 'rgba(148,163,184,0.06)' : 'rgba(0,0,0,0.06)' },
      },
      rightPriceScale: {
        borderColor: isDark ? 'rgba(148,163,184,0.12)' : 'rgba(0,0,0,0.12)',
      },
      timeScale: {
        borderColor: isDark ? 'rgba(148,163,184,0.12)' : 'rgba(0,0,0,0.12)',
        timeVisible: true,
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
      },
      handleScroll: false,
      handleScale: false,
    });

    const series = chart.addSeries(LightweightCharts.AreaSeries, {
      topColor: 'rgba(6, 182, 212, 0.3)',
      bottomColor: 'rgba(6, 182, 212, 0.02)',
      lineColor: '#06b6d4',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 8, minMove: 0.00000001 },
    });

    this.charts.set(symbol, { chart, series, symbol, activeRange: savedRange });

    // Responsive resize
    const resizeObserver = new ResizeObserver(() => {
      if (chartEl.clientWidth > 0) {
        chart.applyOptions({ width: chartEl.clientWidth });
      }
    });
    resizeObserver.observe(chartEl);

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
    } catch {
      // chart stays empty on error
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

    const inst = this.charts.get(symbol);
    if (inst) {
      inst.chart.remove();
      this.charts.delete(symbol);
    }
    const cardId = this.symbolToId(symbol);
    document.getElementById(`chart-card-${cardId}`)?.remove();

    if (this.charts.size === 0) {
      this.showEmptyState();
    }
  }

  private async persistOrder(): Promise<void> {
    const container = document.getElementById('live-data-charts');
    if (!container) return;
    const symbols: string[] = [];
    container.querySelectorAll('.chart-card[data-symbol]').forEach((el) => {
      const sym = el.getAttribute('data-symbol');
      if (sym) symbols.push(sym);
    });
    try {
      const token = AuthController.getToken();
      if (token) {
        await WatchlistData.updateOrder(token, symbols);
      }
    } catch {
      // best-effort persist
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
    const watchedSymbols = new Set(this.charts.keys());
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
    if (this.charts.has(symbol)) return;

    try {
      const token = AuthController.getToken();
      if (token) {
        await WatchlistData.addToWatchlist(token, symbol);
      }
    } catch {
      // continue rendering even if save fails
    }

    this.hideAddCryptoModal();
    await this.renderChartCard(symbol);
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
      try { inst.chart.remove(); } catch {}
    });
    this.charts.clear();
  }

  private symbolToId(symbol: string): string {
    return symbol.replace(/[^a-zA-Z0-9]/g, '_');
  }

  // ── Existing dashboard sections ─────────────────────────────────

  private renderFromStore(): void {
    const orders = ExchangeStore.openOrders;
    const isAll = ExchangeStore.isAllMode();

    // Update subtitle
    const subtitle = document.getElementById('page-subtitle');
    if (subtitle) {
      subtitle.textContent = isAll
        ? 'Overview of your exchange accounts'
        : `Overview of your ${ExchangeStore.getExchangeName(ExchangeStore.activeMode as number)} account`;
    }

    // Update orders table header for exchange column
    const thead = document.getElementById('orders-thead');
    if (thead) {
      const cols = isAll
        ? '<tr><th>Exchange</th><th>Pair</th><th>Type</th><th>Side</th><th>Price</th><th>Volume</th><th>Status</th></tr>'
        : '<tr><th>Pair</th><th>Type</th><th>Side</th><th>Price</th><th>Volume</th><th>Status</th></tr>';
      thead.innerHTML = cols;
    }

    if (ExchangeStore.error) {
      this.setTableEmpty('orders-tbody', isAll ? 7 : 6, 'Failed to load orders');
      this.setCardValue('open-orders-count', '--');
    } else {
      this.renderOrders(orders, isAll);
      this.setCardValue('open-orders-count', orders.length.toString());
    }
  }

  private async loadLogs(): Promise<void> {
    try {
      const logs = await AutomationController.getLogs(30);
      this.renderLogs(logs);
    } catch (error: any) {
    }
  }

  private renderLogs(logs: any[]): void {
    const tbody = document.getElementById('logs-tbody');
    if (!tbody) return;

    if (logs.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No execution history yet</td></tr>';
      return;
    }

    tbody.innerHTML = logs.map((l: any) => {
      const time = l.created_at ? new Date(l.created_at.endsWith('Z') ? l.created_at : l.created_at + 'Z').toLocaleString() : '--';
      const statusClass = l.status === 'success' ? 'status-success' : 'status-error';

      return `<tr>
        <td>${this.escapeHtml(time)}</td>
        <td>${this.escapeHtml(l.trigger_event)}</td>
        <td>${this.escapeHtml(l.action_executed)}</td>
        <td class="result-cell">${this.formatActionResult(l.action_result, l.status)}</td>
        <td><span class="status-badge ${statusClass}">${this.escapeHtml(l.status)}</span></td>
      </tr>`;
    }).join('');
  }

  private renderOrders(orders: any[], isAll: boolean): void {
    const tbody = document.getElementById('orders-tbody');
    if (!tbody) return;

    const colspan = isAll ? 7 : 6;
    if (orders.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="${colspan}">No open orders</td></tr>`;
      return;
    }

    tbody.innerHTML = orders.map((o: any) => {
      const sideClass = o.side === 'buy' ? 'side-buy' : 'side-sell';
      const exchangeCol = isAll
        ? `<td><span class="exchange-badge exchange-${this.escapeHtml(o.exchangeName).toLowerCase()}">${this.escapeHtml(o.exchangeName)}</span></td>`
        : '';
      return `<tr>
        ${exchangeCol}
        <td>${this.escapeHtml(o.pair)}</td>
        <td>${this.escapeHtml(o.type)}</td>
        <td><span class="${sideClass}">${this.escapeHtml(o.side)}</span></td>
        <td>${this.escapeHtml(o.price)}</td>
        <td>${this.escapeHtml(o.volume)}</td>
        <td><span class="status-badge status-${this.escapeHtml(o.status).toLowerCase().replace(/[^a-z]/g, '')}">${this.escapeHtml(o.status)}</span></td>
      </tr>`;
    }).join('');
  }

  private async loadCommands(): Promise<void> {
    try {
      const rules = await AutomationController.getRules();
      this.renderCommands(rules);
      this.setCardValue('custom-commands-count', rules.length.toString());
    } catch {
      this.setTableEmpty('commands-tbody', 4, 'Failed to load commands');
    }
  }

  private renderCommands(rules: any[]): void {
    const tbody = document.getElementById('commands-tbody');
    if (!tbody) return;

    if (rules.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="4">No custom commands</td></tr>';
      return;
    }

    tbody.innerHTML = rules.map((r: any) => {
      const statusClass = r.is_active ? 'status-active' : 'status-inactive';
      const statusText = r.is_active ? 'Active' : 'Paused';
      const trigger = this.formatTrigger(r);
      const action = this.formatAction(r);

      return `<tr>
        <td>${this.escapeHtml(r.rule_name)}</td>
        <td>${trigger}</td>
        <td>${action}</td>
        <td><span class="status-badge ${statusClass}">${statusText}</span></td>
      </tr>`;
    }).join('');
  }

  private formatTrigger(rule: any): string {
    if (rule.trigger_type === 'order_filled') {
      const orderId = rule.trigger_order_id
        ? this.escapeHtml(rule.trigger_order_id.substring(0, 10)) + '...'
        : 'Any';
      return `<span class="trigger-badge">Order Filled</span> <span class="mono-text">${orderId}</span>`;
    }
    if (rule.trigger_type === 'balance_threshold') {
      const asset = rule.trigger_asset || '';
      const threshold = rule.trigger_threshold || '0';
      const cooldown = this.formatCooldown(rule.cooldown_minutes || 1440);
      return `<span class="trigger-badge trigger-badge-balance">Balance ≥</span> `
        + `<strong>${this.escapeHtml(threshold)}</strong> `
        + `<span class="asset-badge">${this.escapeHtml(asset)}</span>`
        + `<br><span class="cooldown-text">Cooldown: ${cooldown}</span>`;
    }
    return this.escapeHtml(rule.trigger_type);
  }

  private formatAction(rule: any): string {
    if (rule.action_type === 'withdraw_crypto') {
      let amountText: string;
      if (rule.trigger_type === 'balance_threshold') {
        amountText = '<em>Full Balance</em>';
      } else if (rule.use_filled_amount) {
        amountText = '<em>Filled Amount</em>';
      } else {
        amountText = `<strong>${this.escapeHtml(rule.action_amount)}</strong>`;
      }
      return `Withdraw ${amountText} `
        + `<span class="asset-badge">${this.escapeHtml(rule.action_asset)}</span> `
        + `→ ${this.escapeHtml(rule.action_address_key)}`;
    }
    if (rule.action_type === 'convert_crypto') {
      const convertAmountText = rule.action_amount
        ? `<strong>${this.escapeHtml(rule.action_amount)}</strong>`
        : '<em>Full Balance</em>';
      return `Convert ${convertAmountText} `
        + `<span class="asset-badge">${this.escapeHtml(rule.action_asset)}</span> `
        + `→ <span class="asset-badge">${this.escapeHtml(rule.convert_to_asset || '?')}</span>`;
    }
    return this.escapeHtml(rule.action_type);
  }

  private formatCooldown(minutes: number): string {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours > 0 && mins > 0) return `${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h`;
    return `${mins}m`;
  }

  private setCardValue(id: string, value: string): void {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  private setTableEmpty(tbodyId: string, colspan: number, message: string): void {
    const tbody = document.getElementById(tbodyId);
    if (tbody) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="${colspan}">${message}</td></tr>`;
    }
  }

  private formatActionResult(raw: string, status: string): string {
    if (!raw) return '--';

    // Error/skipped messages are already readable text
    if (status !== 'success' || !raw.startsWith('{')) {
      return this.escapeHtml(raw);
    }

    const parts: string[] = [];
    const isOrder = /'symbol'\s*:/.test(raw);

    if (isOrder) {
      const symbol = this.extractField(raw, 'symbol');
      const side = this.extractField(raw, 'side');
      const filled = this.extractField(raw, 'filled');
      const average = this.extractField(raw, 'average');
      const cost = this.extractField(raw, 'cost');
      const st = this.extractField(raw, 'status');

      if (side && symbol) parts.push(`${side.toUpperCase()} ${symbol}`);
      if (filled) parts.push(`Filled: ${filled}`);
      if (average && average !== 'None') parts.push(`Avg Price: ${average}`);
      if (cost) parts.push(`Cost: ${cost}`);
      if (st) parts.push(`Status: ${st}`);
    } else {
      const id = this.extractField(raw, 'id');
      const amount = this.extractField(raw, 'amount');
      const currency = this.extractField(raw, 'currency');
      const st = this.extractField(raw, 'status');

      if (amount && currency) parts.push(`${amount} ${currency}`);
      if (id) parts.push(`Ref: ${id}`);
      if (st) parts.push(`Status: ${st}`);
    }

    // Extract fee from top-level 'fee' dict
    const feeMatch = raw.match(/'fee'\s*:\s*\{([^}]*)\}/);
    if (feeMatch) {
      const feeStr = feeMatch[1];
      const feeCost = feeStr.match(/'cost'\s*:\s*([\d.]+)/);
      const feeCurrency = feeStr.match(/'currency'\s*:\s*'([^']*)'/);
      if (feeCost && feeCurrency) parts.push(`Fee: ${feeCost[1]} ${feeCurrency[1]}`);
    }

    return this.escapeHtml(parts.length > 0 ? parts.join(' | ') : raw);
  }

  private extractField(raw: string, field: string): string | null {
    const strMatch = raw.match(new RegExp(`'${field}'\\s*:\\s*'([^']*)'`));
    if (strMatch) return strMatch[1];
    const numMatch = raw.match(new RegExp(`'${field}'\\s*:\\s*([\\d.]+)`));
    if (numMatch) return numMatch[1];
    return null;
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }
}

new HomeController();

})();