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

    this.unsubscribe = ExchangeStore.onUpdate(() => {
      this.renderFromStore();
      this.loadCommandsCount();
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
  }

  private loadDashboardData(): void {
    this.setCardValue('custom-commands-count', '0');

    this.renderFromStore();
    this.loadCommandsCount();
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