(function () {

/** One row of the table — a limit order as ExchangeStore hands it over. */
interface LimitOrder {
  id: string;
  pair: string;
  type: string;
  side: string;
  price: string;
  volume: string;
  filled: string;
  status: string;
  opentm: number;
  connectionId: number;
  exchangeName: string;
  /** Kraken routes some pairs instead of listing them (LUNA/USDT, XDC/USDT) and
   *  its cancel endpoint can't resolve them. Set by the backend. */
  synthetic?: boolean;
}

/** Every column the table can be ordered by. */
type SortKey = 'exchange' | 'pair' | 'price' | 'volume' | 'filled' | 'total' | 'opened' | 'id';

type LimitMode = 'single' | 'ladder';
/** How the ladder's price band is expressed. */
type BandMode = 'percent' | 'price';
type LegStatus = 'queued' | 'placing' | 'placed' | 'failed' | 'skipped';

/** A market's grid, normalised from the backend's PairMeta. */
interface LegMarket {
  symbol: string;
  base: string;
  quote: string;
  priceTick: number;
  amountTick: number;
  priceDecimals: number;
  amountDecimals: number;
  minAmount: number;
  minCost: number;
  price: number;
  availableBase: number;
  availableQuote: number;
}

/** One rung of the ladder (or the single order). */
interface LimitLeg {
  /** Immutable identity. Deliberately NOT the display index: renumbering after a
   *  remove would invalidate the data-leg of every input the user might be in. */
  id: string;
  /** Which slice of the band this leg draws from — survives a regeneration. */
  slice: number;
  pair: string;
  price: number | null;
  amount: number | null;
  /** Hand-edited legs are marked so a Regenerate doesn't look destructive. */
  edited: boolean;
  status: LegStatus;
  orderId: string | null;
  error: string | null;
}

interface Batch {
  connId: number;
  exchangeName: string;
  side: 'buy' | 'sell';
  base: string;
  legs: LimitLeg[];
  cancelRequested: boolean;
  running: boolean;
  placed: number;
  failed: number;
}

class LimitOrdersController {
  private static readonly MAX_STEPS = 250;
  private static readonly MIN_OFFSET_PCT = 0.05;
  private static readonly MAX_OFFSET_PCT = 3000000;
  /** Per-placement round-trip cost, on top of the exchange's own pacing. */
  private static readonly PLACE_OVERHEAD_MS = 350;
  /** Never hammer faster than this even if the exchange claims it's fine. */
  private static readonly MIN_PACE_MS = 250;
  /**
   * Buys spend slightly more than price x amount, because the exchange debits
   * the quote asset PLUS the fee. Sizing a ladder at exactly 100% of the quote
   * balance therefore gets rejected for insufficient funds on the last rungs, so
   * the buy budget keeps a little back. Sells don't need this — the fee comes out
   * of the proceeds, not the amount sold.
   */
  private static readonly BUY_FEE_HEADROOM = 0.995;

  private unsubscribe: (() => void) | null = null;
  private side: 'buy' | 'sell' = 'buy';
  /** The order the confirm modal is currently asking about. */
  private pending: LimitOrder | null = null;
  private cancelling = false;
  private escHandler: ((e: KeyboardEvent) => void) | null = null;
  private beforeUnload: ((e: BeforeUnloadEvent) => void) | null = null;
  /** Set when the router replaces the view, so a running batch stops. */
  private torndown = false;

  // Filter + sort state. Held on the instance so a background poll re-render
  // keeps whatever the user has narrowed the table down to.
  private filterText = '';
  private filterExchange = '';
  private sortKey: SortKey = 'opened';
  private sortDir: 'asc' | 'desc' = 'desc';

  // ── Wizard state ────────────────────────────────────────────────────────
  private step: 1 | 2 | 3 = 1;
  private mode: LimitMode = 'ladder';
  private wizardSide: 'buy' | 'sell' = 'buy';
  private wizardConnId: number | null = null;
  private base = '';
  private selectedQuotes: string[] = [];
  private stepCount = 8;
  private bandMode: BandMode = 'percent';
  private startPct = 1;
  private endPct = 10;
  /** Absolute band ends, used when bandMode === 'price'. "start" is the end
   *  NEAREST the market, so for a buy it is numerically the higher of the two. */
  private startPrice: number | null = null;
  private endPrice: number | null = null;
  private totalPct = 25;
  private singlePrice: number | null = null;
  private singleAmount: number | null = null;
  private postOnly = true;

  /** symbol -> market grid for the currently selected coin/exchange. */
  private markets: Record<string, LegMarket> = {};
  private pacingMs = 1000;
  private supportsPostOnly = false;

  private legs: LimitLeg[] = [];
  private legSeq = 0;
  private submitting = false;
  private batch: Batch | null = null;

  constructor() {
    this.init();
  }

  private init(): void {
    this.bindSideTabs();
    this.bindFilters();
    this.bindSorting();
    this.bindModal();
    this.bindWizard();
    this.render();

    // The wizard markup ships in the view, so every data-help is in the DOM
    // from first paint. HelpTooltip.init() is idempotent per element.
    try { HelpTooltip.init(); } catch {}

    this.unsubscribe = ExchangeStore.onUpdate(() => this.render());

    // The router swaps #app-content wholesale, so the store subscription and
    // the document-level key handler have to be torn down when the table goes.
    const observer = new MutationObserver(() => {
      if (!document.getElementById('limit-orders-table')) {
        this.teardown();
        observer.disconnect();
      }
    });
    const content = document.getElementById('app-content');
    if (content) observer.observe(content, { childList: true });
  }

  private teardown(): void {
    // Flag first: a running placement loop checks this between rungs, so a long
    // ladder can't keep a dead controller alive for minutes after navigation.
    this.torndown = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.escHandler) {
      document.removeEventListener('keydown', this.escHandler);
      this.escHandler = null;
    }
    this.disarmUnloadGuard();
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  /** Limit orders only — market/stop orders belong to the Open Orders page. */
  private allLimitOrders(): LimitOrder[] {
    return (ExchangeStore.openOrders as LimitOrder[]).filter(o =>
      (o.type || '').toLowerCase().includes('limit')
    );
  }

  private ordersForSide(side: 'buy' | 'sell'): LimitOrder[] {
    return this.allLimitOrders().filter(o => (o.side || '').toLowerCase() === side);
  }

  private isFiltering(): boolean {
    return this.filterText.trim() !== '' || this.filterExchange !== '';
  }

  /** Free-text matches pair or order id; the dropdown pins one exchange. */
  private matchesFilter(o: LimitOrder): boolean {
    if (this.filterExchange && o.exchangeName !== this.filterExchange) return false;
    const q = this.filterText.trim().toLowerCase();
    if (!q) return true;
    return (o.pair || '').toLowerCase().includes(q)
        || (o.id || '').toLowerCase().includes(q);
  }

  private filteredForSide(side: 'buy' | 'sell'): LimitOrder[] {
    return this.ordersForSide(side).filter(o => this.matchesFilter(o));
  }

  /** The rows actually shown: current side, filtered, then sorted. */
  private visibleOrders(): LimitOrder[] {
    return this.sortOrders(this.filteredForSide(this.side));
  }

  private sortValue(o: LimitOrder, key: SortKey): number | string {
    switch (key) {
      case 'price':    return this.toNumber(o.price);
      case 'volume':   return this.toNumber(o.volume);
      case 'filled':   return this.toNumber(o.filled);
      case 'total':    return this.toNumber(o.price) * this.toNumber(o.volume);
      case 'opened':   return o.opentm || 0;
      case 'exchange': return (o.exchangeName || '').toLowerCase();
      case 'id':       return (o.id || '').toLowerCase();
      case 'pair':
      default:         return (o.pair || '').toLowerCase();
    }
  }

  private sortOrders(orders: LimitOrder[]): LimitOrder[] {
    const dir = this.sortDir === 'asc' ? 1 : -1;
    // Copy before sorting — sort() mutates, and these arrays trace back to the
    // store's own openOrders in the un-filtered case.
    return [...orders].sort((a, b) => {
      const av = this.sortValue(a, this.sortKey);
      const bv = this.sortValue(b, this.sortKey);
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }

  /** Numbers and dates read best largest-first; names read best A-Z. */
  private defaultDirFor(key: SortKey): 'asc' | 'desc' {
    return key === 'pair' || key === 'id' || key === 'exchange' ? 'asc' : 'desc';
  }

  /**
   * Whether the store actually has an answer yet. Without this an empty
   * openOrders on first paint reads as "you have no limit orders" when the
   * first fetch simply hasn't come back — or hasn't been started at all,
   * which is the case until an exchange is connected.
   */
  private loadState(): 'no-connection' | 'loading' | 'ready' {
    if (ExchangeStore.activeMode === null) return 'no-connection';
    if (ExchangeStore.lastUpdated === null && !ExchangeStore.error) return 'loading';
    return 'ready';
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  private bindSideTabs(): void {
    document.getElementById('limit-side-tabs')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.rules-tab-btn') as HTMLElement | null;
      if (!btn) return;
      const side = btn.getAttribute('data-side') as 'buy' | 'sell' | null;
      if (!side || side === this.side) return;
      this.side = side;
      document.querySelectorAll('#limit-side-tabs .rules-tab-btn')
        .forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      this.render();
    });
  }

  private bindFilters(): void {
    const input = document.getElementById('limit-filter-input') as HTMLInputElement | null;
    input?.addEventListener('input', () => {
      this.filterText = input.value;
      this.render();
    });

    document.getElementById('limit-filter-clear')?.addEventListener('click', () => {
      this.filterText = '';
      if (input) {
        input.value = '';
        input.focus();
      }
      this.render();
    });

    const select = document.getElementById('limit-filter-exchange') as HTMLSelectElement | null;
    select?.addEventListener('change', () => {
      this.filterExchange = select.value;
      this.render();
    });
  }

  private bindSorting(): void {
    // Delegated on the thead element, which survives its innerHTML being
    // rebuilt on every render.
    document.getElementById('limit-thead')?.addEventListener('click', (e) => {
      const th = (e.target as HTMLElement).closest('th.sortable') as HTMLElement | null;
      if (!th) return;
      const key = th.getAttribute('data-sort') as SortKey | null;
      if (!key) return;
      if (this.sortKey === key) {
        this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        this.sortKey = key;
        this.sortDir = this.defaultDirFor(key);
      }
      this.render();
    });
  }

  private render(): void {
    const isAll = ExchangeStore.isAllMode();
    const error = ExchangeStore.error;
    const lastUpdated = ExchangeStore.lastUpdated;

    const subtitle = document.getElementById('limit-page-subtitle');
    if (subtitle) {
      // Name the exchange only in single-connection mode — 'all' needs no
      // qualifier, and a null mode (nothing connected yet) would resolve to
      // the literal "Unknown".
      const mode = ExchangeStore.activeMode;
      const label = typeof mode === 'number' ? ` on ${ExchangeStore.getExchangeName(mode)}` : '';
      const refreshSpan = document.getElementById('limit-refresh-label');
      const refreshHtml = refreshSpan ? refreshSpan.outerHTML : '';
      subtitle.innerHTML = `Your resting limit orders${this.escapeHtml(label)} ${refreshHtml}`;
    }

    // Runs before the rows are computed: it can clear a stale exchange filter.
    this.renderToolbar(isAll);
    this.renderHead(isAll);
    this.updateTabCounts();

    if (error) {
      this.showError(error);
      this.setRefreshLabel('');
    } else {
      this.hideError();
      if (lastUpdated) this.setRefreshLabel(`Last updated: ${lastUpdated.toLocaleTimeString()}`);
    }

    const orders = this.visibleOrders();
    this.renderRows(orders, isAll);
    this.updateCountTitle(orders.length);
    this.renderFilterMeta(orders.length);
    // Idempotent and DOM-only — safe to run on every store update. The legs and
    // progress tables are deliberately NOT touched here: a background poll must
    // never rebuild a table the user is typing into.
    this.syncCreateButton();
  }

  private renderToolbar(isAll: boolean): void {
    document.getElementById('limit-filter-clear')
      ?.classList.toggle('d-none', this.filterText.trim() === '');

    const select = document.getElementById('limit-filter-exchange') as HTMLSelectElement | null;
    if (!select) return;

    select.classList.toggle('d-none', !isAll);
    if (!isAll) {
      // Switching to a single connection makes an exchange filter meaningless —
      // leaving it set would silently hide every row.
      if (this.filterExchange) {
        this.filterExchange = '';
        select.value = '';
      }
      return;
    }
    this.syncExchangeOptions(select);
  }

  /** Keep the dropdown's options in step with the exchanges actually present. */
  private syncExchangeOptions(select: HTMLSelectElement): void {
    const names = Array.from(
      new Set(this.allLimitOrders().map(o => o.exchangeName).filter(Boolean))
    ).sort();

    // Rebuilding the list on every 4-minute poll would drop the user's
    // selection mid-read, so only touch it when the set really changed.
    const existing = Array.from(select.options).slice(1).map(o => o.value);
    const unchanged = existing.length === names.length
      && existing.every((v, i) => v === names[i]);
    if (unchanged) return;

    const current = select.value;
    // Built via the DOM rather than innerHTML so a label's quotes or angle
    // brackets stay data instead of markup.
    select.innerHTML = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'All exchanges';
    select.appendChild(all);
    for (const name of names) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    }
    select.value = names.includes(current) ? current : '';
    this.filterExchange = select.value;
  }

  private renderHead(isAll: boolean): void {
    const thead = document.getElementById('limit-thead');
    if (!thead) return;
    const cols = [
      ...(isAll ? [this.sortableTh('exchange', 'Exchange')] : []),
      this.sortableTh('pair', 'Pair'),
      this.sortableTh('price', 'Limit Price'),
      this.sortableTh('volume', 'Volume'),
      this.sortableTh('filled', 'Filled'),
      this.sortableTh('total', 'Est. Total'),
      this.sortableTh('opened', 'Opened'),
      this.sortableTh('id', 'Order ID'),
      '<th class="limit-actions-col">Action</th>',
    ];
    thead.innerHTML = `<tr>${cols.join('')}</tr>`;
  }

  private sortableTh(key: SortKey, label: string): string {
    const active = this.sortKey === key;
    const icon = active
      ? (this.sortDir === 'asc' ? 'fa-sort-up' : 'fa-sort-down')
      : 'fa-sort';
    const ariaSort = active ? (this.sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th class="sortable${active ? ' sorted' : ''}" data-sort="${key}"`
      + ` aria-sort="${ariaSort}" title="Sort by ${this.escapeHtml(label)}">`
      + `${this.escapeHtml(label)} <i class="sort-icon fa-solid ${icon}"></i></th>`;
  }

  private renderFilterMeta(shown: number): void {
    const el = document.getElementById('limit-filter-meta');
    if (!el) return;
    if (!this.isFiltering()) {
      el.textContent = '';
      return;
    }
    const total = this.ordersForSide(this.side).length;
    el.textContent = `Showing ${shown} of ${total}`;
  }

  private renderRows(orders: LimitOrder[], isAll: boolean): void {
    const tbody = document.getElementById('limit-tbody');
    if (!tbody) return;

    const colspan = isAll ? 9 : 8;
    if (orders.length === 0) {
      const state = this.loadState();
      const message = state === 'no-connection'
        ? 'Connect an exchange in your profile to see your limit orders.'
        : state === 'loading'
          ? 'Loading orders...'
          : this.isFiltering()
            ? `No ${this.side} limit orders match your filter`
            : `No open ${this.side} limit orders`;
      // Offer a way in from the empty state, but only when there's genuinely
      // nothing there — not when a filter is hiding everything.
      const cta = state === 'ready' && !this.isFiltering()
        ? ` <button class="btn-link-sm limit-empty-cta" id="limit-empty-create">Create one</button>`
        : '';
      tbody.innerHTML = `<tr class="empty-row"><td colspan="${colspan}">${message}${cta}</td></tr>`;
      // The tbody is rebuilt every render, so this binds per render rather than
      // once — cheap, and it can't accumulate because the node is replaced.
      document.getElementById('limit-empty-create')
        ?.addEventListener('click', () => void this.openCreateModal());
      return;
    }

    tbody.innerHTML = orders.map((o) => {
      const exchangeCol = isAll
        ? `<td><span class="exchange-badge exchange-${this.escapeAttr(o.exchangeName).toLowerCase()}">${this.escapeHtml(o.exchangeName)}</span></td>`
        : '';
      const partial = this.filledFraction(o) > 0;
      return `<tr>
        ${exchangeCol}
        <td class="limit-pair-cell">${this.escapeHtml(o.pair)}${o.synthetic
          ? ' <span class="limit-synthetic-tag" title="Kraken routes this pair rather than listing it. Kraken&#39;s API cannot cancel these orders — use Kraken&#39;s own site or app.">synthetic</span>'
          : ''}</td>
        <td>${this.escapeHtml(this.formatPrice(o))}</td>
        <td>${this.escapeHtml(o.volume)}</td>
        <td>${this.escapeHtml(o.filled)}${partial ? ' <span class="limit-partial-tag">partial</span>' : ''}</td>
        <td>${this.escapeHtml(this.formatTotal(o))}</td>
        <td>${this.escapeHtml(this.formatOpened(o))}</td>
        <td class="order-id-cell" title="${this.escapeAttr(o.id)}">${this.escapeHtml(o.id)}</td>
        <td class="limit-actions-col">
          <button class="btn-cancel-order" data-order-id="${this.escapeAttr(o.id)}" data-conn-id="${o.connectionId}">
            <i class="fa-solid fa-ban"></i> Cancel
          </button>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('.btn-cancel-order').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-order-id') || '';
        const connId = parseInt(btn.getAttribute('data-conn-id') || '', 10);
        // Look the order up again rather than trusting the row's markup, so the
        // modal always describes the order the store currently holds.
        const order = this.allLimitOrders().find(o => o.id === id && o.connectionId === connId);
        if (order) this.openModal(order);
      });
    });
  }

  /** Counts honour the filter, so switching sides shows what the badge promised. */
  private updateTabCounts(): void {
    const buy = document.getElementById('buy-tab-count');
    const sell = document.getElementById('sell-tab-count');
    if (buy) buy.textContent = String(this.filteredForSide('buy').length);
    if (sell) sell.textContent = String(this.filteredForSide('sell').length);
  }

  private updateCountTitle(count: number): void {
    const el = document.getElementById('limit-count-title');
    if (el) el.textContent = `${this.side === 'buy' ? 'Buy' : 'Sell'} Limit Orders (${count})`;
  }

  // ---------------------------------------------------------------------------
  // Confirm modal
  // ---------------------------------------------------------------------------

  private bindModal(): void {
    document.getElementById('cancel-order-close')?.addEventListener('click', () => this.closeModal());
    document.getElementById('cancel-order-dismiss')?.addEventListener('click', () => this.closeModal());
    document.getElementById('cancel-order-confirm')?.addEventListener('click', () => this.confirmCancel());

    document.getElementById('cancel-order-overlay')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'cancel-order-overlay') this.closeModal();
    });

    // One document-level handler for BOTH overlays, topmost first. A second
    // listener would leak one handler per navigation, since teardown() only
    // removes the one it knows about.
    this.escHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const create = document.getElementById('create-limit-overlay');
      if (create && !create.classList.contains('d-none')) {
        this.closeCreateModal();
        return;
      }
      const overlay = document.getElementById('cancel-order-overlay');
      if (overlay && !overlay.classList.contains('d-none')) this.closeModal();
    };
    document.addEventListener('keydown', this.escHandler);
  }

  private openModal(order: LimitOrder): void {
    this.pending = order;
    this.hideModalError();

    const set = (id: string, value: string) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };

    const sideEl = document.getElementById('cancel-order-side');
    if (sideEl) {
      const side = (order.side || '').toLowerCase();
      sideEl.textContent = side.toUpperCase();
      sideEl.className = `cancel-order-side ${side === 'buy' ? 'side-buy' : 'side-sell'}`;
    }

    set('cancel-order-pair', order.pair || '--');
    set('cancel-order-type', this.formatType(order));
    set('cancel-order-price', this.formatPrice(order));
    set('cancel-order-volume', `${order.volume} ${this.baseAsset(order)}`.trim());
    set('cancel-order-filled', `${order.filled} ${this.baseAsset(order)}`.trim());
    set('cancel-order-total', this.formatTotal(order));
    set('cancel-order-opened', this.formatOpened(order));
    set('cancel-order-id', order.id || '--');
    set('cancel-order-exchange', order.exchangeName || '--');

    // The exchange name is only worth a row when several are in play.
    document.getElementById('cancel-order-exchange-row')
      ?.classList.toggle('d-none', !ExchangeStore.isAllMode());

    document.getElementById('cancel-order-partial-warning')
      ?.classList.toggle('d-none', this.filledFraction(order) <= 0);

    // Say up front that Kraken can't cancel these, rather than after a failure.
    document.getElementById('cancel-order-synthetic-warning')
      ?.classList.toggle('d-none', !order.synthetic);

    document.getElementById('cancel-order-overlay')?.classList.remove('d-none');
    (document.getElementById('cancel-order-dismiss') as HTMLButtonElement | null)?.focus();
  }

  private closeModal(): void {
    // Never yank the dialog out from under an in-flight cancel — the result
    // still has to be reported somewhere.
    if (this.cancelling) return;
    this.pending = null;
    this.hideModalError();
    document.getElementById('cancel-order-overlay')?.classList.add('d-none');
  }

  private async confirmCancel(): Promise<void> {
    const order = this.pending;
    if (!order || this.cancelling) return;

    const confirmBtn = document.getElementById('cancel-order-confirm') as HTMLButtonElement | null;
    const dismissBtn = document.getElementById('cancel-order-dismiss') as HTMLButtonElement | null;
    const original = confirmBtn?.innerHTML ?? '';

    this.cancelling = true;
    this.hideModalError();
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Cancelling...';
    }
    if (dismissBtn) dismissBtn.disabled = true;

    try {
      const result = await ExchangeController.cancelOrder(order.connectionId, order.id, order.pair);

      // Other pages share the store's order cache, so drop this connection's
      // entry before refetching or they'd keep showing the cancelled order.
      ExchangeStore.invalidateConnectionData(order.connectionId);

      this.cancelling = false;
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = original;
      }
      if (dismissBtn) dismissBtn.disabled = false;
      this.closeModal();

      // Some exchanges (Robinhood) only acknowledge the request and cancel
      // asynchronously, so the order can still be in the refresh below. Say
      // that rather than claiming it's gone.
      const pending = String(result?.status || '').toLowerCase() === 'canceling';
      this.showSuccess(pending
        ? `Cancellation submitted for ${order.volume} ${order.pair} on ${order.exchangeName}. It may take a moment to clear.`
        : `Cancelled ${order.side} limit order for ${order.volume} ${order.pair}.`);
      await ExchangeStore.refreshOrders();
    } catch (err: any) {
      this.cancelling = false;
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = original;
      }
      if (dismissBtn) dismissBtn.disabled = false;
      this.showModalError(err?.message || 'Failed to cancel the order. Please try again.');
    }
  }

  // ---------------------------------------------------------------------------
  // Create wizard — precision
  // ---------------------------------------------------------------------------

  /**
   * Decimal places implied by a tick size (1e-8 -> 8, 0.1 -> 1, 0.05 -> 2).
   *
   * Uses String(), which gives the shortest round-tripping representation, and
   * handles the exponent form it produces below 1e-6. Do NOT reach for
   * toFixed(18) here: it exposes the binary representation error instead of
   * hiding it — (0.1).toFixed(18) is "0.100000000000000006", which reports 18
   * decimals for a one-decimal tick and leaves float noise in every price.
   */
  private decimalsFromTick(tick: number): number {
    if (!Number.isFinite(tick) || tick <= 0) return 8;   // unknown -> be generous
    if (Number.isInteger(tick)) return 0;                // whole-unit tick (SHIB amounts)
    const text = String(tick);
    const exponent = text.match(/e-(\d+)$/);
    if (exponent) {
      // "1e-8" -> 8; "2.5e-7" -> 7 + 1 mantissa decimal = 8.
      const mantissaDecimals = (text.split('e')[0].split('.')[1] || '').length;
      return Math.min(18, parseInt(exponent[1], 10) + mantissaDecimals);
    }
    return Math.min(18, (text.split('.')[1] || '').length);
  }

  /** Snap to the exchange's grid without float drift. */
  private roundToTick(value: number, tick: number, mode: 'floor' | 'round' | 'ceil'): number {
    if (!(tick > 0)) return value;
    const units = value / tick;
    const n = mode === 'floor' ? Math.floor(units + 1e-9)
            : mode === 'ceil' ? Math.ceil(units - 1e-9)
            : Math.round(units);
    return Number((n * tick).toFixed(this.decimalsFromTick(tick)));
  }

  private isOnTick(value: number, tick: number): boolean {
    if (!(tick > 0)) return true;
    const units = value / tick;
    return Math.abs(units - Math.round(units)) < 1e-6;
  }

  /**
   * Plain fixed-point, trailing zeros trimmed.
   *
   * Never toLocaleString here: a thousands separator written back into an
   * <input type=number> blanks the field.
   */
  private fmtNum(value: number, decimals: number): string {
    const s = value.toFixed(Math.min(20, Math.max(0, decimals)));
    return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  }

  /** Read-only cells only — grouping separators are fine there. */
  private fmtMoney(value: number, quote: string): string {
    const dp = /^(USD|EUR|GBP|USDT|USDC|DAI|TUSD|PYUSD|FDUSD|BUSD|USDD|USDG|ZUSD)$/.test(quote) ? 2 : 6;
    return `${value.toLocaleString(undefined, {
      minimumFractionDigits: dp, maximumFractionDigits: dp,
    })} ${quote}`;
  }

  /** Float-safe "over the cap", so an exact 100% split doesn't read as over. */
  private exceeds(need: number, have: number): boolean {
    return need - have > Math.max(have, 1) * 1e-9;
  }

  // ---------------------------------------------------------------------------
  // Create wizard — data
  // ---------------------------------------------------------------------------

  private marketFor(pair: string): LegMarket | undefined {
    return this.markets[pair];
  }

  private available(asset: string): number {
    // Balances ride along with the pair metadata, because they must be the
    // exchange's FREE figure — ExchangeController.getBalance() returns `total`,
    // which counts funds already locked in resting orders.
    for (const market of Object.values(this.markets)) {
      if (market.base === asset) return market.availableBase;
      if (market.quote === asset) return market.availableQuote;
    }
    return 0;
  }

  private normalizeMarket(raw: PairMeta): LegMarket {
    const priceTick = Number(raw.price_tick) || 0;
    const amountTick = Number(raw.amount_tick) || 0;
    return {
      symbol: String(raw.symbol),
      base: String(raw.base),
      quote: String(raw.quote),
      priceTick,
      amountTick,
      // Trust the backend where it resolved the convention for us — a bare tick
      // of `8` is ambiguous on the wire (eight units, or eight decimals?).
      priceDecimals: Number.isInteger(raw.price_decimals as number)
        ? (raw.price_decimals as number) : this.decimalsFromTick(priceTick),
      amountDecimals: Number.isInteger(raw.amount_decimals as number)
        ? (raw.amount_decimals as number) : this.decimalsFromTick(amountTick),
      minAmount: Number(raw.min_amount) || 0,
      minCost: Number(raw.min_cost) || 0,
      price: Number(raw.price) || 0,
      availableBase: Number(raw.available_base) || 0,
      availableQuote: Number(raw.available_quote) || 0,
    };
  }

  /**
   * Load the pair grid for one coin on one connection.
   *
   * Never cached client-side: the response carries live prices and FREE balances
   * alongside the tick sizes, and both change as soon as an order rests. The
   * backend caches the static metadata half, so this is cheaper than it looks.
   */
  private async loadPairs(connId: number, asset: string): Promise<void> {
    const res = await ExchangeController.getPairs(connId, asset, this.wizardSide);
    // Switching exchange or coin mid-fetch: drop a late response, or one
    // exchange's tick sizes get applied to another's markets.
    if (this.wizardConnId !== connId || this.base !== asset) return;

    const markets: Record<string, LegMarket> = {};
    for (const raw of res?.pairs || []) {
      const market = this.normalizeMarket(raw);
      markets[market.symbol] = market;
    }
    this.markets = markets;
    this.pacingMs = Number(res?.order_pacing_ms) || 1000;
    this.supportsPostOnly = res?.supports_post_only === true;
  }

  // ---------------------------------------------------------------------------
  // Create wizard — open / close / steps
  // ---------------------------------------------------------------------------

  private bindWizard(): void {
    document.getElementById('limit-new-order-btn')
      ?.addEventListener('click', () => void this.openCreateModal());
    document.getElementById('limit-wizard-close')
      ?.addEventListener('click', () => this.closeCreateModal());
    document.getElementById('limit-wizard-next')
      ?.addEventListener('click', () => void this.wizardNext());
    document.getElementById('limit-wizard-back')
      ?.addEventListener('click', () => this.wizardBack());
    document.getElementById('limit-submit')
      ?.addEventListener('click', () => void this.submitBatch());
    document.getElementById('create-limit-overlay')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'create-limit-overlay') this.closeCreateModal();
    });

    document.getElementById('limit-side-toggle')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-side]') as HTMLElement | null;
      const value = btn?.getAttribute('data-side') as 'buy' | 'sell' | null;
      if (!value || value === this.wizardSide) return;
      this.wizardSide = value;
      this.syncSetupControls();
      void this.onCoinChanged();
    });

    document.getElementById('limit-mode-toggle')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-mode]') as HTMLElement | null;
      const value = btn?.getAttribute('data-mode') as LimitMode | null;
      if (!value || value === this.mode) return;
      this.mode = value;
      // A single order rests on exactly one pair, so a multi-pair selection has
      // nothing to rotate through — keep the first and drop the rest rather than
      // silently ignoring them at generation time.
      if (this.mode === 'single' && this.selectedQuotes.length > 1) {
        this.selectedQuotes = this.selectedQuotes.slice(0, 1);
        this.renderQuotePicker();
      }
      this.syncSetupControls();
    });

    document.getElementById('limit-conn-select')?.addEventListener('change', () => {
      const select = document.getElementById('limit-conn-select') as HTMLSelectElement;
      this.wizardConnId = parseInt(select.value, 10) || null;
      void this.onExchangeChanged();
    });

    document.getElementById('limit-base-select')?.addEventListener('change', () => {
      const select = document.getElementById('limit-base-select') as HTMLSelectElement;
      this.base = select.value;
      void this.onCoinChanged();
    });

    document.getElementById('limit-quote-picker')?.addEventListener('click', (e) => {
      const chip = (e.target as HTMLElement).closest('[data-quote]') as HTMLButtonElement | null;
      if (!chip || chip.disabled) return;
      const quote = chip.getAttribute('data-quote') || '';
      if (this.mode === 'single') {
        // One order rests on one pair, so this behaves as a radio group.
        this.selectedQuotes = [quote];
      } else if (this.selectedQuotes.includes(quote)) {
        this.selectedQuotes = this.selectedQuotes.filter(q => q !== quote);
      } else {
        // Keep selection in the pair list's own order so the round-robin
        // rotation matches what the chips read left-to-right.
        const order = Object.keys(this.markets).map(s => this.markets[s].quote);
        this.selectedQuotes = order.filter(
          q => q === quote || this.selectedQuotes.includes(q));
      }
      this.renderQuotePicker();
    });

    // Step 2 inputs
    const bindNum = (id: string, apply: (value: number) => void) => {
      document.getElementById(id)?.addEventListener('input', () => {
        const input = document.getElementById(id) as HTMLInputElement;
        apply(parseFloat(input.value));
        this.renderParamHints();
      });
    };
    bindNum('limit-steps', v => { this.stepCount = Number.isFinite(v) ? Math.floor(v) : 0; });
    bindNum('limit-band-start', v => { this.startPct = v; });
    bindNum('limit-band-end', v => { this.endPct = v; });
    bindNum('limit-price-start', v => { this.startPrice = Number.isFinite(v) ? v : null; });
    bindNum('limit-price-end', v => { this.endPrice = Number.isFinite(v) ? v : null; });
    bindNum('limit-total-pct', v => { this.totalPct = v; });
    bindNum('limit-single-price', v => { this.singlePrice = Number.isFinite(v) ? v : null; });
    bindNum('limit-single-amount', v => { this.singleAmount = Number.isFinite(v) ? v : null; });

    document.getElementById('limit-band-mode')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-band]') as HTMLElement | null;
      const value = btn?.getAttribute('data-band') as BandMode | null;
      if (!value || value === this.bandMode) return;
      this.bandMode = value;
      if (value === 'price') this.seedBandPrices();
      this.renderParams();
    });

    document.getElementById('limit-pct-presets')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-pct]') as HTMLElement | null;
      if (!btn) return;
      this.totalPct = parseFloat(btn.getAttribute('data-pct') || '0');
      const input = document.getElementById('limit-total-pct') as HTMLInputElement | null;
      if (input) input.value = String(this.totalPct);
      this.renderParamHints();
    });

    document.getElementById('limit-single-apply-pct')?.addEventListener('click', () => {
      this.applySinglePercent();
    });

    document.getElementById('limit-post-only')?.addEventListener('change', () => {
      const box = document.getElementById('limit-post-only') as HTMLInputElement;
      this.postOnly = box.checked;
    });

    // Step 3
    document.getElementById('limit-regen-prices')?.addEventListener('click', () => this.regeneratePrices());
    document.getElementById('limit-reset-legs')?.addEventListener('click', () => this.resetLegs());

    const legs = document.getElementById('limit-legs-tbody');
    legs?.addEventListener('input', (e) => this.onLegInput(e));
    legs?.addEventListener('change', (e) => this.onLegChange(e));
    legs?.addEventListener('click', (e) => this.onLegClick(e));

    // Progress panel
    document.getElementById('limit-progress-stop')?.addEventListener('click', () => this.stopBatch());
    document.getElementById('limit-progress-dismiss')?.addEventListener('click', () => {
      document.getElementById('limit-progress-section')?.classList.add('d-none');
    });
  }

  /** Which coin/exchange a running batch has locked, or null when free. */
  private lockedBy(): { base: string; exchangeName: string } | null {
    const b = this.batch;
    return b && b.running ? { base: b.base, exchangeName: b.exchangeName } : null;
  }

  private syncCreateButton(): void {
    const btn = document.getElementById('limit-new-order-btn') as HTMLButtonElement | null;
    const label = document.getElementById('limit-new-order-label');
    if (label) label.textContent = `New ${this.side} limit order`;
    btn?.classList.toggle('is-buy', this.side === 'buy');
    btn?.classList.toggle('is-sell', this.side === 'sell');
    if (!btn) return;

    const lock = this.lockedBy();
    const noConnection = this.loadState() === 'no-connection';
    btn.disabled = lock !== null || noConnection;
    btn.title = lock
      ? `Still placing ${lock.base} orders on ${lock.exchangeName} — wait for the batch to finish, or stop it.`
      : noConnection
        ? 'Connect an exchange in your profile to place orders.'
        : 'Create a new resting limit order';
  }

  private async openCreateModal(): Promise<void> {
    const lock = this.lockedBy();
    if (lock) {
      this.showError(`Still placing ${lock.base} orders — wait for that batch to finish, or stop it.`);
      return;
    }
    if (ExchangeStore.connections.length === 0) {
      this.showError('Connect an exchange in your profile before placing orders.');
      return;
    }

    // Inherit the side being browsed; the modal still lets it be switched.
    this.wizardSide = this.side;
    this.mode = 'ladder';
    this.legs = [];
    this.selectedQuotes = [];
    this.markets = {};
    this.singlePrice = null;
    this.singleAmount = null;

    const mode = ExchangeStore.activeMode;
    this.wizardConnId = typeof mode === 'number'
      ? mode
      : (ExchangeStore.connections[0]?.id ?? null);

    this.populateConnectionSelect();
    this.syncSetupControls();
    this.setStep(1);
    document.getElementById('create-limit-overlay')?.classList.remove('d-none');

    await this.onExchangeChanged();
  }

  private closeCreateModal(force = false): void {
    // Never yank the dialog while the first placement is in flight — the result
    // still has to be reported somewhere.
    if (this.submitting && !force) return;
    this.hideModalError();
    document.getElementById('create-limit-overlay')?.classList.add('d-none');
  }

  private setStep(step: 1 | 2 | 3): void {
    this.step = step;
    this.hideModalError();

    const panes: Record<number, string> = {
      1: 'limit-step-setup', 2: 'limit-step-params', 3: 'limit-step-review',
    };
    Object.entries(panes).forEach(([n, id]) =>
      document.getElementById(id)?.classList.toggle('d-none', Number(n) !== step));

    document.querySelectorAll('#limit-wizard-progress .wizard-dot').forEach(dot => {
      const d = Number(dot.getAttribute('data-step'));
      dot.classList.toggle('active', d === step);
      dot.classList.toggle('done', d < step);
    });

    const labels: Record<number, string> = {
      1: 'Step 1 of 3 · What and where',
      2: 'Step 2 of 3 · Price and size',
      3: 'Step 3 of 3 · Review',
    };
    const stepLabel = document.getElementById('limit-wizard-step-label');
    if (stepLabel) stepLabel.textContent = labels[step];

    const title = document.getElementById('limit-wizard-title');
    if (title) {
      title.textContent = this.mode === 'ladder'
        ? `New staggered ${this.wizardSide} ladder`
        : `New ${this.wizardSide} limit order`;
    }

    document.getElementById('limit-wizard-back')?.classList.toggle('d-none', step === 1);
    document.getElementById('limit-wizard-next')?.classList.toggle('d-none', step === 3);
    document.getElementById('limit-submit')?.classList.toggle('d-none', step !== 3);

    if (step === 2) this.renderParams();
    if (step === 3) { this.generateLegs(); this.renderLegs(); }
    // renderParams() covers step 2; steps 1 and 3 need it explicitly.
    if (step !== 2) this.renderBlocker();
  }

  private async wizardNext(): Promise<void> {
    const problem = this.validateStep(this.step);
    if (problem) { this.showModalError(problem); return; }
    if (this.step < 3) this.setStep((this.step + 1) as 1 | 2 | 3);
  }

  private wizardBack(): void {
    if (this.step > 1) this.setStep((this.step - 1) as 1 | 2 | 3);
  }

  // ---------------------------------------------------------------------------
  // Create wizard — step 1
  // ---------------------------------------------------------------------------

  private populateConnectionSelect(): void {
    const select = document.getElementById('limit-conn-select') as HTMLSelectElement | null;
    if (!select) return;
    select.innerHTML = '';
    for (const conn of ExchangeStore.connections) {
      const opt = document.createElement('option');
      opt.value = String(conn.id);
      opt.textContent = ExchangeStore.getExchangeName(conn.id);
      select.appendChild(opt);
    }
    if (this.wizardConnId != null) select.value = String(this.wizardConnId);
    // A single connection makes the picker pure noise.
    document.getElementById('limit-conn-group')
      ?.classList.toggle('d-none', ExchangeStore.connections.length <= 1);
  }

  private syncSetupControls(): void {
    document.querySelectorAll('#limit-side-toggle [data-side]').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-side') === this.wizardSide);
    });
    document.querySelectorAll('#limit-mode-toggle [data-mode]').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === this.mode);
    });
  }

  private async onExchangeChanged(): Promise<void> {
    const connId = this.wizardConnId;
    if (connId == null) return;
    this.markets = {};
    this.selectedQuotes = [];
    await this.populateCoinSelect(connId);
    await this.onCoinChanged();
  }

  /** Sell offers only what's held; buy offers everything tradable. */
  private async populateCoinSelect(connId: number): Promise<void> {
    const select = document.getElementById('limit-base-select') as HTMLSelectElement | null;
    if (!select) return;
    select.innerHTML = '<option value="" disabled selected>Loading…</option>';

    let held: Record<string, string> = {};
    try { held = await ExchangeController.getBalance(connId); } catch { held = {}; }
    if (this.wizardConnId !== connId) return;

    let tradable: string[] = [];
    if (this.wizardSide === 'buy') {
      try { tradable = await ExchangeController.getTradableAssets(connId); } catch { tradable = []; }
      if (this.wizardConnId !== connId) return;
    }

    const heldCodes = Object.keys(held)
      .filter(asset => this.toNumber(held[asset]) > 0)
      .sort((a, b) => a.localeCompare(b));

    select.innerHTML = '<option value="" disabled selected>Choose a coin…</option>';
    if (heldCodes.length > 0) {
      const group = document.createElement('optgroup');
      group.label = 'Your holdings';
      for (const asset of heldCodes) {
        const opt = document.createElement('option');
        opt.value = asset;
        opt.textContent = `${asset} (${this.fmtNum(this.toNumber(held[asset]), 8)})`;
        group.appendChild(opt);
      }
      select.appendChild(group);
    }
    if (this.wizardSide === 'buy') {
      const rest = tradable.filter(a => !heldCodes.includes(a)).sort((a, b) => a.localeCompare(b));
      if (rest.length > 0) {
        const group = document.createElement('optgroup');
        group.label = 'Not held — tradable on this exchange';
        for (const asset of rest) {
          const opt = document.createElement('option');
          opt.value = asset;
          opt.textContent = asset;
          group.appendChild(opt);
        }
        select.appendChild(group);
      }
    }

    // Keep the previous coin selected where it's still offered.
    if (this.base && Array.from(select.options).some(o => o.value === this.base)) {
      select.value = this.base;
    } else {
      this.base = '';
    }

    const hint = document.getElementById('limit-base-hint');
    if (hint) {
      hint.textContent = this.wizardSide === 'sell'
        ? 'Selling offers only coins you currently hold.'
        : '';
    }
  }

  private async onCoinChanged(): Promise<void> {
    this.renderQuotePicker();
    if (!this.base || this.wizardConnId == null) return;
    const hint = document.getElementById('limit-quote-hint');
    if (hint) hint.textContent = 'Loading pairs…';
    try {
      await this.loadPairs(this.wizardConnId, this.base);
    } catch (err: any) {
      if (hint) hint.textContent = '';
      this.showModalError(err?.message || 'Could not load trading pairs for this coin.');
      return;
    }
    // Drop selections the new coin doesn't offer — carrying "USD" over to a coin
    // with no USD market would fail validation with no visible cause.
    const offered = Object.values(this.markets).map(m => m.quote);
    this.selectedQuotes = this.selectedQuotes.filter(q => offered.includes(q));

    // Default to the first pair with a usable balance, else the first.
    const symbols = Object.keys(this.markets);
    if (symbols.length > 0 && this.selectedQuotes.length === 0) {
      const best = symbols.find(s => {
        const m = this.markets[s];
        return this.wizardSide === 'sell' ? m.availableBase > 0 : m.availableQuote > 0;
      }) || symbols[0];
      this.selectedQuotes = [this.markets[best].quote];
    }
    this.renderQuotePicker();
  }

  private renderQuotePicker(): void {
    const host = document.getElementById('limit-quote-picker');
    const hint = document.getElementById('limit-quote-hint');
    if (!host) return;

    const symbols = Object.keys(this.markets);
    if (!this.base) {
      host.innerHTML = '<span class="form-hint">Choose a coin first.</span>';
      if (hint) hint.textContent = '';
      return;
    }
    if (symbols.length === 0) {
      host.innerHTML = `<span class="form-hint">No ${this.escapeHtml(this.base)} markets on this exchange.</span>`;
      if (hint) hint.textContent = '';
      return;
    }

    host.innerHTML = symbols.map(symbol => {
      const market = this.markets[symbol];
      const selected = this.selectedQuotes.includes(market.quote);
      // A buy needs quote currency to spend; a sell needs the base coin.
      const funds = this.wizardSide === 'buy' ? market.availableQuote : market.availableBase;
      const unusable = this.wizardSide === 'buy' && funds <= 0;
      const balanceLabel = this.wizardSide === 'buy'
        ? `${this.fmtNum(market.availableQuote, 2)} ${market.quote}`
        : `${this.fmtNum(market.availableBase, 8)} ${market.base}`;
      return `<button type="button" class="limit-quote-chip${selected ? ' selected' : ''}"
        data-quote="${this.escapeAttr(market.quote)}"${unusable ? ' disabled' : ''}
        title="${unusable ? `No ${this.escapeAttr(market.quote)} balance to buy with` : this.escapeAttr(symbol)}">
        <span>${this.escapeHtml(symbol)}</span>
        <span class="limit-quote-chip-balance">${this.escapeHtml(balanceLabel)}</span>
      </button>`;
    }).join('');

    if (hint) {
      hint.textContent = this.selectedQuotes.length > 1
        ? `Steps rotate through ${this.selectedQuotes.join(' → ')} → ${this.selectedQuotes[0]} …`
        : '';
    }
    this.renderBlocker();
  }

  private validateStep(step: 1 | 2 | 3): string | null {
    if (step === 1) return this.validateSetup();
    if (step === 2) {
      return this.mode === 'ladder' ? this.validateLadderParams() : this.validateSingleParams();
    }
    return this.validateLegs();
  }

  private validateSetup(): string | null {
    if (this.wizardConnId == null) return 'Choose which exchange to place these orders on.';
    if (!this.base) return 'Choose the coin to trade.';
    if (this.selectedQuotes.length === 0) return 'Select at least one trading pair.';

    const exchange = ExchangeStore.getExchangeName(this.wizardConnId);
    for (const quote of this.selectedQuotes) {
      if (!this.markets[`${this.base}/${quote}`]) {
        return `${exchange} does not list a ${this.base}/${quote} market.`;
      }
    }
    if (this.wizardSide === 'sell') {
      if (this.available(this.base) <= 0) {
        return `You have no ${this.base} available to sell on ${exchange}. `
             + 'Funds locked in existing orders do not count.';
      }
    } else if (this.selectedQuotes.every(q => this.available(q) <= 0)) {
      return `None of the selected quote currencies have an available balance on ${exchange}.`;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Create wizard — step 2
  // ---------------------------------------------------------------------------

  private renderParams(): void {
    document.getElementById('limit-params-ladder')?.classList.toggle('d-none', this.mode !== 'ladder');
    document.getElementById('limit-params-single')?.classList.toggle('d-none', this.mode !== 'single');

    const intro = document.getElementById('limit-params-intro');
    if (intro) {
      intro.textContent = this.mode === 'ladder'
        ? `How far from the market should the ${this.wizardSide} ladder sit, and how much of your balance should it use?`
        : `Set the price and size for this ${this.wizardSide} order.`;
    }

    // The percent fields are magnitudes; the side supplies the direction.
    const arrow = document.querySelector('#limit-band-percent-row .limit-band-arrow');
    if (arrow) {
      arrow.textContent = this.wizardSide === 'sell' ? '% above →' : '% below →';
    }

    document.querySelectorAll('#limit-band-mode [data-band]').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-band') === this.bandMode);
    });
    document.getElementById('limit-band-percent-row')
      ?.classList.toggle('d-none', this.bandMode !== 'percent');
    document.getElementById('limit-band-price-row')
      ?.classList.toggle('d-none', this.bandMode !== 'price');

    const unit = document.getElementById('limit-price-unit');
    if (unit) unit.textContent = this.selectedQuotes[0] || '';

    // Post-only is meaningless where the exchange has no such flag (Robinhood),
    // and sending it there would make every leg fail with a 400.
    const row = document.getElementById('limit-postonly-row');
    row?.classList.toggle('d-none', !this.supportsPostOnly);
    const box = document.getElementById('limit-post-only') as HTMLInputElement | null;
    if (box) box.checked = this.supportsPostOnly && this.postOnly;

    if (this.mode === 'single') this.seedSinglePrice();
    this.renderMarketPrice();
    this.renderParamHints();
  }

  /**
   * Fill the exact-price fields from the percentage band, so switching modes
   * carries the band over instead of emptying it.
   */
  private seedBandPrices(): void {
    const market = this.markets[`${this.base}/${this.selectedQuotes[0]}`];
    if (!market || !(market.price > 0)) return;
    const sign = this.wizardSide === 'sell' ? 1 : -1;
    this.startPrice = this.roundToTick(
      market.price * (1 + sign * this.startPct / 100), market.priceTick, 'round');
    this.endPrice = this.roundToTick(
      market.price * (1 + sign * this.endPct / 100), market.priceTick, 'round');

    const startInput = document.getElementById('limit-price-start') as HTMLInputElement | null;
    const endInput = document.getElementById('limit-price-end') as HTMLInputElement | null;
    if (startInput) startInput.value = this.fmtNum(this.startPrice, market.priceDecimals);
    if (endInput) endInput.value = this.fmtNum(this.endPrice, market.priceDecimals);
  }

  /**
   * Start the single-order price one `startPct` step off the market rather than
   * blank — a blank field invites typing a price on the wrong side of the market,
   * which fills instantly as a taker.
   */
  private seedSinglePrice(): void {
    if (this.singlePrice != null) return;
    const market = this.markets[`${this.base}/${this.selectedQuotes[0]}`];
    if (!market || !(market.price > 0)) return;
    const signed = this.wizardSide === 'sell' ? this.startPct : -this.startPct;
    this.singlePrice = this.roundToTick(
      market.price * (1 + signed / 100), market.priceTick, 'round');
    const input = document.getElementById('limit-single-price') as HTMLInputElement | null;
    if (input) input.value = this.fmtNum(this.singlePrice, market.priceDecimals);

    const hint = document.getElementById('limit-single-price-hint');
    if (hint) {
      hint.textContent = `Market is ${this.fmtNum(market.price, market.priceDecimals)} `
        + `${market.quote} — a ${this.wizardSide} limit must sit `
        + `${this.wizardSide === 'sell' ? 'above' : 'below'} it to rest.`;
    }
    const amountHint = document.getElementById('limit-single-amount-hint');
    if (amountHint) {
      amountHint.textContent = this.wizardSide === 'sell'
        ? `${this.fmtNum(this.available(market.base), 8)} ${market.base} available`
        : `${this.fmtMoney(this.available(market.quote), market.quote)} available to spend`;
    }
  }

  private renderMarketPrice(): void {
    const el = document.getElementById('limit-market-price');
    if (!el) return;
    const parts = this.selectedQuotes.map(quote => {
      const market = this.markets[`${this.base}/${quote}`];
      if (!market || !(market.price > 0)) return `${this.base}/${quote}: price unavailable`;
      return `${market.symbol} <strong>${this.escapeHtml(this.fmtNum(market.price, market.priceDecimals))}</strong>`;
    });
    el.innerHTML = `Market now &mdash; ${parts.join(' &nbsp;·&nbsp; ')}`;
    el.classList.toggle('is-stale', this.selectedQuotes.some(
      q => !(this.markets[`${this.base}/${q}`]?.price > 0)));
  }

  private renderParamHints(): void {
    const stepsHint = document.getElementById('limit-steps-hint');
    if (stepsHint && this.mode === 'ladder') {
      const n = this.stepCount > 0 ? this.stepCount : 0;
      stepsHint.textContent = n > 0
        ? `${n} order${n === 1 ? '' : 's'}, ${this.estimateText(n)} to place`
        : '';
    }

    const bandHint = document.getElementById('limit-band-hint');
    if (bandHint) {
      bandHint.textContent = this.bandDescription();
    }

    const totalHint = document.getElementById('limit-total-hint');
    if (totalHint) {
      totalHint.textContent = this.budgetSummary();
    }

    this.renderBlocker();
  }

  /** Plain-language readback of the band, so the numbers are unambiguous. */
  private bandDescription(): string {
    const market = this.markets[`${this.base}/${this.selectedQuotes[0]}`];
    if (this.bandMode === 'price') {
      if (!(this.startPrice! > 0) || !(this.endPrice! > 0) || !market) return '';
      const quote = market.quote;
      const from = this.fmtNum(this.startPrice!, market.priceDecimals);
      const to = this.fmtNum(this.endPrice!, market.priceDecimals);
      return `Steps spread between ${from} and ${to} ${quote}`;
    }
    if (!(this.startPct > 0) || !(this.endPct > this.startPct)) return '';
    const direction = this.wizardSide === 'sell' ? 'above' : 'below';
    let text = `${this.startPct}% to ${this.endPct}% ${direction} the market price`;
    if (market && market.price > 0) {
      const sign = this.wizardSide === 'sell' ? 1 : -1;
      const from = market.price * (1 + sign * this.startPct / 100);
      const to = market.price * (1 + sign * this.endPct / 100);
      text += ` — roughly ${this.fmtNum(from, market.priceDecimals)} to `
            + `${this.fmtNum(to, market.priceDecimals)} ${market.quote}`;
    }
    return text;
  }

  /**
   * The live "why Next is blocked" note in the footer.
   *
   * Distinct from the red alert, which fires on an actual Next click: this is a
   * quieter running commentary so the reason is visible before the click, rather
   * than only after it.
   */
  private renderBlocker(): void {
    const host = document.getElementById('limit-wizard-blocker');
    const text = document.getElementById('limit-wizard-blocker-text');
    const next = document.getElementById('limit-wizard-next') as HTMLButtonElement | null;
    if (!host || !text) return;

    // Step 3's own summary and the Submit button carry this already.
    const problem = this.step === 3 ? null : this.validateStep(this.step);
    host.classList.toggle('d-none', !problem);
    text.textContent = problem || '';
    if (next) {
      next.classList.toggle('is-blocked', !!problem);
      next.title = problem || '';
    }
  }

  /** What `totalPct` works out to in real units, per relevant balance. */
  private budgetSummary(): string {
    if (!(this.totalPct > 0)) return '';
    if (this.wizardSide === 'sell') {
      const have = this.available(this.base);
      return `${this.fmtNum(have * this.totalPct / 100, 8)} ${this.base} of `
           + `${this.fmtNum(have, 8)} available`;
    }
    const perQuote = this.selectedQuotes.map(quote => {
      const have = this.available(quote);
      const spend = have * this.totalPct / 100 * LimitOrdersController.BUY_FEE_HEADROOM;
      return `${this.fmtMoney(spend, quote)} of ${this.fmtMoney(have, quote)}`;
    }).join(' · ');
    // Explain the shortfall rather than leaving "Max" looking like a rounding bug.
    return `${perQuote} (a little is kept back for fees)`;
  }

  private applySinglePercent(): void {
    const input = document.getElementById('limit-single-pct') as HTMLInputElement | null;
    const pct = parseFloat(input?.value || '');
    if (!Number.isFinite(pct) || pct <= 0) {
      this.showModalError('Enter a percentage to apply.');
      return;
    }
    const symbol = `${this.base}/${this.selectedQuotes[0]}`;
    const market = this.markets[symbol];
    if (!market) return;

    let amount: number;
    if (this.wizardSide === 'sell') {
      amount = this.available(market.base) * pct / 100;
    } else {
      const price = this.singlePrice || market.price;
      if (!(price > 0)) {
        this.showModalError('Enter a limit price first, so the amount can be worked out.');
        return;
      }
      amount = (this.available(market.quote) * pct / 100) / price;
    }
    this.singleAmount = this.roundToTick(amount, market.amountTick, 'floor');
    const amountInput = document.getElementById('limit-single-amount') as HTMLInputElement | null;
    if (amountInput) amountInput.value = this.fmtNum(this.singleAmount, market.amountDecimals);
    this.hideModalError();
  }

  private validateLadderParams(): string | null {
    if (!Number.isInteger(this.stepCount) || this.stepCount < 2
        || this.stepCount > LimitOrdersController.MAX_STEPS) {
      return `Number of steps must be a whole number between 2 and ${LimitOrdersController.MAX_STEPS}.`;
    }
    const bandProblem = this.bandMode === 'price'
      ? this.validatePriceBand() : this.validatePercentBand();
    if (bandProblem) return bandProblem;

    if (!(this.totalPct > 0) || this.totalPct > 100) {
      return 'Total to use must be between 0 and 100%.';
    }

    for (const quote of this.selectedQuotes) {
      const symbol = `${this.base}/${quote}`;
      const market = this.markets[symbol];
      if (!market) return `No ${symbol} market on this exchange.`;
      if (this.bandMode === 'percent' && !(market.price > 0)) {
        return `No market price available for ${symbol}, so a percentage band can't be `
             + 'measured from it. Switch to exact prices instead.';
      }
      // A coarse tick inside a narrow band can't hold N distinct prices — the
      // alternative is a ladder with silently duplicated rungs.
      const span = this.bandMode === 'price'
        ? Math.abs(this.endPrice! - this.startPrice!)
        : market.price * (this.endPct - this.startPct) / 100;
      const room = market.priceTick > 0 ? Math.floor(span / market.priceTick) : Infinity;
      const need = Math.ceil(this.stepCount / this.selectedQuotes.length);
      if (room < need) {
        const bandLabel = this.bandMode === 'price'
          ? `A ${this.fmtNum(this.startPrice!, market.priceDecimals)}–`
            + `${this.fmtNum(this.endPrice!, market.priceDecimals)} band`
          : `A ${this.startPct}–${this.endPct}% band`;
        return `${bandLabel} on ${symbol} only has room for ${room} distinct `
             + `price${room === 1 ? '' : 's'} at this exchange's ${market.priceTick} tick `
             + 'size. Widen the band or use fewer steps.';
      }
    }
    return null;
  }

  private validatePercentBand(): string | null {
    if (!(this.startPct > 0) || !(this.endPct > 0)) return 'Enter both ends of the price band.';
    if (this.startPct < LimitOrdersController.MIN_OFFSET_PCT) {
      return `Keep the nearest step at least ${LimitOrdersController.MIN_OFFSET_PCT}% away from `
           + 'the market price, or it fills as a taker the moment it lands.';
    }
    if (this.endPct <= this.startPct) {
      return 'The far end of the band has to be further from the market price than the near end.';
    }
    if (this.endPct > LimitOrdersController.MAX_OFFSET_PCT) {
      return `${LimitOrdersController.MAX_OFFSET_PCT}% is the widest band allowed.`;
    }
    return null;
  }

  private validatePriceBand(): string | null {
    // One absolute range cannot mean the same thing on two pairs quoted in
    // different currencies, so exact prices are single-pair only. A percentage
    // band is what makes a multi-pair ladder meaningful.
    if (this.selectedQuotes.length > 1) {
      return 'Exact prices apply to one pair only — a single price range cannot cover '
           + `${this.selectedQuotes.join(', ')}. Pick one pair, or switch back to "% from market".`;
    }
    if (!(this.startPrice! > 0) || !(this.endPrice! > 0)) {
      return 'Enter both ends of the price range.';
    }
    if (this.startPrice === this.endPrice) {
      return 'The two ends of the range have to differ, or every step lands on one price.';
    }

    const symbol = `${this.base}/${this.selectedQuotes[0]}`;
    const market = this.markets[symbol];
    if (!market) return `No ${symbol} market on this exchange.`;

    // "start" is the end nearest the market, so a sell ladder runs upward and a
    // buy ladder downward. Getting this backwards would invert the ladder.
    if (this.wizardSide === 'sell') {
      if (this.endPrice! <= this.startPrice!) {
        return 'For a sell ladder the second price must be higher than the first — '
             + 'the range runs away from the market, upward.';
      }
      if (market.price > 0 && this.startPrice! <= market.price) {
        return `A sell at ${this.fmtNum(this.startPrice!, market.priceDecimals)} is at or below `
             + `the current ${this.fmtNum(market.price, market.priceDecimals)} ${market.quote} `
             + 'market price, so it would fill immediately instead of resting.';
      }
    } else {
      if (this.endPrice! >= this.startPrice!) {
        return 'For a buy ladder the second price must be lower than the first — '
             + 'the range runs away from the market, downward.';
      }
      if (market.price > 0 && this.startPrice! >= market.price) {
        return `A buy at ${this.fmtNum(this.startPrice!, market.priceDecimals)} is at or above `
             + `the current ${this.fmtNum(market.price, market.priceDecimals)} ${market.quote} `
             + 'market price, so it would fill immediately instead of resting.';
      }
    }
    return null;
  }

  private validateSingleParams(): string | null {
    const symbol = `${this.base}/${this.selectedQuotes[0]}`;
    const market = this.markets[symbol];
    if (!market) return `No ${symbol} market on this exchange.`;
    if (!(this.singlePrice! > 0)) return 'Enter a limit price.';
    if (!(this.singleAmount! > 0)) return 'Enter an amount.';
    return null;   // tick / minimum / budget checks are shared with validateLegs()
  }

  // ---------------------------------------------------------------------------
  // Create wizard — ladder generation
  // ---------------------------------------------------------------------------

  private newLeg(slice: number, pair: string, price: number | null, amount: number | null): LimitLeg {
    return {
      id: `leg${++this.legSeq}`, slice, pair, price, amount,
      edited: false, status: 'queued', orderId: null, error: null,
    };
  }

  private generateLegs(): void {
    this.legs = [];
    if (this.mode === 'single') {
      this.legs.push(this.newLeg(0, `${this.base}/${this.selectedQuotes[0]}`,
                                 this.singlePrice, this.singleAmount));
      return;
    }
    const quotes = this.selectedQuotes;
    for (let i = 0; i < this.stepCount; i++) {
      // Strict rotation: step1 -> USDT, step2 -> USD, step3 -> USDC, step4 -> USDT…
      const pair = `${this.base}/${quotes[i % quotes.length]}`;
      this.legs.push(this.newLeg(i, pair, this.priceForSlice(i, pair), null));
    }
    this.enforceMonotonic();
    this.splitAmounts();
  }

  /**
   * A random price inside slice `i` of the band — never anywhere else.
   *
   * The band runs from startPct to endPct away from the market price, all on one
   * side of it, split into stepCount equal slices. Drawing step i only from
   * slice i means the ladder comes out monotonically ordered by construction and
   * no step can land on the wrong side of the market — which a single band-wide
   * random draw would do roughly half the time.
   */
  private priceForSlice(i: number, pair: string): number | null {
    const market = this.markets[pair];
    if (!market) return null;
    const n = Math.max(1, this.stepCount);

    // Exact-price mode slices the absolute range directly. Only ever reachable
    // with a single pair selected (validateLadderParams enforces that), because
    // one absolute range can't be meaningful across pairs quoted in different
    // currencies.
    if (this.bandMode === 'price') {
      if (!(this.startPrice! > 0) || !(this.endPrice! > 0)) return null;
      const lo = this.startPrice! + (this.endPrice! - this.startPrice!) * (i / n);
      const hi = this.startPrice! + (this.endPrice! - this.startPrice!) * ((i + 1) / n);
      const price = lo + Math.random() * (hi - lo);
      return this.roundToTick(price, market.priceTick, 'round');
    }

    if (!(market.price > 0)) return null;
    const lo = this.startPct + (this.endPct - this.startPct) * (i / n);
    const hi = this.startPct + (this.endPct - this.startPct) * ((i + 1) / n);
    const pct = lo + Math.random() * (hi - lo);
    // startPct/endPct are magnitudes; the side supplies the sign, so one pair of
    // fields covers "+1..+10% for sells" and "-1..-10% for buys".
    const signed = this.wizardSide === 'sell' ? pct : -pct;
    return this.roundToTick(market.price * (1 + signed / 100), market.priceTick, 'round');
  }

  /**
   * Rounding to a coarse tick can collapse two adjacent slices onto one price.
   * Nudge by single ticks so the ladder stays strictly ordered within each pair.
   * validateLadderParams has already rejected bands with no room for this.
   */
  private enforceMonotonic(): void {
    for (const quote of this.selectedQuotes) {
      const pair = `${this.base}/${quote}`;
      const market = this.markets[pair];
      if (!market) continue;
      const own = this.legs.filter(l => l.pair === pair);   // already in slice order
      for (let i = 1; i < own.length; i++) {
        const prev = own[i - 1].price;
        const cur = own[i].price;
        if (prev == null || cur == null) continue;
        const wrong = this.wizardSide === 'sell' ? cur <= prev : cur >= prev;
        if (wrong) {
          own[i].price = this.roundToTick(
            this.wizardSide === 'sell' ? prev + market.priceTick : prev - market.priceTick,
            market.priceTick, 'round');
        }
      }
    }
  }

  /**
   * Even split of the budget across steps.
   *
   * Sell: one base-asset budget shared by every step.
   * Buy:  a budget PER QUOTE ASSET — USDT and USDC are different money, so each
   *       quote's own balance is divided among only the steps rotated onto it.
   *
   * Everything floors to the amount tick, so the sum is always within budget.
   */
  private splitAmounts(): void {
    if (this.wizardSide === 'sell') {
      const budget = this.available(this.base) * this.totalPct / 100;
      const per = budget / Math.max(1, this.legs.length);
      for (const leg of this.legs) {
        const market = this.markets[leg.pair];
        leg.amount = market ? this.roundToTick(per, market.amountTick, 'floor') : null;
      }
      return;
    }

    const countByQuote: Record<string, number> = {};
    for (const leg of this.legs) {
      const quote = leg.pair.split('/')[1];
      countByQuote[quote] = (countByQuote[quote] || 0) + 1;
    }
    for (const leg of this.legs) {
      const market = this.markets[leg.pair];
      if (!market || !(leg.price! > 0)) { leg.amount = null; continue; }
      const budget = this.available(market.quote) * this.totalPct / 100
                   * LimitOrdersController.BUY_FEE_HEADROOM;
      const spendHere = budget / Math.max(1, countByQuote[market.quote]);
      leg.amount = this.roundToTick(spendHere / leg.price!, market.amountTick, 'floor');
    }
  }

  /** Fresh random price inside each leg's own slice. Amount edits are kept. */
  private regeneratePrices(): void {
    if (this.mode !== 'ladder') return;
    for (const leg of this.legs) leg.price = this.priceForSlice(leg.slice, leg.pair);
    this.enforceMonotonic();
    this.renderLegs();
  }

  /** Rebuild from step 2, discarding every hand edit. */
  private resetLegs(): void {
    this.generateLegs();
    this.renderLegs();
  }

  // ---------------------------------------------------------------------------
  // Create wizard — legs table
  // ---------------------------------------------------------------------------

  private legTotalText(leg: LimitLeg): string {
    const market = this.markets[leg.pair];
    if (!market || leg.price == null || leg.amount == null) return '--';
    return this.fmtMoney(leg.price * leg.amount, market.quote);
  }

  private legOffsetText(leg: LimitLeg): string {
    const market = this.markets[leg.pair];
    if (!market || !(market.price > 0) || leg.price == null) return '--';
    const pct = (leg.price / market.price - 1) * 100;
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
  }

  /** The first problem with one leg, or null. Drives the per-row error styling. */
  private legProblem(leg: LimitLeg): string | null {
    const market = this.markets[leg.pair];
    if (!market) return `No ${leg.pair} market on this exchange.`;
    if (!(leg.price! > 0)) return 'Enter a limit price.';
    if (!(leg.amount! > 0)) return 'Enter an amount.';
    if (!this.isOnTick(leg.price!, market.priceTick)) {
      return `${leg.pair} prices move in ${market.priceTick} increments.`;
    }
    if (!this.isOnTick(leg.amount!, market.amountTick)) {
      return `${leg.pair} amounts move in ${market.amountTick} increments.`;
    }
    if (market.minAmount > 0 && leg.amount! < market.minAmount) {
      return `${this.fmtNum(leg.amount!, market.amountDecimals)} ${market.base} is below `
           + `the ${this.fmtNum(market.minAmount, market.amountDecimals)} minimum for ${leg.pair}.`;
    }
    if (market.minCost > 0 && leg.price! * leg.amount! < market.minCost) {
      return `${this.fmtMoney(leg.price! * leg.amount!, market.quote)} is below the `
           + `${this.fmtMoney(market.minCost, market.quote)} minimum order value for ${leg.pair}.`;
    }
    if (market.price > 0) {
      if (this.wizardSide === 'sell' && leg.price! <= market.price) {
        return `The price is at or below the current ${leg.pair} market price, so it would `
             + 'fill immediately instead of resting.';
      }
      if (this.wizardSide === 'buy' && leg.price! >= market.price) {
        return `The price is at or above the current ${leg.pair} market price, so it would `
             + 'fill immediately instead of resting.';
      }
    }
    return null;
  }

  private sumAmounts(): number {
    return this.legs.reduce((total, leg) => total + (leg.amount || 0), 0);
  }

  private sumNotionalByQuote(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const leg of this.legs) {
      const quote = leg.pair.split('/')[1];
      out[quote] = (out[quote] || 0) + (leg.price || 0) * (leg.amount || 0);
    }
    return out;
  }

  /** Guards Submit (step 3 has no Next) and drives its disabled state. */
  private validateLegs(): string | null {
    if (this.legs.length === 0) return 'Nothing to place — the ladder is empty.';

    for (let i = 0; i < this.legs.length; i++) {
      const problem = this.legProblem(this.legs[i]);
      if (problem) return `Step ${i + 1}: ${problem}`;
    }

    if (this.wizardSide === 'sell') {
      const need = this.sumAmounts();
      const have = this.available(this.base);
      if (this.exceeds(need, have)) {
        return `The ladder adds up to ${this.fmtNum(need, 8)} ${this.base} but only `
             + `${this.fmtNum(have, 8)} is available. Trim a step or lower an amount.`;
      }
    } else {
      for (const [quote, need] of Object.entries(this.sumNotionalByQuote())) {
        const have = this.available(quote);
        if (this.exceeds(need, have)) {
          return `The ${quote} steps add up to ${this.fmtMoney(need, quote)} but only `
               + `${this.fmtMoney(have, quote)} is available. USDT, USDC and USD are separate `
               + 'balances — each has to cover its own steps.';
        }
      }
    }
    return null;
  }

  private legRow(leg: LimitLeg, index: number): string {
    const market = this.markets[leg.pair];
    const pd = market ? market.priceDecimals : 8;
    const ad = market ? market.amountDecimals : 8;
    const bad = this.legProblem(leg) !== null;
    return `<tr class="limit-leg-row${bad ? ' limit-leg-bad' : ''}${leg.edited ? ' limit-leg-edited' : ''}">
      <td class="limit-leg-num">${index + 1}</td>
      <td><span class="limit-leg-pair">${this.escapeHtml(leg.pair)}</span></td>
      <td><input class="limit-num" type="number" step="any" min="0" inputmode="decimal"
                 data-field="price" data-leg="${this.escapeAttr(leg.id)}"
                 value="${leg.price == null ? '' : this.escapeAttr(this.fmtNum(leg.price, pd))}"
                 aria-label="Limit price for step ${index + 1}"></td>
      <td><input class="limit-num" type="number" step="any" min="0" inputmode="decimal"
                 data-field="amount" data-leg="${this.escapeAttr(leg.id)}"
                 value="${leg.amount == null ? '' : this.escapeAttr(this.fmtNum(leg.amount, ad))}"
                 aria-label="Amount for step ${index + 1}"></td>
      <td class="limit-leg-total" data-total="${this.escapeAttr(leg.id)}">${this.escapeHtml(this.legTotalText(leg))}</td>
      <td class="limit-leg-offset" data-offset="${this.escapeAttr(leg.id)}">${this.escapeHtml(this.legOffsetText(leg))}</td>
      <td class="limit-leg-actions">
        <button type="button" class="limit-leg-remove" data-field="remove"
                data-leg="${this.escapeAttr(leg.id)}" title="Remove this step">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </td>
    </tr>`;
  }

  private renderLegs(): void {
    const tbody = document.getElementById('limit-legs-tbody');
    if (!tbody) return;
    tbody.innerHTML = this.legs.map((leg, i) => this.legRow(leg, i)).join('');
    this.renderTotals();
  }

  private legFor(el: HTMLElement): LimitLeg | undefined {
    const id = el.getAttribute('data-leg') || '';
    return this.legs.find(l => l.id === id);
  }

  private onLegInput(e: Event): void {
    const input = e.target as HTMLInputElement;
    const leg = this.legFor(input);
    if (!leg) return;
    const field = input.getAttribute('data-field');
    const raw = input.value.trim();

    if (field === 'price') {
      leg.price = raw === '' ? null : Math.max(0, parseFloat(raw));
      leg.edited = true;
      this.updateLegRow(leg, 'price');
    } else if (field === 'amount') {
      leg.amount = raw === '' ? null : Math.max(0, parseFloat(raw));
      leg.edited = true;
      this.updateLegRow(leg, 'amount');
    } else {
      return;
    }
    this.renderTotals();
  }

  /**
   * Snap to the tick only on `change` (blur / commit). Snapping on every
   * keystroke would rewrite "0.000024" to "0" the instant the leading zeros land.
   */
  private onLegChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    const leg = this.legFor(input);
    if (!leg) return;
    const market = this.markets[leg.pair];
    if (!market) return;
    const field = input.getAttribute('data-field');
    if (field === 'price' && leg.price != null) {
      leg.price = this.roundToTick(leg.price, market.priceTick, 'round');
    }
    if (field === 'amount' && leg.amount != null) {
      leg.amount = this.roundToTick(leg.amount, market.amountTick, 'floor');
    }
    this.updateLegRow(leg);          // no skip — the field has been left
    this.renderTotals();
  }

  private onLegClick(e: Event): void {
    const btn = (e.target as HTMLElement).closest('[data-field="remove"]') as HTMLElement | null;
    if (!btn) return;
    const leg = this.legFor(btn);
    if (!leg) return;
    if (this.legs.length <= 1) {
      this.showModalError('A ladder needs at least one step.');
      return;
    }
    this.legs = this.legs.filter(l => l.id !== leg.id);
    this.renderLegs();               // display numbers shift, so a full rebuild
  }

  /**
   * Bring one row's DOM back in step without a table rebuild, so focus and
   * scroll stay exactly where the user left them.
   */
  private updateLegRow(leg: LimitLeg, skip?: 'price' | 'amount'): void {
    this.syncLegInputs(leg, skip);

    const total = document.querySelector(`[data-total="${CSS.escape(leg.id)}"]`);
    if (total) total.textContent = this.legTotalText(leg);
    const offset = document.querySelector(`[data-offset="${CSS.escape(leg.id)}"]`);
    if (offset) offset.textContent = this.legOffsetText(leg);

    const row = total?.closest('tr');
    row?.classList.toggle('limit-leg-bad', this.legProblem(leg) !== null);
    row?.classList.toggle('limit-leg-edited', leg.edited);
  }

  /**
   * `skip` leaves one field alone: writing a parsed number back into the box
   * someone is still typing in eats a half-typed "0.000024" on the keystroke.
   */
  private syncLegInputs(leg: LimitLeg, skip?: 'price' | 'amount'): void {
    const market = this.markets[leg.pair];
    const pd = market ? market.priceDecimals : 8;
    const ad = market ? market.amountDecimals : 8;

    const price = document.querySelector<HTMLInputElement>(
      `input[data-field="price"][data-leg="${CSS.escape(leg.id)}"]`);
    if (price && skip !== 'price') {
      price.value = leg.price == null ? '' : this.fmtNum(leg.price, pd);
    }
    const amount = document.querySelector<HTMLInputElement>(
      `input[data-field="amount"][data-leg="${CSS.escape(leg.id)}"]`);
    if (amount && skip !== 'amount') {
      amount.value = leg.amount == null ? '' : this.fmtNum(leg.amount, ad);
    }
  }

  private renderTotals(): void {
    const summary = document.getElementById('limit-legs-summary');
    if (summary) {
      const lines: string[] = [];
      if (this.wizardSide === 'sell') {
        const need = this.sumAmounts();
        const have = this.available(this.base);
        const over = this.exceeds(need, have);
        lines.push(`<span class="limit-legs-total${over ? ' is-over' : ''}">`
          + `Selling ${this.escapeHtml(this.fmtNum(need, 8))} of `
          + `${this.escapeHtml(this.fmtNum(have, 8))} ${this.escapeHtml(this.base)} available`
          + `${have > 0 ? ` (${(need / have * 100).toFixed(1)}%)` : ''}</span>`);
      } else {
        for (const [quote, need] of Object.entries(this.sumNotionalByQuote())) {
          const have = this.available(quote);
          lines.push(`<span class="limit-legs-total${this.exceeds(need, have) ? ' is-over' : ''}">`
            + `${this.escapeHtml(this.fmtMoney(need, quote))} of `
            + `${this.escapeHtml(this.fmtMoney(have, quote))} available</span>`);
        }
      }
      lines.push(`<span class="limit-legs-count">${this.legs.length} order`
        + `${this.legs.length === 1 ? '' : 's'}</span>`);
      summary.innerHTML = lines.join('');
    }

    const problem = this.validateLegs();
    const submit = document.getElementById('limit-submit') as HTMLButtonElement | null;
    if (submit) submit.disabled = problem !== null;
    const label = document.getElementById('limit-submit-label');
    if (label) {
      label.textContent = `Place ${this.legs.length} order${this.legs.length === 1 ? '' : 's'}`;
    }
    if (problem) this.showModalError(problem); else this.hideModalError();

    this.renderEstimate();
  }

  // ---------------------------------------------------------------------------
  // Create wizard — time estimate
  // ---------------------------------------------------------------------------

  private paceMs(): number {
    return Math.max(this.pacingMs, LimitOrdersController.MIN_PACE_MS);
  }

  private estimateMs(count: number): number {
    if (count <= 0) return 0;
    // count requests, but only count-1 waits: the first goes out immediately.
    return count * LimitOrdersController.PLACE_OVERHEAD_MS + (count - 1) * this.paceMs();
  }

  private estimateText(count: number): string {
    const ms = this.estimateMs(count);
    if (ms <= 0) return '';
    if (ms < 1500) return 'under 2 seconds';
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `about ${seconds} second${seconds === 1 ? '' : 's'}`;
    const minutes = Math.round(seconds / 60);
    return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  }

  private renderEstimate(): void {
    const el = document.getElementById('limit-estimate');
    if (!el) return;
    const n = this.legs.length;
    el.textContent = `${n} order${n === 1 ? '' : 's'} · ${this.estimateText(n)} `
                   + 'to place, one at a time';
  }

  // ---------------------------------------------------------------------------
  // Create wizard — placement
  // ---------------------------------------------------------------------------

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

  private async submitBatch(): Promise<void> {
    if (this.submitting || (this.batch && this.batch.running)) return;
    const problem = this.validateLegs();
    if (problem) { this.showModalError(problem); return; }

    this.submitting = true;
    this.batch = {
      connId: this.wizardConnId!,
      exchangeName: ExchangeStore.getExchangeName(this.wizardConnId!),
      side: this.wizardSide,
      base: this.base,
      legs: this.legs.map(leg => ({
        ...leg, status: 'queued' as LegStatus, orderId: null, error: null,
      })),
      cancelRequested: false, running: false, placed: 0, failed: 0,
    };
    this.closeCreateModal(true);
    this.submitting = false;

    this.showProgress();
    this.syncCreateButton();
    this.armUnloadGuard();
    await this.runBatch();
  }

  private showProgress(): void {
    const b = this.batch;
    if (!b) return;
    document.getElementById('limit-progress-section')?.classList.remove('d-none');
    document.getElementById('limit-progress-footer')?.classList.add('d-none');

    const stop = document.getElementById('limit-progress-stop') as HTMLButtonElement | null;
    if (stop) {
      stop.disabled = false;
      stop.innerHTML = '<i class="fa-solid fa-stop"></i> Stop';
      stop.classList.remove('d-none');
    }

    const tbody = document.getElementById('limit-progress-tbody');
    if (tbody) tbody.innerHTML = b.legs.map((leg, i) => this.progressRow(leg, i)).join('');
    this.renderProgressHeader();
  }

  private statusPill(leg: LimitLeg): string {
    const map: Record<LegStatus, [string, string]> = {
      queued: ['limit-status-queued', '<i class="fa-regular fa-clock"></i> Queued'],
      placing: ['limit-status-placing', '<i class="fa-solid fa-spinner fa-spin"></i> Placing…'],
      placed: ['limit-status-placed', '<i class="fa-solid fa-check"></i> Placed'],
      failed: ['limit-status-failed', '<i class="fa-solid fa-xmark"></i> Rejected'],
      skipped: ['limit-status-skipped', '<i class="fa-solid fa-minus"></i> Not sent'],
    };
    const [cls, html] = map[leg.status];
    return `<span class="limit-status ${cls}">${html}</span>`;
  }

  private truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  private progressRow(leg: LimitLeg, index: number): string {
    const market = this.markets[leg.pair];
    const pd = market ? market.priceDecimals : 8;
    const ad = market ? market.amountDecimals : 8;
    return `<tr class="limit-progress-row limit-progress-${leg.status}" data-prog="${this.escapeAttr(leg.id)}">
      <td class="limit-leg-num">${index + 1}</td>
      <td>${this.escapeHtml(leg.pair)}</td>
      <td>${this.escapeHtml(this.fmtNum(leg.price ?? 0, pd))}</td>
      <td>${this.escapeHtml(this.fmtNum(leg.amount ?? 0, ad))}</td>
      <td>${this.statusPill(leg)}</td>
      <td class="order-id-cell" title="${this.escapeAttr(leg.orderId || leg.error || '')}">
        ${this.escapeHtml(leg.orderId || (leg.error ? this.truncate(leg.error, 44) : '--'))}
      </td>
    </tr>`;
  }

  /**
   * Update one row in place — never a table rebuild, so the spinner doesn't
   * restart and the scroll position holds. No-ops safely once the page is gone.
   */
  private updateProgressRow(leg: LimitLeg): void {
    const row = document.querySelector(`[data-prog="${CSS.escape(leg.id)}"]`) as HTMLElement | null;
    if (!row) return;
    row.className = `limit-progress-row limit-progress-${leg.status}`;
    const cells = row.querySelectorAll('td');
    if (cells[4]) cells[4].innerHTML = this.statusPill(leg);
    if (cells[5]) {
      cells[5].textContent = leg.orderId || (leg.error ? this.truncate(leg.error, 44) : '--');
      cells[5].setAttribute('title', leg.orderId || leg.error || '');
    }
  }

  private renderProgressHeader(): void {
    const b = this.batch;
    if (!b) return;
    const done = b.placed + b.failed;
    const total = b.legs.length;

    const title = document.getElementById('limit-progress-title');
    if (title) {
      title.textContent = b.running
        ? `Placing ${total} ${b.side} order${total === 1 ? '' : 's'} on ${b.exchangeName}`
        : `Finished placing ${b.base} ${b.side} orders on ${b.exchangeName}`;
    }

    const fill = document.getElementById('limit-progress-fill');
    if (fill) {
      fill.style.width = `${total > 0 ? (done / total) * 100 : 0}%`;
      fill.classList.toggle('has-failures', b.failed > 0);
    }

    const count = document.getElementById('limit-progress-count');
    if (count) {
      count.textContent = b.failed > 0
        ? `${b.placed} of ${total} placed, ${b.failed} rejected`
        : `${b.placed} of ${total} placed`;
    }

    const eta = document.getElementById('limit-progress-eta');
    if (eta) {
      const remaining = b.legs.filter(l => l.status === 'queued').length;
      eta.textContent = b.running && remaining > 0
        ? `${this.estimateText(remaining)} left` : '';
    }
  }

  private renderProgressFooter(): void {
    const b = this.batch;
    if (!b) return;
    document.getElementById('limit-progress-stop')?.classList.add('d-none');
    document.getElementById('limit-progress-footer')?.classList.remove('d-none');

    const summary = document.getElementById('limit-progress-summary');
    if (!summary) return;
    const skipped = b.legs.filter(l => l.status === 'skipped').length;
    const parts = [`${b.placed} placed`];
    if (b.failed > 0) parts.push(`${b.failed} rejected`);
    if (skipped > 0) parts.push(`${skipped} not sent`);
    summary.textContent = `${parts.join(' · ')}. Orders that were placed are `
                        + 'resting on the exchange and appear in the table below.';
  }

  /** Errors that guarantee every remaining leg fails too. */
  private isFatalPlacementError(err: any): boolean {
    if (err?.keys_invalid) return true;
    const message = String(err?.message || '').toLowerCase();
    return message.includes('authentic') || message.includes('unauthor')
        || message.includes('api key') || message.includes('rate limit')
        || message.includes('too many requests')
        // The budget is gone, so later legs can't fit either.
        || message.includes('insufficient') || message.includes('not enough');
  }

  private async runBatch(): Promise<void> {
    const b = this.batch;
    if (!b || b.running) return;
    b.running = true;

    for (let i = 0; i < b.legs.length; i++) {
      const leg = b.legs[i];

      // Two ways out: the user hit Stop, or the router replaced #app-content.
      if (b.cancelRequested || this.torndown) {
        leg.status = 'skipped';
        this.updateProgressRow(leg);
        continue;
      }

      leg.status = 'placing';
      this.updateProgressRow(leg);
      this.renderProgressHeader();

      try {
        const result = await ExchangeController.createOrder(b.connId, {
          symbol: leg.pair,
          side: b.side,
          type: 'limit',
          amount: leg.amount!,
          price: leg.price!,
          // Only where the exchange has the flag — Robinhood has none, and
          // sending it there would fail every leg with a 400.
          post_only: this.supportsPostOnly && this.postOnly,
          // So a retried or duplicated request can't double-place this leg.
          client_order_id: `cyrus-${leg.id}-${i}`,
        });
        leg.orderId = String(result?.id || '');
        leg.status = 'placed';
        b.placed++;
      } catch (err: any) {
        leg.error = err?.message || 'The exchange rejected this order.';
        leg.status = 'failed';
        b.failed++;
        if (this.isFatalPlacementError(err)) {
          b.cancelRequested = true;
          this.showError(`Stopped after ${b.placed} of ${b.legs.length} orders: ${leg.error}`);
        }
      }

      this.updateProgressRow(leg);
      this.renderProgressHeader();

      // Pace between placements only — no trailing wait after the last one.
      if (!b.cancelRequested && !this.torndown && i < b.legs.length - 1) {
        await this.sleep(this.paceMs());
      }
    }

    b.running = false;

    // Other pages share the store's per-connection cache, so drop this
    // connection's entry before refetching or they keep serving the pre-batch
    // snapshot for the rest of the TTL.
    ExchangeStore.invalidateConnectionData(b.connId);

    this.renderProgressHeader();
    this.renderProgressFooter();
    this.disarmUnloadGuard();
    this.syncCreateButton();

    if (b.placed > 0) {
      this.showSuccess(`Placed ${b.placed} of ${b.legs.length} ${b.side} limit `
        + `order${b.legs.length === 1 ? '' : 's'} for ${b.base} on ${b.exchangeName}.`);
    }
    if (!this.torndown) await ExchangeStore.refreshOrders();
  }

  private stopBatch(): void {
    const b = this.batch;
    if (!b || !b.running) return;
    b.cancelRequested = true;

    // Mark the untouched tail straight away so the table matches what will happen.
    for (const leg of b.legs) {
      if (leg.status === 'queued') {
        leg.status = 'skipped';
        this.updateProgressRow(leg);
      }
    }

    const btn = document.getElementById('limit-progress-stop') as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Stopping…';
    }

    this.showError(`Stopping. The ${b.placed} order${b.placed === 1 ? '' : 's'} already placed `
      + 'are still resting on the exchange — cancel them from the table below if you '
      + 'do not want them.');
  }

  private armUnloadGuard(): void {
    if (this.beforeUnload) return;
    this.beforeUnload = (e: BeforeUnloadEvent) => {
      if (!this.batch?.running) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', this.beforeUnload);
  }

  private disarmUnloadGuard(): void {
    if (!this.beforeUnload) return;
    window.removeEventListener('beforeunload', this.beforeUnload);
    this.beforeUnload = null;
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------

  /** e.g. 'BTC/USD' -> 'BTC' */
  private baseAsset(order: LimitOrder): string {
    return (order.pair || '').split('/')[0] || '';
  }

  /** e.g. 'BTC/USD' -> 'USD' */
  private quoteAsset(order: LimitOrder): string {
    return (order.pair || '').split('/')[1] || '';
  }

  private toNumber(value: string): number {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }

  private filledFraction(order: LimitOrder): number {
    return this.toNumber(order.filled);
  }

  /** 'stop_limit' -> 'Stop limit'. Exchanges snake_case their compound types. */
  private formatType(order: LimitOrder): string {
    const type = (order.type || 'limit').replace(/_/g, ' ');
    return type.charAt(0).toUpperCase() + type.slice(1);
  }

  private formatPrice(order: LimitOrder): string {
    const price = this.toNumber(order.price);
    if (price <= 0) return '--';
    const quote = this.quoteAsset(order);
    return quote ? `${order.price} ${quote}` : order.price;
  }

  /** price × volume — what the whole order is worth if it fills at the limit. */
  private formatTotal(order: LimitOrder): string {
    const total = this.toNumber(order.price) * this.toNumber(order.volume);
    if (total <= 0) return '--';
    const quote = this.quoteAsset(order);
    const formatted = total.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return quote ? `${formatted} ${quote}` : formatted;
  }

  private formatOpened(order: LimitOrder): string {
    return order.opentm ? new Date(order.opentm).toLocaleString() : '--';
  }

  // ---------------------------------------------------------------------------
  // Banners
  // ---------------------------------------------------------------------------

  private setRefreshLabel(text: string): void {
    const el = document.getElementById('limit-refresh-label');
    if (el) el.textContent = text ? `— ${text}` : '';
  }

  private showError(message: string): void {
    const el = document.getElementById('limit-error');
    const msgEl = document.getElementById('limit-error-message');
    if (el && msgEl) {
      msgEl.textContent = message;
      el.classList.remove('d-none');
    }
  }

  private hideError(): void {
    document.getElementById('limit-error')?.classList.add('d-none');
  }

  private showSuccess(message: string): void {
    const el = document.getElementById('limit-success');
    const msgEl = document.getElementById('limit-success-message');
    if (!el || !msgEl) return;
    msgEl.textContent = message;
    el.classList.remove('d-none');
    window.setTimeout(() => el.classList.add('d-none'), 6000);
  }

  private wizardIsOpen(): boolean {
    const overlay = document.getElementById('create-limit-overlay');
    return !!overlay && !overlay.classList.contains('d-none');
  }

  /**
   * The alert element belonging to whichever modal is currently open.
   *
   * There are two overlays with their own alert boxes, and writing to the wrong
   * one puts the message inside a hidden element — which is exactly what made
   * the wizard's validation warnings invisible.
   */
  private modalErrorEl(): HTMLElement | null {
    return document.getElementById(
      this.wizardIsOpen() ? 'limit-modal-error' : 'cancel-order-error');
  }

  private showModalError(message: string): void {
    const el = this.modalErrorEl();
    if (!el) return;
    el.textContent = message;
    el.classList.remove('d-none');
    // The wizard body scrolls, so the alert can sit below the fold on step 3.
    try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch {}
  }

  private hideModalError(): void {
    // Clear both: the wizard can be closed between showing and hiding.
    document.getElementById('cancel-order-error')?.classList.add('d-none');
    document.getElementById('limit-modal-error')?.classList.add('d-none');
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  /**
   * escapeHtml leaves quotes alone, which is fine in text but breaks out of a
   * quoted attribute value. Exchange labels are user-supplied, so anything
   * going into an attribute goes through here.
   */
  private escapeAttr(str: string): string {
    return this.escapeHtml(str).replace(/"/g, '&quot;');
  }
}

new LimitOrdersController();

})();
