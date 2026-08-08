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
  /** Backend's call on whether this quote is dollar-like. Two stable quotes can
   *  share one spend axis; USDT and BTC cannot. */
  stableQuote: boolean;
  /** Set when MIN_AMOUNT_OVERRIDES replaced the exchange's own `min_amount`, so
   *  the figure can be labelled rather than silently contradicting the API. */
  minAmountOverridden: boolean;
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

/**
 * One row of a distribution plot. Price runs down the side and volume across, the
 * way an order book is drawn, so a row is positioned by price and sized by volume.
 * Both plots on this page draw from these.
 */
interface DistRow {
  /** Vertical position, 0 at the bottom of the plot and 1 at the top. */
  frac: number;
  /** What this row contributes, in whatever unit the plot is measuring. */
  value: number;
  /** Hover text — the plot itself carries no per-row labels. */
  title: string;
  /** Drawn hatched: this step can't be placed as it currently stands. */
  bad?: boolean;
}

/** In-flight state for a drag of the median line. Vertical travel only. */
interface DistDrag {
  pointerId: number;
  y: number;
  /** Lean at pointerdown — the drag is applied as a delta from it. */
  lean: number;
  /** Shape at pointerdown, possibly seeded once the drag really starts. */
  shape: number;
  /** Plot height at pointerdown, so a re-render mid-drag can't change the scale. */
  height: number;
  /** Cleared until the pointer travels far enough to count as a drag. */
  moved: boolean;
}

/**
 * One bar of a flow chart: a coin's volume resting against one pair on one
 * exchange. Split by exchange as well as pair so a bar's colour can mean exactly
 * one venue — the same pair on two exchanges is two bars, not an averaged one.
 */
interface FlowBar {
  quote: string;
  pair: string;
  exchange: string;
  /** Base units still resting against this pair. */
  amount: number;
  orders: number;
  partials: number;
  /** What the pair pays out if it all fills, in that pair's quote currency. */
  proceeds: number;
}

/** One coin's worth of bars. Every bar inside a group shares a unit. */
interface FlowGroup {
  base: string;
  total: number;
  bars: FlowBar[];
}

/** A named shape, so the common cases are one click rather than a careful drag. */
interface DistPreset {
  lean: number;
  shape: number;
}

/**
 * The smallest order one step can place on a market, and which of the exchange's
 * two published floors decided it. Carrying the source matters: a minimum order
 * VALUE converted into coins is not the same claim as a minimum order SIZE, and
 * quoting one as the other sends people hunting for a limit that isn't there.
 */
interface StepFloor {
  /** The floor expressed in base coin — what the table's Amount column must clear. */
  amount: number;
  source: 'size' | 'value';
  /** Both limits exactly as the exchange publishes them, 0 when not published.
   *  Reported together: only one of them binds, but seeing both is what lets a
   *  figure be checked against the exchange's own docs. */
  minAmount: number;
  /** …unless MIN_AMOUNT_OVERRIDES replaced the size one, which the text says. */
  minAmountOverridden: boolean;
  minCost: number;
  pair: string;
  base: string;
  quote: string;
  /** The rung this was measured at; 0 when the market couldn't be priced. */
  price: number;
  priceDecimals: number;
  amountDecimals: number;
}

class LimitOrdersController {
  private static readonly MAX_STEPS = 250;
  /**
   * Steps allowed per selected trading pair. Steps rotate through the selected
   * pairs, so each extra pair brings its own room: 2 pairs allow 100 steps, 5
   * pairs hit MAX_STEPS. The absolute cap stays — 250 placements at the pacing
   * below is already several minutes of one-at-a-time requests.
   */
  private static readonly PER_PAIR_STEPS = 50;
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

  /**
   * Minimum order sizes that override what the exchange reports, keyed
   * `exchange:BASE` — per asset, because that is how Kraken defines `ordermin`
   * (the same figure on SHIB/USD, SHIB/USDT and SHIB/EUR).
   *
   * SHIB is here because Kraken's AssetPairs endpoint reports 770000 while the
   * Kraken app shows 210532 to the account actually placing these orders. LUNA
   * is the same story: the endpoint reports 100000, the app shows 21000.
   *
   * On Kraken, base code LUNA is Terra CLASSIC — the chain that collapsed in
   * 2022, trading around $0.00005. Kraken never adopted the LUNC rename and
   * lists no LUNA2, so there is no Terra 2.0 on this venue to confuse it with.
   * LUNC is listed alongside it only because CCXT unifies some venues' codes to
   * that ticker and the backend passes CCXT's code through; both spellings point
   * at the same asset here. The keys are exchange-scoped, so this cannot leak
   * onto a venue where LUNA means Terra 2.0.
   *
   * READ BEFORE ADDING ONE. Cyrus does not decide what the exchange accepts —
   * the order endpoint does. An entry that is LOWER than the real floor makes a
   * ladder look valid here and get rejected rung by rung during placement, after
   * earlier rungs are already resting on the book. That is a worse failure than
   * being blocked up front. Check the exchange's own figure first:
   *
   *   https://api.kraken.com/0/public/AssetPairs?pair=SHIBUSD   -> ordermin
   *
   * and delete the entry once the reported value agrees, so this table can't
   * quietly outlive the discrepancy it was added for.
   */
  private static readonly MIN_AMOUNT_OVERRIDES: Record<string, number> = {
    'kraken:SHIB': 210532,
    'kraken:LUNA': 21000,
    'kraken:LUNC': 21000,
  };

  /**
   * How hard `distShape` bites. Weight for a step falls off exponentially with
   * its distance from `distLean`, and this is the exponent's scale: at shape 1
   * the far end of the band keeps e^-5 ≈ 0.7% of the heaviest step's weight,
   * which is about as lopsided as a ladder can get and still be a ladder.
   */
  private static readonly DIST_SHARPNESS = 5;
  /**
   * Shape applied on the first sideways drag from an even split. With every step
   * weighted identically there is nothing to lean, so a drag would move the line
   * and change no numbers — which reads as a broken control.
   */
  private static readonly DIST_SEED_SHAPE = 0.35;
  /** Below this, the split is even and the readback says so instead of guessing. */
  private static readonly DIST_FLAT_EPSILON = 0.02;
  /**
   * Ladders longer than this refresh the legs table on release rather than on
   * every frame of a drag. Rewriting a few hundred inputs per frame is the one
   * genuinely expensive part; the chart and the totals still track live.
   */
  private static readonly DIST_LIVE_ROW_LIMIT = 60;
  /**
   * Named shapes. These cover what people actually want from a ladder, and
   * having them one click away is what lets the drag stay single-axis: the line
   * moves the median and nothing else.
   */
  private static readonly DIST_PRESETS: Record<string, DistPreset> = {
    even:   { lean: 0.5, shape: 0 },
    near:   { lean: 0,   shape: 0.55 },
    far:    { lean: 1,   shape: 0.55 },
    middle: { lean: 0.5, shape: 0.7 },
    ends:   { lean: 0.5, shape: -0.7 },
  };
  /** Headroom above the furthest rung, so the top bar isn't flush with the frame. */
  private static readonly DIST_AXIS_PAD = 1.08;
  /** Row thickness as a percentage of plot height; CSS clamps the extremes. */
  private static readonly DIST_ROW_FILL = 80;
  private static readonly DIST_MAX_ROW_PCT = 6;
  /**
   * How long a market price fetched for the read-only plot stays usable. Matched
   * to the order poll, so the marker never claims to be fresher than the bars.
   */
  private static readonly SHAPE_PRICE_TTL = 240000;

  private unsubscribe: (() => void) | null = null;
  private side: 'buy' | 'sell' = 'buy';

  /**
   * Ticked rows, keyed `connectionId:orderId` — an order id is only unique
   * within its own exchange, so the bare id would collide across connections.
   *
   * Kept intersected with the visible rows on every render (see
   * `pruneSelection`). Selection you cannot see is selection you cannot check,
   * and this set feeds a bulk cancel.
   */
  private selected = new Set<string>();
  private bulkPending: LimitOrder[] = [];
  private bulkRunning = false;
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

  /** Pair charted under the table. '' until the first render picks one. */
  private shapePair = '';
  /**
   * Market prices for the read-only plot's marker, keyed `connId:PAIR`. The
   * orders in the store carry no price for the market itself, so this is fetched
   * on demand; a null entry means the lookup came back without one, and the
   * marker is simply left off rather than guessed at.
   */
  private shapePrices: Map<string, { price: number | null; at: number }> = new Map();
  private shapePricePending: Set<string> = new Set();

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
  /** True while the pair grid is being fetched; the picker shows a spinner. */
  private loadingPairs = false;
  /** Bumped per fetch so a slow response that lost a race can identify itself. */
  private pairsRequest = 0;
  private pacingMs = 1000;
  private supportsPostOnly = false;

  // ── Ladder volume distribution ──────────────────────────────────────────
  // Two numbers describe the whole shape, and the legs' amounts are derived
  // from them rather than the other way round — so a shape survives a price
  // regeneration, and "Even split" is just distShape = 0.
  /** Where the weight leans, 0 = nearest the market, 1 = furthest. */
  private distLean = 0.5;
  /** 0 = even split (the default), >0 concentrates at the lean, <0 pushes to both ends. */
  private distShape = 0;
  private distDrag: DistDrag | null = null;
  /** Pending rAF handle, so a drag coalesces to one recompute per frame. */
  private distRaf = 0;

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
    this.bindSelection();
    this.bindShapePicker();
    this.bindModal();
    this.bindDetailsModal();
    this.bindBulkModal();
    this.bindWizard();
    this.bindDist();
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
    if (this.distRaf) {
      window.cancelAnimationFrame(this.distRaf);
      this.distRaf = 0;
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

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  /** Order ids repeat across exchanges, so the connection has to be in the key. */
  private selectionKey(order: LimitOrder): string {
    return `${order.connectionId}:${order.id}`;
  }

  /**
   * Drop anything ticked that the user can no longer see.
   *
   * Runs on every render, which covers all three ways a selection can go stale:
   * a filter or side tab hiding a row, and the background poll finding an order
   * already filled or cancelled elsewhere. The alternative — remembering hidden
   * selections — means "Cancel selected" can act on orders that are not on
   * screen, which for an irreversible action is not a trade worth making.
   */
  private pruneSelection(visible: LimitOrder[]): void {
    if (this.selected.size === 0) return;
    const live = new Set(visible.map(o => this.selectionKey(o)));
    for (const key of Array.from(this.selected)) {
      if (!live.has(key)) this.selected.delete(key);
    }
  }

  private selectedOrders(): LimitOrder[] {
    // Read back off the visible list rather than a stored copy, so the orders
    // handed to a bulk cancel are the ones the store currently holds.
    return this.visibleOrders().filter(o => this.selected.has(this.selectionKey(o)));
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

  /**
   * Selection, row-details and bulk-action wiring.
   *
   * All delegated and bound once. `#limit-tbody` and `#limit-thead` are in the
   * view and only ever have their innerHTML replaced, so the elements
   * themselves survive every render — per-render binding would be churn, and
   * would accumulate handlers on the header.
   */
  private bindSelection(): void {
    const tbody = document.getElementById('limit-tbody');

    tbody?.addEventListener('change', (e) => {
      const box = (e.target as HTMLElement).closest('[data-select-key]') as HTMLInputElement | null;
      if (!box) return;
      const key = box.getAttribute('data-select-key') || '';
      if (box.checked) this.selected.add(key);
      else this.selected.delete(key);
      // Patch the affected UI rather than re-rendering: a full render rebuilds
      // the tbody underneath the click that is still being processed.
      this.syncSelectionUi();
    });

    tbody?.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      // The checkbox and the Cancel button own their cells. A click there is
      // not a request to read the order.
      if (target.closest('.limit-select-col') || target.closest('.limit-actions-col')) return;
      const row = target.closest('[data-order-key]') as HTMLElement | null;
      if (!row) return;
      this.openDetailsByKey(row.getAttribute('data-order-key') || '');
    });

    // Rows are focusable, so they answer to the keyboard too.
    tbody?.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key !== 'Enter' && ke.key !== ' ') return;
      const target = ke.target as HTMLElement;
      // Space on a focused checkbox is the browser toggling it — leave it be.
      if (target.closest('.limit-select-col') || target.closest('.limit-actions-col')) return;
      const row = target.closest('[data-order-key]') as HTMLElement | null;
      if (!row) return;
      ke.preventDefault();
      this.openDetailsByKey(row.getAttribute('data-order-key') || '');
    });

    document.getElementById('limit-thead')?.addEventListener('change', (e) => {
      if ((e.target as HTMLElement).id !== 'limit-select-all') return;
      const box = e.target as HTMLInputElement;
      // Scoped to the filtered rows on purpose — see the note in renderHead.
      const visible = this.visibleOrders();
      for (const order of visible) {
        if (box.checked) this.selected.add(this.selectionKey(order));
        else this.selected.delete(this.selectionKey(order));
      }
      // Patch rather than render: rebuilding the header would replace the
      // checkbox mid-click and drop keyboard focus.
      this.syncSelectionUi();
    });

    document.getElementById('limit-bulk-clear')?.addEventListener('click', () => {
      this.selected.clear();
      this.syncSelectionUi();
    });

    document.getElementById('limit-bulk-cancel')?.addEventListener('click', () => {
      this.openBulkModal();
    });
  }

  /** Repaint the tri-state header box, row highlights and the bulk bar. */
  private syncSelectionUi(): void {
    const visible = this.visibleOrders();
    const count = visible.filter(o => this.selected.has(this.selectionKey(o))).length;

    const selectAll = document.getElementById('limit-select-all') as HTMLInputElement | null;
    if (selectAll) {
      selectAll.checked = visible.length > 0 && count === visible.length;
      selectAll.indeterminate = count > 0 && count < visible.length;
    }

    document.querySelectorAll('#limit-tbody tr[data-order-key]').forEach((row) => {
      const key = row.getAttribute('data-order-key') || '';
      const on = this.selected.has(key);
      row.classList.toggle('limit-row-selected', on);
      // Drive the box from state too, so select-all can run through here
      // instead of re-rendering the table out from under the click.
      const box = row.querySelector('[data-select-key]') as HTMLInputElement | null;
      if (box && box.checked !== on) box.checked = on;
    });

    this.renderBulkBar(count);
  }

  private renderBulkBar(count: number): void {
    const bar = document.getElementById('limit-bulk-bar');
    if (!bar) return;
    bar.classList.toggle('d-none', count === 0);
    if (count === 0) return;

    const label = document.getElementById('limit-bulk-count');
    if (label) label.textContent = `${count} order${count === 1 ? '' : 's'} selected`;
    const button = document.getElementById('limit-bulk-cancel-label');
    if (button) button.textContent = count === 1 ? 'Cancel 1 order' : `Cancel ${count} orders`;
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
    // Then prune, because that filter change moves what counts as visible — and
    // the header checkbox rendered next reads the pruned selection.
    this.pruneSelection(this.visibleOrders());
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
    this.renderBulkBar(orders.filter(o => this.selected.has(this.selectionKey(o))).length);
    this.updateCountTitle(orders.length);
    this.renderFilterMeta(orders.length);
    this.renderFlow();
    this.renderShape();
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
    // The select-all box covers the FILTERED rows, not every order — it sits
    // below the filter controls and ticking it must never reach past what the
    // filter is showing. The label says so explicitly.
    const visible = this.visibleOrders();
    const selectedCount = visible.filter(o => this.selected.has(this.selectionKey(o))).length;
    const allChecked = visible.length > 0 && selectedCount === visible.length;
    const someChecked = selectedCount > 0 && !allChecked;
    const selectAllTitle = visible.length === 0
      ? 'No orders to select'
      : this.isFiltering()
        ? `Select all ${visible.length} filtered order${visible.length === 1 ? '' : 's'}`
        : `Select all ${visible.length} ${this.side} order${visible.length === 1 ? '' : 's'}`;

    const cols = [
      `<th class="limit-select-col">`
        + `<input type="checkbox" id="limit-select-all" class="limit-row-check"`
        + ` aria-label="${this.escapeAttr(selectAllTitle)}" title="${this.escapeAttr(selectAllTitle)}"`
        + `${allChecked ? ' checked' : ''}${visible.length === 0 ? ' disabled' : ''}></th>`,
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

    // `indeterminate` is a property, not an attribute — it cannot be set in the
    // markup above and has to be applied after the node exists.
    const selectAll = document.getElementById('limit-select-all') as HTMLInputElement | null;
    if (selectAll) selectAll.indeterminate = someChecked;
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

  // ---------------------------------------------------------------------------
  // Sell flow — where each coin's volume is going
  // ---------------------------------------------------------------------------

  /** Comma-grouped coin amount, at a precision that suits its size. */
  private fmtGrouped(value: number): string {
    // A million SHIB doesn't need decimals; a fraction of a BTC needs eight.
    const dp = value >= 1e6 ? 0 : value >= 1000 ? 2 : value >= 1 ? 4 : 8;
    return value.toLocaleString(undefined, { maximumFractionDigits: dp });
  }

  /** Comma-grouped quote amount for a bar label — money, so 2 decimals at most. */
  private fmtFlowValue(value: number): string {
    const dp = value >= 1000 ? 0 : value >= 1 ? 2 : 6;
    return value.toLocaleString(undefined, { maximumFractionDigits: dp });
  }

  /**
   * Quote assets close enough to a dollar to be added together.
   *
   * Mirrors the backend's own list. A chart whose bars are all dollar-priced can
   * carry a combined total; one that mixes in EUR or a BTC-quoted pair cannot,
   * and says so rather than summing things that aren't the same money.
   */
  private static readonly DOLLAR_QUOTES =
    /^(Z?USD|USDT|USDC|USDS|USDD|USDG|DAI|TUSD|PYUSD|FDUSD|BUSD|RLUSD)$/;

  private flowComparable(group: FlowGroup): boolean {
    return group.bars.every(
      bar => LimitOrdersController.DOLLAR_QUOTES.test(bar.quote.toUpperCase()));
  }

  /** Sell volume folded into one entry per coin, then one bar per pair. */
  private flowGroups(orders: LimitOrder[]): FlowGroup[] {
    const byBase = new Map<string, Map<string, FlowBar>>();

    for (const order of orders) {
      const base = this.baseAsset(order);
      const quote = this.quoteAsset(order);
      const amount = this.restingVolume(order);
      if (!base || !quote || !(amount > 0)) continue;

      if (!byBase.has(base)) byBase.set(base, new Map());
      const bars = byBase.get(base)!;
      // Keyed by pair AND venue: one bar must belong to one exchange, or its
      // colour would have to stand for two of them at once.
      const key = `${quote} ${order.exchangeName || ''}`;
      const bar = bars.get(key) || {
        quote, pair: order.pair, exchange: order.exchangeName || '',
        amount: 0, orders: 0, partials: 0, proceeds: 0,
      };
      bar.amount += amount;
      bar.orders += 1;
      if (this.filledFraction(order) > 0) bar.partials += 1;
      bar.proceeds += amount * this.toNumber(order.price);
      bars.set(key, bar);
    }

    return Array.from(byBase.entries())
      .map(([base, bars]) => {
        const list = Array.from(bars.values()).sort((a, b) => b.amount - a.amount);
        return { base, total: list.reduce((sum, b) => sum + b.amount, 0), bars: list };
      })
      // Coins split across the most pairs first — those are the ones this chart
      // exists to show. Totals can't order them: they're in different units.
      .sort((a, b) => b.bars.length - a.bars.length || a.base.localeCompare(b.base));
  }

  /** "Coinbase Advanced" -> "coinbaseadvanced", matching the badge classes. */
  private exchangeSlug(name: string): string {
    return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  private flowChartHtml(group: FlowGroup, showVenues: boolean): string {
    // Both the bar and its label measure the payout, so a taller bar always
    // carries the bigger number. Heighting by coins while labelling in currency
    // would let a taller bar show a smaller figure whenever the pairs' prices
    // differ, which reads as a bug.
    const max = Math.max(...group.bars.map(bar => bar.proceeds));
    const columns = group.bars.map(bar => {
      const pct = max > 0 ? bar.proceeds / max * 100 : 0;
      // No tooltip, so the label carries what a reader needs and aria-label
      // carries the rest for a screen reader.
      const aria = `${bar.pair} on ${bar.exchange || 'this exchange'}: `
                 + `${this.fmtGrouped(bar.amount)} ${group.base} in ${bar.orders} `
                 + `order${bar.orders === 1 ? '' : 's'}, converting into `
                 + `${this.fmtMoney(bar.proceeds, bar.quote)}`;
      const venue = showVenues && bar.exchange
        ? `<span class="limit-flow-venue">${this.escapeHtml(bar.exchange)}</span>` : '';
      return `<div class="limit-flow-col" role="img"`
        + ` data-exchange="${this.escapeAttr(this.exchangeSlug(bar.exchange))}"`
        + ` aria-label="${this.escapeAttr(aria)}">`
        + `<div class="limit-flow-slot">`
        + `<span class="limit-flow-value">`
        + `${this.escapeHtml(this.fmtFlowValue(bar.proceeds))}</span>`
        + `<span class="limit-flow-bar" style="height:${pct.toFixed(2)}%"></span>`
        + `</div>`
        + `<span class="limit-flow-label">${this.escapeHtml(bar.quote)}${venue}</span>`
        + `</div>`;
    }).join('');

    const pairs = group.bars.length;
    // Only totalled when every bar is dollar-priced — see flowComparable().
    const comparable = this.flowComparable(group);
    const payout = group.bars.reduce((sum, bar) => sum + bar.proceeds, 0);
    const totalHtml = comparable
      ? `<span class="limit-flow-chart-payout">&asymp; `
        + `${this.escapeHtml(this.fmtFlowValue(payout))}</span>`
      : '';
    const note = comparable ? '' :
      `<p class="limit-flow-note">Bars are each pair's own currency `
      + `(${this.escapeHtml(group.bars.map(b => b.quote).join(', '))}), so their heights `
      + `aren't directly comparable and there's no combined total.</p>`;

    return `<div class="limit-flow-chart">
      <div class="limit-flow-chart-head">
        <span class="limit-flow-coin">${this.escapeHtml(group.base)}</span>
        ${totalHtml}
        <span class="limit-flow-chart-total">
          from ${this.escapeHtml(this.fmtGrouped(group.total))} ${this.escapeHtml(group.base)}
          <em>across ${pairs} pair${pairs === 1 ? '' : 's'}</em>
        </span>
      </div>
      <div class="limit-flow-plot">${columns}</div>
      ${note}
    </div>`;
  }

  private renderFlow(): void {
    const section = document.getElementById('limit-flow-section');
    const host = document.getElementById('limit-flow-charts');
    if (!section || !host) return;

    // Sell side only, and driven by the same filtered set as the table so the
    // charts and the rows above them always describe the same orders.
    // Priced orders only: an unpriceable one has no payout to draw a bar from.
    const groups = this.side === 'sell'
      ? this.flowGroups(this.filteredForSide('sell')
          .filter(order => this.toNumber(order.price) > 0))
      : [];

    section.classList.toggle('d-none', groups.length === 0);
    if (groups.length === 0) return;

    const coins = groups.length;
    const bars = groups.reduce((sum, group) => sum + group.bars.length, 0);
    this.setText('limit-flow-meta',
      `${coins} coin${coins === 1 ? '' : 's'} · ${bars} bar${bars === 1 ? '' : 's'}`);

    // Bars are coloured by venue, so name the venues once here rather than on
    // every column — and only bother when there is more than one to tell apart.
    const venues = Array.from(new Set(
      groups.flatMap(group => group.bars.map(bar => bar.exchange)).filter(Boolean))).sort();
    const showVenues = venues.length > 1;
    const legend = document.getElementById('limit-flow-legend');
    if (legend) {
      legend.classList.toggle('d-none', !showVenues);
      legend.innerHTML = showVenues
        ? venues.map(name =>
            `<span class="limit-flow-key" data-exchange="`
            + `${this.escapeAttr(this.exchangeSlug(name))}">`
            + `<i aria-hidden="true"></i>${this.escapeHtml(name)}</span>`).join('')
        : '';
    }

    const split = groups.filter(group => group.bars.length > 1).length;
    this.setText('limit-flow-intro', split > 0
      ? `${split} of these coin${split === 1 ? ' is' : 's are'} split across more than one `
        + 'bar. Each bar is what one pair pays out if every order on it fills, in that '
        + "pair's own currency."
      : "Each coin is resting against a single pair. Bars are what that pair pays out if "
        + 'every order on it fills.');

    host.innerHTML = groups.map(group => this.flowChartHtml(group, showVenues)).join('');
  }

  // ---------------------------------------------------------------------------
  // Resting-order distribution (read-only, under the table)
  //
  // A real price histogram, not one bar per order: three orders stacked at one
  // price and a fourth far away have to LOOK stacked, and evenly spaced bars
  // would draw them as though they were spread out.
  // ---------------------------------------------------------------------------

  private bindShapePicker(): void {
    const select = document.getElementById('limit-shape-pair') as HTMLSelectElement | null;
    select?.addEventListener('change', () => {
      this.shapePair = select.value;
      this.renderShape();
    });
  }

  /** What is still waiting to fill — a part-filled order only rests its remainder. */
  private restingVolume(order: LimitOrder): number {
    return Math.max(0, this.toNumber(order.volume) - this.filledFraction(order));
  }

  /**
   * The market price for a pair, for the marker line.
   *
   * The order store carries no price for the market itself, so this is fetched
   * on demand and cached briefly. Returns undefined while a lookup is in flight
   * or has never run, and null when one came back without a usable price — in
   * both cases the caller leaves the marker off rather than guessing.
   */
  private shapeMarketPrice(connId: number, pair: string): number | null | undefined {
    const key = `${connId}:${pair}`;
    const hit = this.shapePrices.get(key);
    if (hit && Date.now() - hit.at < LimitOrdersController.SHAPE_PRICE_TTL) return hit.price;
    if (this.shapePricePending.has(key)) return undefined;

    this.shapePricePending.add(key);
    // One request covers every quote for this coin, so cache them all — switching
    // the picker between BTC/USD and BTC/USDT then costs nothing.
    void ExchangeController.getPairs(connId, pair.split('/')[0])
      .then(res => {
        const at = Date.now();
        for (const meta of res?.pairs || []) {
          const price = Number(meta.price) || 0;
          this.shapePrices.set(`${connId}:${meta.symbol}`, { price: price > 0 ? price : null, at });
        }
        if (!this.shapePrices.has(key)) this.shapePrices.set(key, { price: null, at });
      })
      .catch(() => this.shapePrices.set(key, { price: null, at: Date.now() }))
      .finally(() => {
        this.shapePricePending.delete(key);
        // The marker is the only thing waiting on this, so a plain re-render is
        // enough — and the teardown guard keeps a late response off a dead page.
        if (!this.torndown) this.renderShape();
      });
    return undefined;
  }

  /**
   * How many price slices to cut the range into.
   *
   * Grows with the order count so a handful of orders don't get lost in mostly
   * empty rows, and stops well before the rows get too thin to read.
   */
  private shapeBinCount(orders: number): number {
    return Math.min(24, Math.max(5, Math.ceil(Math.sqrt(orders) * 4)));
  }

  private renderShape(): void {
    const section = document.getElementById('limit-shape-section');
    const bars = document.getElementById('limit-shape-bars');
    if (!section || !bars) return;

    // Driven by the same filtered set as the table, so the picture and the rows
    // above it always describe the same orders.
    const orders = this.filteredForSide(this.side)
      .filter(o => this.toNumber(o.price) > 0 && this.restingVolume(o) > 0);
    const pairs = Array.from(new Set(orders.map(o => o.pair).filter(Boolean))).sort();

    section.classList.toggle('d-none', pairs.length === 0);
    if (pairs.length === 0) return;

    // Keep the current pick where it survives; otherwise show whichever pair has
    // the most resting orders, since that's the one with a shape worth reading.
    if (!pairs.includes(this.shapePair)) {
      this.shapePair = pairs.reduce((best, pair) =>
        orders.filter(o => o.pair === pair).length > orders.filter(o => o.pair === best).length
          ? pair : best, pairs[0]);
    }
    this.syncShapeOptions(pairs);

    const own = orders.filter(o => o.pair === this.shapePair)
      .sort((a, b) => this.toNumber(a.price) - this.toNumber(b.price));
    const base = this.baseAsset(own[0]);
    const quote = this.quoteAsset(own[0]);
    const low = this.toNumber(own[0].price);
    const high = this.toNumber(own[own.length - 1].price);

    const market = this.shapeMarketPrice(own[0].connectionId, this.shapePair);
    // Stretch the axis to take in the market price when there is one, so the
    // gap between it and the nearest order is visible rather than cropped away.
    const axisLow = Math.min(low, market || low);
    const axisHigh = Math.max(high, market || high);
    const span = axisHigh - axisLow;

    const binCount = span > 0 ? this.shapeBinCount(own.length) : 1;
    const bins: Array<{ volume: number; orders: number; notional: number }> =
      Array.from({ length: binCount }, () => ({ volume: 0, orders: 0, notional: 0 }));
    for (const order of own) {
      const price = this.toNumber(order.price);
      const index = span > 0
        ? Math.min(binCount - 1, Math.floor((price - axisLow) / span * binCount))
        : 0;
      const volume = this.restingVolume(order);
      bins[index].volume += volume;
      bins[index].orders += 1;
      bins[index].notional += volume * price;
    }

    const binPrice = (i: number) => axisLow + span * (i / binCount);
    // The running total has to be read from the market outward, so the rows are
    // ordered by which end the market sits at. Until the price lookup lands the
    // side answers it just as well: a buy rests below the market, a sell above.
    const marketAtTop = market != null && market > 0
      ? market >= (axisLow + axisHigh) / 2
      : this.side === 'buy';
    const binOrder = bins.map((_, i) => i);
    if (marketAtTop) binOrder.reverse();

    const rows: DistRow[] = binOrder.map(i => ({
      frac: (i + 0.5) / binCount,
      value: bins[i].volume,
      title: [
        `${this.fmtNum(binPrice(i), 8)} – ${this.fmtNum(binPrice(i + 1), 8)} ${quote}`,
        bins[i].orders === 0 ? 'No orders in this band'
          : `${bins[i].orders} order${bins[i].orders === 1 ? '' : 's'}`,
        bins[i].volume > 0 ? `${this.fmtNum(bins[i].volume, 8)} ${base} resting` : '',
        bins[i].notional > 0 ? `Worth ${this.fmtMoney(bins[i].notional, quote)} if it fills` : '',
      ].filter(Boolean).join('\n'),
    })).filter(row => row.value > 0);

    const plot = document.getElementById('limit-shape-plot');
    plot?.classList.toggle('is-sell', this.side === 'sell');
    plot?.classList.toggle('is-buy', this.side === 'buy');

    bars.innerHTML = this.distRowsHtml(rows,
      LimitOrdersController.DIST_ROW_FILL / binCount);

    // Full precision belongs in the tooltips; the gutter only has room for
    // enough digits to tell the levels apart.
    const dp = this.axisDecimals(span);
    const axisHost = document.getElementById('limit-shape-yaxis');
    if (axisHost) {
      axisHost.innerHTML = this.distAxisHtml([0, 0.5, 1], frac =>
        this.fmtNum(axisLow + span * frac, dp));
    }

    this.placeMarketLine('limit-shape-market', 'limit-shape-market-label',
      market != null && market > 0 && span > 0 ? (market - axisLow) / span : null,
      market != null ? `Market ${this.fmtNum(market, dp)} ${quote}` : '');

    this.renderShapeText(own, base, quote, axisLow, span, market, binCount, rows);
  }

  /** Enough digits to separate adjacent ticks, without filling the gutter. */
  private axisDecimals(span: number): number {
    if (!(span > 0)) return 2;
    if (span >= 100) return 0;
    if (span >= 1) return 2;
    if (span >= 0.01) return 4;
    return 8;
  }

  /**
   * `axisLow` / `span` describe the plotted axis, which is stretched to take in
   * the market price — so a row's `frac` has to be read back against those, not
   * against the cheapest and dearest orders.
   */
  private renderShapeText(own: LimitOrder[], base: string, quote: string,
                          axisLow: number, span: number,
                          market: number | null | undefined,
                          binCount: number, rows: DistRow[]): void {
    const low = this.toNumber(own[0].price);
    const high = this.toNumber(own[own.length - 1].price);
    const dp = this.axisDecimals(span);
    const title = document.getElementById('limit-shape-title');
    if (title) title.textContent = `Where your resting ${this.side} orders sit`;

    const exchanges = Array.from(new Set(own.map(o => o.exchangeName).filter(Boolean)));
    const intro = document.getElementById('limit-shape-intro');
    if (intro) {
      intro.textContent = `${own.length} resting ${this.side} order`
        + `${own.length === 1 ? '' : 's'} on ${this.shapePair}`
        + (exchanges.length > 1 ? ` across ${exchanges.join(' and ')}` : '')
        + `, from ${this.fmtNum(low, dp)} to ${this.fmtNum(high, dp)} ${quote}`
        + ` in ${binCount} price band${binCount === 1 ? '' : 's'}.`;
    }

    const volumes = rows.map(row => row.value);
    const total = volumes.reduce((sum, v) => sum + v, 0);
    // Rows are already market-outward, which is the order the median has to be
    // counted in for "half of it fills by here" to mean anything.
    const median = this.distMedianIndex(volumes);
    const medianPrice = axisLow + span * (rows[median] ? rows[median].frac : 0.5);
    const parts = [`${this.fmtNum(total, 8)} ${base} resting`];

    if (market != null && market > 0) {
      // The decision-relevant number: how far the market has to travel before
      // half of what is resting has filled.
      const move = (medianPrice / market - 1) * 100;
      parts.push(`half of it fills on a ${Math.abs(move).toFixed(1)}% move `
        + `${move >= 0 ? 'up' : 'down'}`);
    } else {
      parts.push(`half of it ${this.side === 'buy' ? 'at or above' : 'at or below'} `
        + `${this.fmtNum(medianPrice, dp)} ${quote}`);
    }
    this.setText('limit-shape-readback', parts.join(' · '));
  }

  /** Same "only rebuild when the set really changed" rule as the exchange filter. */
  private syncShapeOptions(pairs: string[]): void {
    const select = document.getElementById('limit-shape-pair') as HTMLSelectElement | null;
    if (!select) return;

    const existing = Array.from(select.options).map(o => o.value);
    const unchanged = existing.length === pairs.length
      && existing.every((v, i) => v === pairs[i]);
    if (!unchanged) {
      select.innerHTML = '';
      for (const pair of pairs) {
        const opt = document.createElement('option');
        opt.value = pair;
        opt.textContent = pair;
        select.appendChild(opt);
      }
    }
    select.value = this.shapePair;
    // One pair is the whole answer — a picker with a single choice is just noise.
    select.classList.toggle('d-none', pairs.length <= 1);
  }

  private renderRows(orders: LimitOrder[], isAll: boolean): void {
    const tbody = document.getElementById('limit-tbody');
    if (!tbody) return;

    // +1 for the select column added ahead of everything else.
    const colspan = isAll ? 10 : 9;
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
      const key = this.selectionKey(o);
      const checked = this.selected.has(key);
      return `<tr class="limit-row${checked ? ' limit-row-selected' : ''}"
        data-order-key="${this.escapeAttr(key)}" tabindex="0"
        title="Click for full order details">
        <td class="limit-select-col">
          <input type="checkbox" class="limit-row-check" data-select-key="${this.escapeAttr(key)}"
                 aria-label="Select ${this.escapeAttr(o.pair)} order ${this.escapeAttr(o.id)}"
                 ${checked ? 'checked' : ''}>
        </td>
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

  /**
   * Close-on-backdrop that a drag can't trigger.
   *
   * `click` fires on the nearest common ancestor of where the pointer went down
   * and where it came up. So dragging something inside the dialog — the
   * distribution line, the shape slider, a text selection — and releasing past
   * the dialog's edge lands a click whose target is the overlay itself, which
   * used to close the wizard and throw away the whole ladder.
   *
   * Requiring BOTH ends of the gesture to be on the backdrop leaves a genuine
   * click-off working and makes every drag safe, wherever it ends up. Pointer
   * events rather than mouse ones because the line uses pointer capture; those
   * still bubble to here, so the guard sees the real target either way.
   */
  private bindBackdropClose(overlayId: string, close: () => void): void {
    const overlay = document.getElementById(overlayId);
    if (!overlay) return;

    let downOnBackdrop = false;
    let upOnBackdrop = false;
    overlay.addEventListener('pointerdown', (e) => {
      downOnBackdrop = e.target === overlay;
    });
    overlay.addEventListener('pointerup', (e) => {
      upOnBackdrop = e.target === overlay;
    });
    overlay.addEventListener('click', () => {
      const backdrop = downOnBackdrop && upOnBackdrop;
      // Cleared whatever happens, so one stray half-gesture can't arm the next.
      downOnBackdrop = upOnBackdrop = false;
      if (backdrop) close();
    });
  }

  private bindModal(): void {
    document.getElementById('cancel-order-close')?.addEventListener('click', () => this.closeModal());
    document.getElementById('cancel-order-dismiss')?.addEventListener('click', () => this.closeModal());
    document.getElementById('cancel-order-confirm')?.addEventListener('click', () => this.confirmCancel());

    this.bindBackdropClose('cancel-order-overlay', () => this.closeModal());

    // One document-level handler for EVERY overlay, topmost first. A second
    // listener would leak one handler per navigation, since teardown() only
    // removes the one it knows about.
    this.escHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const isOpen = (id: string) => {
        const el = document.getElementById(id);
        return !!el && !el.classList.contains('d-none');
      };
      // Ordered by how disruptive losing the dialog would be: the wizard holds
      // unsaved work, the two cancel dialogs hold a pending decision, and the
      // read-only details view holds nothing at all.
      if (isOpen('create-limit-overlay')) { this.closeCreateModal(); return; }
      if (isOpen('bulk-cancel-overlay')) { this.closeBulkModal(); return; }
      if (isOpen('cancel-order-overlay')) { this.closeModal(); return; }
      if (isOpen('order-details-overlay')) { this.closeDetails(); }
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
  // Read-only details modal
  // ---------------------------------------------------------------------------

  private bindDetailsModal(): void {
    document.getElementById('order-details-close')
      ?.addEventListener('click', () => this.closeDetails());
    document.getElementById('order-details-dismiss')
      ?.addEventListener('click', () => this.closeDetails());
    this.bindBackdropClose('order-details-overlay', () => this.closeDetails());
  }

  private openDetailsByKey(key: string): void {
    // Resolve against the store rather than the row's markup, so the dialog
    // always describes the order as it currently stands.
    const order = this.allLimitOrders().find(o => this.selectionKey(o) === key);
    if (order) this.openDetails(order);
  }

  private openDetails(order: LimitOrder): void {
    const set = (id: string, value: string) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };

    const sideEl = document.getElementById('order-details-side');
    if (sideEl) {
      const side = (order.side || '').toLowerCase();
      sideEl.textContent = side.toUpperCase();
      sideEl.className = `cancel-order-side ${side === 'buy' ? 'side-buy' : 'side-sell'}`;
    }

    const base = this.baseAsset(order);
    const remaining = this.toNumber(order.volume) - this.toNumber(order.filled);

    set('order-details-pair', order.pair || '--');
    set('order-details-type', this.formatType(order));
    set('order-details-status', this.formatStatus(order));
    set('order-details-price', this.formatPrice(order));
    set('order-details-volume', `${order.volume} ${base}`.trim());
    set('order-details-filled', `${order.filled} ${base}`.trim());
    set('order-details-remaining',
        `${this.fmtGrouped(Math.max(0, remaining))} ${base}`.trim());
    set('order-details-total', this.formatTotal(order));
    set('order-details-opened', this.formatOpened(order));
    set('order-details-id', order.id || '--');
    set('order-details-exchange', order.exchangeName || '--');

    document.getElementById('order-details-exchange-row')
      ?.classList.toggle('d-none', !ExchangeStore.isAllMode());
    document.getElementById('order-details-partial')
      ?.classList.toggle('d-none', this.filledFraction(order) <= 0);
    document.getElementById('order-details-synthetic')
      ?.classList.toggle('d-none', !order.synthetic);

    document.getElementById('order-details-overlay')?.classList.remove('d-none');
    (document.getElementById('order-details-dismiss') as HTMLButtonElement | null)?.focus();
  }

  private closeDetails(): void {
    document.getElementById('order-details-overlay')?.classList.add('d-none');
  }

  /** Status as the exchange reports it, title-cased; 'Open' when unreported. */
  private formatStatus(order: LimitOrder): string {
    const raw = String(order.status || '').trim();
    if (!raw) return 'Open';
    return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  }

  // ---------------------------------------------------------------------------
  // Bulk cancel
  // ---------------------------------------------------------------------------

  /**
   * Delay between cancels in a bulk run.
   *
   * Fixed at the slowest pacing any supported exchange asks for (Kraken's
   * 1000ms, per the backend registry) rather than read per-exchange: one bulk
   * run can span several connections, and a single loop cannot honour several
   * different budgets at once. Erring slow costs seconds; erring fast trips a
   * rate limit part-way through and leaves the user guessing which orders
   * actually went.
   */
  private static readonly BULK_CANCEL_PACE_MS = 1000;

  private bindBulkModal(): void {
    document.getElementById('bulk-cancel-close')
      ?.addEventListener('click', () => this.closeBulkModal());
    document.getElementById('bulk-cancel-dismiss')
      ?.addEventListener('click', () => this.closeBulkModal());
    document.getElementById('bulk-cancel-confirm')
      ?.addEventListener('click', () => void this.confirmBulkCancel());
    this.bindBackdropClose('bulk-cancel-overlay', () => this.closeBulkModal());
  }

  private openBulkModal(): void {
    const orders = this.selectedOrders();
    if (orders.length === 0) return;

    this.bulkPending = orders;
    this.hideBulkError();

    const isAll = ExchangeStore.isAllMode();
    document.getElementById('bulk-cancel-exchange-th')?.classList.toggle('d-none', !isAll);

    const title = document.getElementById('bulk-cancel-title');
    if (title) {
      title.textContent = orders.length === 1
        ? 'Cancel this order?'
        : `Cancel these ${orders.length} orders?`;
    }

    const confirmLabel = document.getElementById('bulk-cancel-confirm-label');
    if (confirmLabel) {
      confirmLabel.textContent = orders.length === 1
        ? 'Cancel Order' : `Cancel ${orders.length} Orders`;
    }

    const subtitle = document.getElementById('bulk-cancel-subtitle');
    if (subtitle) {
      const exchanges = new Set(orders.map(o => o.exchangeName).filter(Boolean));
      const where = exchanges.size > 1 ? ` across ${exchanges.size} exchanges` : '';
      subtitle.textContent = `Review the list below${where} — cancelling cannot be undone.`;
    }

    const note = document.getElementById('bulk-cancel-note-text');
    if (note) {
      note.textContent = orders.length === 1
        ? 'This order is cancelled from this page. Leaving before it finishes leaves it resting on the exchange.'
        : `These are cancelled one at a time, taking ${this.bulkEstimateText(orders.length)}. `
          + 'Leaving this page part-way through stops the rest — anything not yet '
          + 'cancelled stays resting on the exchange.';
    }

    const partial = orders.filter(o => this.filledFraction(o) > 0);
    const partialBox = document.getElementById('bulk-cancel-partial');
    const partialText = document.getElementById('bulk-cancel-partial-text');
    partialBox?.classList.toggle('d-none', partial.length === 0);
    if (partialText && partial.length) {
      partialText.textContent = partial.length === 1
        ? 'One of these orders is partially filled. Cancelling stops the remainder — the portion already filled stays executed.'
        : `${partial.length} of these orders are partially filled. Cancelling stops the remainder — the portions already filled stay executed.`;
    }

    // Kraken cannot cancel synthetic-pair orders through its API, so say so
    // before the run rather than presenting it as a mystery failure after.
    const synthetic = orders.filter(o => o.synthetic);
    const synthBox = document.getElementById('bulk-cancel-synthetic');
    const synthText = document.getElementById('bulk-cancel-synthetic-text');
    synthBox?.classList.toggle('d-none', synthetic.length === 0);
    if (synthText && synthetic.length) {
      synthText.textContent =
        `${synthetic.length} of these ${synthetic.length === 1 ? 'is a' : 'are'} Kraken `
        + `synthetic-pair order${synthetic.length === 1 ? '' : 's'}. Kraken's API cannot cancel `
        + `${synthetic.length === 1 ? 'it' : 'them'} — expect ${synthetic.length === 1 ? 'it' : 'those'} `
        + `to fail here and cancel ${synthetic.length === 1 ? 'it' : 'them'} from Kraken's own site or app.`;
    }

    this.renderBulkRows(isAll);
    this.setBulkProgress(0, orders.length, false);
    this.setBulkBusy(false);

    document.getElementById('bulk-cancel-overlay')?.classList.remove('d-none');
    (document.getElementById('bulk-cancel-dismiss') as HTMLButtonElement | null)?.focus();
  }

  private bulkEstimateText(count: number): string {
    if (count <= 1) return 'a moment';
    const ms = (count - 1) * LimitOrdersController.BULK_CANCEL_PACE_MS
             + count * LimitOrdersController.PLACE_OVERHEAD_MS;
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `about ${seconds} second${seconds === 1 ? '' : 's'}`;
    const minutes = Math.round(seconds / 60);
    return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  }

  private renderBulkRows(isAll: boolean): void {
    const tbody = document.getElementById('bulk-cancel-tbody');
    if (!tbody) return;

    tbody.innerHTML = this.bulkPending.map((o, i) => {
      const exchangeCol = isAll
        ? `<td><span class="exchange-badge exchange-${this.escapeAttr(o.exchangeName).toLowerCase()}">${this.escapeHtml(o.exchangeName)}</span></td>`
        : '';
      const side = (o.side || '').toLowerCase();
      const synthetic = o.synthetic
        ? ' <span class="limit-synthetic-tag">synthetic</span>' : '';
      const partial = this.filledFraction(o) > 0
        ? ' <span class="limit-partial-tag">partial</span>' : '';
      return `<tr data-bulk-key="${this.escapeAttr(this.selectionKey(o))}">
        <td class="limit-leg-num-col">${i + 1}</td>
        ${exchangeCol}
        <td class="limit-pair-cell">
          <span class="cancel-order-side ${side === 'buy' ? 'side-buy' : 'side-sell'}">${this.escapeHtml(side.toUpperCase())}</span>
          ${this.escapeHtml(o.pair)}${synthetic}
        </td>
        <td>${this.escapeHtml(this.formatPrice(o))}</td>
        <td>${this.escapeHtml(o.volume)}${partial}</td>
        <td>${this.escapeHtml(this.formatTotal(o))}</td>
        <td class="bulk-cancel-status-col" data-bulk-status>
          <span class="bulk-status bulk-status-waiting">Waiting</span>
        </td>
      </tr>`;
    }).join('');
  }

  private setBulkRowStatus(order: LimitOrder, state: 'working' | 'done' | 'failed',
                           detail?: string): void {
    const key = this.selectionKey(order);
    const row = document.querySelector(`#bulk-cancel-tbody tr[data-bulk-key="${CSS.escape(key)}"]`);
    const cell = row?.querySelector('[data-bulk-status]');
    if (!cell) return;

    if (state === 'working') {
      cell.innerHTML = '<span class="bulk-status bulk-status-working">'
        + '<i class="fa-solid fa-spinner fa-spin"></i> Cancelling</span>';
    } else if (state === 'done') {
      cell.innerHTML = `<span class="bulk-status bulk-status-done">`
        + `<i class="fa-solid fa-check"></i> ${this.escapeHtml(detail || 'Cancelled')}</span>`;
    } else {
      cell.innerHTML = `<span class="bulk-status bulk-status-failed" title="${this.escapeAttr(detail || '')}">`
        + `<i class="fa-solid fa-triangle-exclamation"></i> ${this.escapeHtml(detail || 'Failed')}</span>`;
    }
  }

  private setBulkProgress(done: number, total: number, visible: boolean): void {
    document.getElementById('bulk-cancel-progress')?.classList.toggle('d-none', !visible);
    const fill = document.getElementById('bulk-cancel-fill') as HTMLElement | null;
    if (fill) fill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
    const count = document.getElementById('bulk-cancel-count');
    if (count) count.textContent = `${done} of ${total}`;
  }

  private setBulkBusy(busy: boolean): void {
    const confirm = document.getElementById('bulk-cancel-confirm') as HTMLButtonElement | null;
    const dismiss = document.getElementById('bulk-cancel-dismiss') as HTMLButtonElement | null;
    const close = document.getElementById('bulk-cancel-close') as HTMLButtonElement | null;
    if (confirm) confirm.disabled = busy;
    if (dismiss) dismiss.disabled = busy;
    if (close) close.disabled = busy;
  }

  private closeBulkModal(): void {
    // A run in flight owns the dialog — its results have to land somewhere.
    if (this.bulkRunning) return;
    this.bulkPending = [];
    this.hideBulkError();
    document.getElementById('bulk-cancel-overlay')?.classList.add('d-none');
  }

  private showBulkError(message: string): void {
    const el = document.getElementById('bulk-cancel-error');
    if (!el) return;
    el.textContent = message;
    el.classList.remove('d-none');
  }

  private hideBulkError(): void {
    document.getElementById('bulk-cancel-error')?.classList.add('d-none');
  }

  /**
   * Cancel the listed orders one at a time.
   *
   * Sequential and paced rather than fired in parallel: these are private,
   * rate-limited calls against the same keys the automation worker uses, and a
   * burst that trips a throttle would leave an unknown subset cancelled.
   *
   * Each row reports its own outcome as it lands, and a failure never stops the
   * run — one synthetic-pair order that Kraken refuses must not strand the
   * other nineteen. The dialog stays open when anything failed, so the list of
   * what did and didn't go is still on screen.
   */
  private async confirmBulkCancel(): Promise<void> {
    if (this.bulkRunning || this.bulkPending.length === 0) return;

    const orders = this.bulkPending.slice();
    this.bulkRunning = true;
    this.hideBulkError();
    this.setBulkBusy(true);
    this.setBulkProgress(0, orders.length, true);

    const touched = new Set<number>();
    const failures: Array<{ order: LimitOrder; message: string }> = [];
    let done = 0;

    for (let i = 0; i < orders.length; i++) {
      // Navigating away mid-run: stop issuing, keep whatever already happened.
      if (this.torndown) break;

      const order = orders[i];
      this.setBulkRowStatus(order, 'working');
      try {
        const result = await ExchangeController.cancelOrder(
          order.connectionId, order.id, order.pair);
        touched.add(order.connectionId);
        // Robinhood only acknowledges the request and cancels asynchronously,
        // so don't claim it's gone.
        const pending = String(result?.status || '').toLowerCase() === 'canceling';
        this.setBulkRowStatus(order, 'done', pending ? 'Submitted' : 'Cancelled');
      } catch (err: any) {
        const message = err?.message || 'Failed';
        failures.push({ order, message });
        this.setBulkRowStatus(order, 'failed', message);
      }

      done++;
      this.setBulkProgress(done, orders.length, true);
      if (i < orders.length - 1 && !this.torndown) {
        await this.sleep(LimitOrdersController.BULK_CANCEL_PACE_MS);
      }
    }

    this.bulkRunning = false;
    this.setBulkBusy(false);

    // Other pages share the store's order cache — drop every connection we
    // touched before refetching, or they keep showing cancelled orders.
    for (const connId of touched) ExchangeStore.invalidateConnectionData(connId);

    if (this.torndown) return;

    const succeeded = done - failures.length;
    // Only clear what actually went. A failed order stays ticked so the user
    // can retry it without hunting through the table again.
    for (const order of orders) {
      if (!failures.some(f => this.selectionKey(f.order) === this.selectionKey(order))) {
        this.selected.delete(this.selectionKey(order));
      }
    }

    if (failures.length === 0) {
      this.closeBulkModalForce();
      this.showSuccess(succeeded === 1
        ? 'Cancelled 1 limit order.'
        : `Cancelled ${succeeded} limit orders.`);
    } else {
      // Dialog stays open: the per-row outcomes are the only record of which
      // orders went and which are still resting.
      this.showBulkError(
        `${succeeded} cancelled, ${failures.length} failed. The failures are listed above and `
        + 'stay selected so you can retry them.');
    }

    // Best-effort: the cancels have already happened and been reported, so a
    // failed refresh must not surface as though the run itself failed.
    try {
      await ExchangeStore.refreshOrders();
    } catch {
      /* the next poll picks it up */
    }
  }

  /** Close past the in-flight guard, for the success path that owns the run. */
  private closeBulkModalForce(): void {
    this.bulkPending = [];
    this.hideBulkError();
    document.getElementById('bulk-cancel-overlay')?.classList.add('d-none');
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

  /**
   * Is `value` already on the exchange's grid?
   *
   * Asked as "does re-snapping change it?" rather than by measuring how far
   * `value / tick` sits from a whole number. That comparison needs a tolerance,
   * and no fixed one works: a meme-coin ladder sells millions of units against a
   * 1e-8 tick, which puts the quotient around 1e14 — where a double's own
   * spacing is ~0.016, tens of thousands of times the 1e-6 epsilon this used to
   * allow. Every rung of a SHIB ladder came back off-tick and turned red.
   *
   * Round-tripping has no tolerance to get wrong, and it is exactly consistent
   * with how the values are produced: every price and amount in the ladder comes
   * out of roundToTick(), and a hand-typed one is snapped by it on commit.
   */
  private isOnTick(value: number, tick: number): boolean {
    if (!(tick > 0)) return true;
    return this.roundToTick(value, tick, 'round') === value;
  }

  /** A tick as the exchange would write it — "0.00000001", never "1e-8". */
  private fmtTick(tick: number): string {
    return this.fmtNum(tick, this.decimalsFromTick(tick));
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

  /** The exchange's key in MIN_AMOUNT_OVERRIDES — "Kraken" -> "kraken". */
  private exchangeKey(): string {
    if (this.wizardConnId == null) return '';
    return ExchangeStore.getExchangeName(this.wizardConnId)
      .toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  private normalizeMarket(raw: PairMeta): LegMarket {
    const priceTick = Number(raw.price_tick) || 0;
    const amountTick = Number(raw.amount_tick) || 0;
    const reportedMin = Number(raw.min_amount) || 0;
    const override = LimitOrdersController.MIN_AMOUNT_OVERRIDES[
      `${this.exchangeKey()}:${String(raw.base).toUpperCase()}`];
    // Only counts as an override when it actually differs — once the exchange
    // catches up, the label stops appearing on its own.
    const overridden = override != null && override !== reportedMin;
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
      minAmount: override != null ? override : reportedMin,
      minCost: Number(raw.min_cost) || 0,
      price: Number(raw.price) || 0,
      availableBase: Number(raw.available_base) || 0,
      availableQuote: Number(raw.available_quote) || 0,
      stableQuote: raw.stable_quote === true,
      minAmountOverridden: overridden,
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
    this.bindBackdropClose('create-limit-overlay', () => this.closeCreateModal());

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
    // A fresh wizard starts on an even split, so nothing carries over from a
    // ladder shaped earlier in the session.
    this.distLean = 0.5;
    this.distShape = 0;

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
    if (!this.base || this.wizardConnId == null) {
      this.loadingPairs = false;
      this.renderQuotePicker();
      return;
    }

    // The previous coin's chips are cleared before the fetch, not after. Leaving
    // them up during the load shows another coin's markets as live, selectable
    // options — and a click during that window would select a pair that is about
    // to stop existing.
    const request = ++this.pairsRequest;
    this.loadingPairs = true;
    this.markets = {};
    this.renderQuotePicker();

    try {
      await this.loadPairs(this.wizardConnId, this.base);
    } catch (err: any) {
      if (request === this.pairsRequest) {
        this.loadingPairs = false;
        this.renderQuotePicker();
        this.showModalError(err?.message || 'Could not load trading pairs for this coin.');
      }
      return;
    }

    // A superseded request must neither install its results nor clear the
    // spinner — the newer fetch it lost to is still running.
    if (request !== this.pairsRequest) return;
    this.loadingPairs = false;
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

    // Checked before anything reads `markets`: during a load it is empty, and
    // every branch below would otherwise report "no markets on this exchange".
    if (this.loadingPairs) {
      host.innerHTML =
        `<span class="limit-quote-loading" role="status" aria-live="polite">`
        + `<i class="fa-solid fa-circle-notch limit-spinner" aria-hidden="true"></i>`
        + `<span>Loading ${this.escapeHtml(this.base)} trading pairs…</span></span>`;
      if (hint) hint.textContent = '';
      this.renderBlocker();
      return;
    }

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
    // Holds Next while the fetch is out. Without this the checks below run
    // against an empty grid and reject the coin for having no markets, which is
    // a lie the user then has to watch correct itself.
    if (this.loadingPairs) return `Loading ${this.base} trading pairs…`;
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
    if (unit) {
      // With several dollar quotes the range is one set of numbers applied to
      // every pair, so name them all rather than implying it's only the first.
      unit.textContent = this.selectedQuotes.length > 1
        ? this.selectedQuotes.join(' / ')
        : (this.selectedQuotes[0] || '');
    }

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
    // Seed off the pair that constrains the range hardest — the dearest market
    // for a sell, the cheapest for a buy. Stablecoin quotes sit a hair apart, and
    // seeding off whichever happened to be selected first can land a start price
    // that's already through another pair's market.
    const prices = this.selectedQuotes
      .map(quote => this.markets[`${this.base}/${quote}`]?.price || 0)
      .filter(price => price > 0);
    const anchor = prices.length === 0 ? market.price
      : this.wizardSide === 'sell' ? Math.max(...prices) : Math.min(...prices);

    this.startPrice = this.roundToTick(
      anchor * (1 + sign * this.startPct / 100), market.priceTick, 'round');
    this.endPrice = this.roundToTick(
      anchor * (1 + sign * this.endPct / 100), market.priceTick, 'round');

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
      const max = this.maxSteps();
      const pairs = Math.max(1, this.selectedQuotes.length);
      // The exchange's minimum order size usually bites long before the per-pair
      // cap does, so name whichever ceiling is actually in force.
      const afford = this.affordableSteps();
      const room = afford && afford.max < max
        ? `your balance covers up to ${Math.max(0, afford.max)} here`
        : `up to ${max} with ${pairs} pair${pairs === 1 ? '' : 's'} selected`;
      stepsHint.textContent = n > 0
        ? `${n} order${n === 1 ? '' : 's'}, ${this.estimateText(n)} to place — ${room}`
        : `Between 2 and ${max} — ${LimitOrdersController.PER_PAIR_STEPS} per selected pair`;
    }

    // Keep the spinner's own ceiling in step with the pair selection.
    const stepsInput = document.getElementById('limit-steps') as HTMLInputElement | null;
    if (stepsInput) stepsInput.max = String(this.maxSteps());

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
      const from = this.fmtNum(this.startPrice!, market.priceDecimals);
      const to = this.fmtNum(this.endPrice!, market.priceDecimals);
      const pairs = this.selectedQuotes.length;
      return `Steps spread between ${from} and ${to}`
        + (pairs > 1
          ? `, rotating through ${this.selectedQuotes.join(', ')} — the same range on each`
          : ` ${market.quote}`);
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

  /**
   * The rung nearest the market, which is the worst case for both sides: it is
   * the cheapest rung of a sell ladder (so it needs the most coins to clear a
   * minimum order VALUE) and the dearest of a buy ladder (so it costs the most
   * to clear a minimum order SIZE).
   */
  private nearestPriceFor(market: LegMarket): number {
    if (this.bandMode === 'price') return this.startPrice || 0;
    if (!(market.price > 0)) return 0;
    const sign = this.wizardSide === 'sell' ? 1 : -1;
    return market.price * (1 + sign * this.startPct / 100);
  }

  /**
   * The smallest amount one step can legally place, and WHICH limit says so.
   *
   * Exchanges publish two separate floors and a step has to clear both: a
   * minimum order size in the base coin, and a minimum order value in the quote.
   * They can disagree wildly — Kraken lets you sell 50,000 SHIB by size, but a
   * $10 value floor needs about 770,000 of them at current prices.
   *
   * Which one binds has to travel with the number. Reporting the larger figure
   * as though it were the size minimum contradicts what the exchange publishes
   * and sends people looking for a limit that doesn't exist.
   */
  private stepFloor(market: LegMarket, price: number): StepFloor {
    const bySize = market.minAmount > 0 ? market.minAmount : 0;
    const byValue = market.minCost > 0 && price > 0 ? market.minCost / price : 0;
    const value = byValue > bySize;
    return {
      amount: Math.max(bySize, byValue),
      source: value ? 'value' : 'size',
      minAmount: market.minAmount > 0 ? market.minAmount : 0,
      minAmountOverridden: market.minAmountOverridden,
      minCost: market.minCost > 0 ? market.minCost : 0,
      pair: market.symbol,
      base: market.base,
      quote: market.quote,
      price,
      priceDecimals: market.priceDecimals,
      amountDecimals: market.amountDecimals,
    };
  }

  /**
   * Both published limits, and which one is actually stopping you.
   *
   * Naming only the binding one invites exactly the wrong conclusion when it's
   * the value floor: converted into coins it looks like a size minimum that
   * contradicts the exchange's own published figure. Printing both — as the
   * exchange states them, in their own units — is what makes the number
   * checkable rather than something to argue with.
   */
  private stepFloorText(floor: StepFloor): string {
    const size = floor.minAmount > 0
      ? `${this.fmtNum(floor.minAmount, floor.amountDecimals)} ${floor.base} minimum order size`
        + `${floor.minAmountOverridden ? ' (set in Cyrus, not read from the exchange)' : ''}`
      : '';
    const value = floor.minCost > 0
      ? `${this.fmtMoney(floor.minCost, floor.quote)} minimum order value`
      : '';
    const converted = floor.source === 'value' && floor.price > 0
      ? ` — about ${this.fmtApproxAmount(floor.amount)} ${floor.base} at `
        + `${this.fmtNum(floor.price, floor.priceDecimals)}`
      : '';

    if (size && value) {
      return `${floor.pair} has a ${size} and a ${value}. The `
           + `${floor.source === 'value' ? 'value' : 'size'} one is stricter here${converted}`;
    }
    if (value) return `${floor.pair}'s ${value}${converted}`;
    return `${floor.pair}'s ${size}`;
  }

  /**
   * A converted floor, at a precision worth reading.
   *
   * This figure is an estimate that moves with the price, so eight decimals on
   * three quarters of a million coins is noise pretending to be precision.
   * Rounded UP, because understating a minimum is the one direction that would
   * make the advice wrong.
   */
  private fmtApproxAmount(value: number): string {
    const dp = value >= 1000 ? 0 : value >= 1 ? 2 : 8;
    const scale = 10 ** dp;
    return this.fmtNum(Math.ceil(value * scale) / scale, dp);
  }

  /**
   * How many steps the budget can actually pay for at those floors.
   *
   * Splitting a balance across more steps makes each one smaller, so past a
   * point every rung lands under the exchange's minimum and the whole ladder
   * comes back rejected. Catching that here turns a screen of red rows into one
   * number to change. Worked out for an even split; a leaned shape gives its
   * lightest step less than an even share, so it needs fewer still — which the
   * caller says out loud rather than silently assuming.
   */
  private affordableSteps(): { max: number; floor: StepFloor } | null {
    if (this.mode !== 'ladder' || this.selectedQuotes.length === 0) return null;

    if (this.wizardSide === 'sell') {
      const budget = this.available(this.base) * this.totalPct / 100;
      if (!(budget > 0)) return null;
      // Steps rotate through every selected pair, so the strictest market is the
      // one that decides.
      let binding: StepFloor | null = null;
      for (const quote of this.selectedQuotes) {
        const market = this.markets[`${this.base}/${quote}`];
        if (!market) continue;
        const floor = this.stepFloor(market, this.nearestPriceFor(market));
        if (!binding || floor.amount > binding.amount) binding = floor;
      }
      if (!binding || !(binding.amount > 0)) return null;
      return { max: Math.floor(budget / binding.amount), floor: binding };
    }

    // Buys hold a separate budget per quote asset, and rotation hands each quote
    // roughly the same number of steps — so the poorest quote caps the ladder.
    let worst = Infinity;
    let binding: StepFloor | null = null;
    for (const quote of this.selectedQuotes) {
      const market = this.markets[`${this.base}/${quote}`];
      if (!market) continue;
      const floor = this.stepFloor(market, this.nearestPriceFor(market));
      const spend = floor.amount * floor.price;
      const budget = this.available(quote) * this.totalPct / 100
                   * LimitOrdersController.BUY_FEE_HEADROOM;
      if (!(spend > 0) || !(budget > 0)) continue;
      const steps = Math.floor(budget / spend);
      if (steps < worst) { worst = steps; binding = floor; }
    }
    if (!Number.isFinite(worst) || !binding) return null;
    return { max: worst * this.selectedQuotes.length, floor: binding };
  }

  /**
   * Steps allowed right now: PER_PAIR_STEPS for every selected pair, held under
   * the absolute cap. Steps rotate through the pairs, so each pair selected adds
   * its own room on the exchange rather than crowding the same book.
   */
  private maxSteps(): number {
    const pairs = Math.max(1, this.selectedQuotes.length);
    return Math.min(LimitOrdersController.MAX_STEPS,
                    LimitOrdersController.PER_PAIR_STEPS * pairs);
  }

  private validateLadderParams(): string | null {
    const max = this.maxSteps();
    if (!Number.isInteger(this.stepCount) || this.stepCount < 2 || this.stepCount > max) {
      const pairs = Math.max(1, this.selectedQuotes.length);
      return `Number of steps must be a whole number between 2 and ${max} — that's `
           + `${LimitOrdersController.PER_PAIR_STEPS} per selected pair, and you have `
           + `${pairs} selected${max === LimitOrdersController.MAX_STEPS
               ? ` (${LimitOrdersController.MAX_STEPS} is the overall limit)` : ''}. `
           + 'Select another pair for more room.';
    }
    const bandProblem = this.bandMode === 'price'
      ? this.validatePriceBand() : this.validatePercentBand();
    if (bandProblem) return bandProblem;

    if (!(this.totalPct > 0) || this.totalPct > 100) {
      return 'Total to use must be between 0 and 100%.';
    }

    // Caught here rather than as a table full of rejected rows: past this point
    // every step is under the exchange's floor, and no amount of editing
    // individual rows fixes it — the step count or the budget has to change.
    const afford = this.affordableSteps();
    if (afford && this.stepCount > afford.max) {
      const shape = this.distIsEven() ? '' :
        ' A leaned shape needs fewer still, since its lightest step gets less than an even share.';
      return afford.max < 2
        ? `${this.stepFloorText(afford.floor)}, and the balance you've set aside can't cover `
          + 'even two steps that size. Raise "Total to use", or place a single order '
          + 'instead of a ladder.'
        : `Splitting this across ${this.stepCount} steps puts each one under the minimum: `
          + `${this.stepFloorText(afford.floor)}. Use at most ${afford.max} `
          + `step${afford.max === 1 ? '' : 's'}, or raise "Total to use".${shape}`;
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

  /** Selected quotes the backend does NOT consider dollar-priced. */
  private nonDollarQuotes(): string[] {
    return this.selectedQuotes.filter(
      quote => !this.markets[`${this.base}/${quote}`]?.stableQuote);
  }

  private validatePriceBand(): string | null {
    // An absolute range only means the same thing across pairs quoted in
    // comparable money. USD, USDT and USDC are all dollars, so 100–120 is the
    // same ladder on each and rotating across them is exactly what this is for.
    // A BTC- or EUR-quoted pair in the same selection is not: "100" would be
    // three different orders, and one of them would be nonsense.
    const offbeat = this.nonDollarQuotes();
    if (this.selectedQuotes.length > 1 && offbeat.length > 0) {
      const isAre = offbeat.length === 1 ? 'is' : 'are';
      return `Exact prices need every selected pair priced in comparable money. `
           + `${offbeat.join(', ')} ${isAre} not dollar-priced, so one price range cannot `
           + `cover ${this.selectedQuotes.join(', ')}. Deselect `
           + `${offbeat.length === 1 ? 'it' : 'them'}, or switch back to "% from market".`;
    }
    if (!(this.startPrice! > 0) || !(this.endPrice! > 0)) {
      return 'Enter both ends of the price range.';
    }
    if (this.startPrice === this.endPrice) {
      return 'The two ends of the range have to differ, or every step lands on one price.';
    }

    // "start" is the end nearest the market, so a sell ladder runs upward and a
    // buy ladder downward. Getting this backwards would invert the ladder.
    if (this.wizardSide === 'sell' && this.endPrice! <= this.startPrice!) {
      return 'For a sell ladder the second price must be higher than the first — '
           + 'the range runs away from the market, upward.';
    }
    if (this.wizardSide === 'buy' && this.endPrice! >= this.startPrice!) {
      return 'For a buy ladder the second price must be lower than the first — '
           + 'the range runs away from the market, downward.';
    }

    // Checked against EVERY selected pair, not just the first. Dollar
    // stablecoins track each other closely but never exactly, so a near end that
    // rests clear of BTC/USD can still be through BTC/USDT — and those legs
    // would take instead of rest.
    for (const quote of this.selectedQuotes) {
      const symbol = `${this.base}/${quote}`;
      const market = this.markets[symbol];
      if (!market) return `No ${symbol} market on this exchange.`;
      if (!(market.price > 0)) continue;

      const through = this.wizardSide === 'sell'
        ? this.startPrice! <= market.price
        : this.startPrice! >= market.price;
      if (through) {
        return `A ${this.wizardSide} at ${this.fmtNum(this.startPrice!, market.priceDecimals)} is `
             + `at or ${this.wizardSide === 'sell' ? 'below' : 'above'} the current `
             + `${this.fmtNum(market.price, market.priceDecimals)} ${symbol} market price, so `
             + `${this.selectedQuotes.length > 1 ? `the ${quote} steps would` : 'it would'} `
             + 'fill immediately instead of resting.';
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

    // Exact-price mode slices the absolute range directly, by global step index.
    // With several dollar-quoted pairs selected the rotation interleaves them
    // through that one range — USDT takes slices 0, 3, 6…, USDC 1, 4, 7… — so
    // each pair's own rungs stay in order and the combined ladder covers the
    // range evenly. validatePriceBand() is what guarantees the pairs are priced
    // in comparable money before any of this means anything.
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
   * Share the budget across the steps according to the distribution shape.
   *
   * Sell: one base-asset budget shared by every step.
   * Buy:  a budget PER QUOTE ASSET — USDT and USDC are different money, so each
   *       quote's own balance is divided among only the steps rotated onto it,
   *       and the shape is renormalised inside that group.
   *
   * The weights sum to 1 and everything floors to the amount tick, so the total
   * is always within budget however the ladder is leaned. At the default shape
   * every weight is identical, which is the plain even split.
   */
  private splitAmounts(): void {
    const weights = this.distWeights(this.legs.length);

    if (this.wizardSide === 'sell') {
      const budget = this.available(this.base) * this.totalPct / 100;
      this.legs.forEach((leg, i) => {
        const market = this.markets[leg.pair];
        leg.amount = market
          ? this.roundToTick(budget * weights[i], market.amountTick, 'floor')
          : null;
      });
      return;
    }

    const weightByQuote: Record<string, number> = {};
    this.legs.forEach((leg, i) => {
      const quote = leg.pair.split('/')[1];
      weightByQuote[quote] = (weightByQuote[quote] || 0) + weights[i];
    });
    this.legs.forEach((leg, i) => {
      const market = this.markets[leg.pair];
      if (!market || !(leg.price! > 0)) { leg.amount = null; return; }
      const budget = this.available(market.quote) * this.totalPct / 100
                   * LimitOrdersController.BUY_FEE_HEADROOM;
      const group = weightByQuote[market.quote] || 0;
      const spendHere = group > 0 ? budget * (weights[i] / group) : 0;
      leg.amount = this.roundToTick(spendHere / leg.price!, market.amountTick, 'floor');
    });
  }

  // ---------------------------------------------------------------------------
  // Create wizard — volume distribution
  //
  // Drawn the way an order book is: price down the side, volume across. That
  // makes the market price a line on the axis rather than something you have to
  // infer, and it makes the drag handle a PRICE level — the one thing a ladder
  // is really about — instead of an abstract position along a band.
  // ---------------------------------------------------------------------------

  private clampLean(value: number): number {
    return Math.min(1, Math.max(0, value));
  }

  private clampShape(value: number): number {
    return Math.min(1, Math.max(-1, value));
  }

  private distIsEven(): boolean {
    return Math.abs(this.distShape) < LimitOrdersController.DIST_FLAT_EPSILON;
  }

  /**
   * The share of the budget each step gets, summing to 1.
   *
   * Weight decays exponentially with a step's distance from `distLean`, so a
   * positive shape piles volume up around the lean and a negative one hollows it
   * out toward both ends. Shape 0 makes every exponent 0, so every weight is 1 —
   * the even split, exactly as before this control existed.
   */
  private distWeights(count: number): number[] {
    const n = Math.max(1, count);
    if (n === 1) return [1];
    const raw: number[] = [];
    for (let i = 0; i < n; i++) {
      // Bar centres, so the first and last steps sit inside the band rather than
      // on its edges — otherwise a lean of 0 could only ever be reached by the
      // first step and the control would feel like it ran out of travel early.
      const x = (i + 0.5) / n;
      raw.push(Math.exp(-LimitOrdersController.DIST_SHARPNESS * this.distShape
                        * Math.abs(x - this.distLean)));
    }
    const sum = raw.reduce((total, w) => total + w, 0);
    return sum > 0 ? raw.map(w => w / sum) : raw.map(() => 1 / n);
  }

  /**
   * What a bar measures.
   *
   * A sell commits coins, so the bars are base amount. A buy commits money, and
   * its amount is spend/price — so plotting amount would draw an even-money buy
   * ladder as a rising ramp, purely because the cheaper rungs buy more coins.
   * Spend is the quantity the user actually chose, so spend is what's drawn.
   */
  private legMetric(leg: LimitLeg): number {
    const amount = leg.amount || 0;
    return this.wizardSide === 'sell' ? amount : amount * (leg.price || 0);
  }

  /** Reads as the tail of "what that step commits — …". */
  private distMetricLabel(): string {
    if (this.wizardSide === 'sell') return `${this.base} sold`;
    const quotes = Array.from(new Set(this.legs.map(leg => leg.pair.split('/')[1])));
    return quotes.length === 1
      ? `${quotes[0]} spent`
      : "spend, in each pair's own quote currency";
  }

  /**
   * Set when the bars are measured in currencies that can't share a scale.
   *
   * A buy ladder rotating across USDT and USDC is fine — both are dollars. One
   * rotating across USDT and BTC is not, and saying so is better than drawing a
   * BTC bar next to a USDT bar as if the lengths meant the same thing.
   */
  private distMetricWarning(): string {
    if (this.wizardSide !== 'buy') return '';
    const quotes = Array.from(new Set(this.legs.map(leg => leg.pair.split('/')[1])));
    if (quotes.length <= 1) return '';
    const allStable = quotes.every(q => this.markets[`${this.base}/${q}`]?.stableQuote);
    if (allStable) return '';
    return `Bars measure the spend on each step, but ${quotes.join(', ')} are different `
         + 'currencies — compare lengths within one currency, not across them. The table '
         + 'below gives each step its own figure.';
  }

  /** A leg's signed distance from its own pair's market price, in percent. */
  private legOffsetPct(leg: LimitLeg): number | null {
    const market = this.markets[leg.pair];
    if (!market || !(market.price > 0) || leg.price == null) return null;
    return (leg.price / market.price - 1) * 100;
  }

  /**
   * The vertical scale for the ladder plot.
   *
   * Measured in percent from the market rather than in price, because a ladder
   * can rotate across pairs quoted in different currencies and only the
   * percentage is comparable between them. Higher price is always up, so the
   * market line lands at the bottom for a sell and the top for a buy — which is
   * the fastest read there is of which way the ladder runs.
   *
   * `priced` false means no pair could be priced: the rows fall back to even
   * spacing by step and the market line is left off rather than invented.
   */
  private distAxis(): { priced: boolean; span: number; marketFrac: number } {
    const offsets = this.legs.map(leg => this.legOffsetPct(leg))
      .filter((o): o is number => o != null);
    if (offsets.length === 0) {
      return { priced: false, span: 0, marketFrac: this.wizardSide === 'sell' ? 0 : 1 };
    }
    const span = Math.max(...offsets.map(Math.abs))
               * LimitOrdersController.DIST_AXIS_PAD || 1;
    return { priced: true, span, marketFrac: this.wizardSide === 'sell' ? 0 : 1 };
  }

  /** Where a given offset sits on the axis: 0 at the bottom, 1 at the top. */
  private distFracFor(offsetPct: number, span: number): number {
    if (!(span > 0)) return 0.5;
    const frac = this.wizardSide === 'sell'
      ? offsetPct / span               // sells run up from the market at the bottom
      : 1 - Math.abs(offsetPct) / span; // buys run down from the market at the top
    return Math.min(1, Math.max(0, frac));
  }

  /**
   * The row the running total crosses halfway at — the median.
   *
   * Taken from the values actually plotted rather than from the weights, so the
   * line still marks the real middle of the volume after a hand edit in the
   * table, and after the per-quote renormalisation a buy ladder goes through.
   * Rows must be in near-to-far order.
   */
  private distMedianIndex(values: number[]): number {
    const total = values.reduce((sum, v) => sum + v, 0);
    if (!(total > 0)) return Math.floor(values.length / 2);
    let running = 0;
    for (let i = 0; i < values.length; i++) {
      running += values[i];
      if (running >= total / 2) return i;
    }
    return values.length - 1;
  }

  /** Share of the total sitting in the half of the band nearest the market. */
  private distNearShare(values: number[]): number {
    const total = values.reduce((sum, v) => sum + v, 0);
    if (!(total > 0)) return 0.5;
    const n = values.length;
    let near = 0;
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) / n;
      // An odd count leaves one row straddling the midpoint; split it evenly
      // rather than handing the whole thing to one side.
      if (x < 0.5) near += values[i];
      else if (x === 0.5) near += values[i] / 2;
    }
    return near / total;
  }

  // ── Shared plot drawing ───────────────────────────────────────────────────

  private distRowsHtml(rows: DistRow[], heightPct: number): string {
    const max = Math.max(...rows.map(r => r.value), 0);
    return rows.map(row => {
      const width = max > 0 ? row.value / max * 100 : 0;
      return `<span class="limit-dist-row${row.bad ? ' is-bad' : ''}"`
        + ` style="bottom:${(row.frac * 100).toFixed(3)}%;`
        + `height:${heightPct.toFixed(3)}%;width:${Math.max(0, width).toFixed(2)}%"`
        + ` title="${this.escapeAttr(row.title)}"></span>`;
    }).join('');
  }

  /** Tick labels down the side of a plot. `label` renders one for a given frac. */
  private distAxisHtml(fracs: number[], label: (frac: number) => string): string {
    return fracs.map(frac =>
      `<span class="limit-dist-tick" style="bottom:${(frac * 100).toFixed(3)}%">`
      + `${this.escapeHtml(label(frac))}</span>`).join('');
  }

  private placeMarketLine(id: string, labelId: string, frac: number | null, text: string): void {
    const line = document.getElementById(id);
    if (!line) return;
    line.classList.toggle('d-none', frac == null);
    if (frac == null) return;
    line.style.bottom = `${(Math.min(1, Math.max(0, frac)) * 100).toFixed(3)}%`;
    this.setText(labelId, text);
  }

  // ── The ladder plot ───────────────────────────────────────────────────────

  private renderDist(): void {
    const host = document.getElementById('limit-dist');
    const bars = document.getElementById('limit-dist-bars');
    if (!host || !bars) return;

    // A single order has no distribution, and neither does a one-rung ladder.
    const show = this.mode === 'ladder' && this.legs.length > 1;
    host.classList.toggle('d-none', !show);
    if (!show) return;

    const n = this.legs.length;
    const axis = this.distAxis();
    const values = this.legs.map(leg => this.legMetric(leg));
    const badCount = this.legs.filter(leg => this.legProblem(leg) !== null).length;

    const rows: DistRow[] = this.legs.map((leg, i) => {
      const market = this.markets[leg.pair];
      const offset = this.legOffsetPct(leg);
      const problem = this.legProblem(leg);
      return {
        // Without a price to measure from, fall back to even spacing by step.
        frac: axis.priced && offset != null
          ? this.distFracFor(offset, axis.span)
          : (this.wizardSide === 'sell' ? (i + 0.5) / n : 1 - (i + 0.5) / n),
        value: values[i],
        bad: problem !== null,
        title: [
          `Step ${i + 1} of ${n} · ${leg.pair}`,
          leg.price == null ? 'No price yet'
            : `Price ${this.fmtNum(leg.price, market ? market.priceDecimals : 8)}`
              + ` (${this.legOffsetText(leg)} from market)`,
          `Amount ${this.fmtNum(leg.amount || 0, market ? market.amountDecimals : 8)} ${this.base}`,
          `Est. total ${this.legTotalText(leg)}`,
          problem || '',
        ].filter(Boolean).join('\n'),
      };
    });

    const plot = document.getElementById('limit-dist-plot');
    plot?.classList.toggle('is-sell', this.wizardSide === 'sell');
    plot?.classList.toggle('is-buy', this.wizardSide === 'buy');

    const heightPct = Math.min(LimitOrdersController.DIST_MAX_ROW_PCT,
                               LimitOrdersController.DIST_ROW_FILL / n);
    bars.innerHTML = this.distRowsHtml(rows, heightPct);

    this.renderDistAxis(axis);
    this.placeMarketLine('limit-dist-market', 'limit-dist-market-label',
                         axis.priced ? axis.marketFrac : null, this.marketLineText());
    this.placeDistHandle(rows, values);
    this.renderDistReadback(values, badCount, axis);
    this.syncDistControls();
  }

  private marketLineText(): string {
    const quotes = Array.from(new Set(this.selectedQuotes));
    if (quotes.length === 1) {
      const market = this.markets[`${this.base}/${quotes[0]}`];
      if (market && market.price > 0) {
        return `Market ${this.fmtNum(market.price, market.priceDecimals)} ${market.quote}`;
      }
    }
    return 'Market price';
  }

  private renderDistAxis(axis: { priced: boolean; span: number }): void {
    const host = document.getElementById('limit-dist-yaxis');
    if (!host) return;
    if (!axis.priced) {
      host.innerHTML = this.distAxisHtml([0, 1], frac =>
        frac === (this.wizardSide === 'sell' ? 0 : 1) ? 'nearest' : 'furthest');
      return;
    }
    // Percent from the market, not price: a ladder can rotate across pairs quoted
    // in different currencies, and only the percentage means the same on each.
    // Three ticks, not five — the market line already labels the near end, and the
    // hover text carries every exact figure.
    const sign = this.wizardSide === 'sell' ? 1 : -1;
    host.innerHTML = this.distAxisHtml([0, 0.5, 1], frac => {
      const distance = this.wizardSide === 'sell' ? frac : 1 - frac;
      const pct = sign * distance * axis.span;
      return `${pct > 0 ? '+' : ''}${pct.toFixed(pct === 0 ? 0 : 1)}%`;
    });
  }

  /**
   * Sit the line on the median row.
   *
   * It is placed from the plotted values, not from the drag position, so it can
   * never claim a level the bars don't show — including mid-drag, where it is
   * the bars that the pointer is really steering.
   */
  private placeDistHandle(rows: DistRow[], values: number[]): void {
    const handle = document.getElementById('limit-dist-handle');
    if (!handle) return;
    const median = this.distMedianIndex(values);
    const row = rows[median];

    handle.style.bottom = `${((row ? row.frac : 0.5) * 100).toFixed(3)}%`;
    handle.setAttribute('aria-valuemin', '1');
    handle.setAttribute('aria-valuemax', String(rows.length));
    handle.setAttribute('aria-valuenow', String(median + 1));
    handle.setAttribute('aria-valuetext',
      `Half the volume rests at step ${median + 1} of ${rows.length} or nearer the market.`);

    const leg = this.legs[median];
    const market = leg ? this.markets[leg.pair] : undefined;
    this.setText('limit-dist-grip-tag', leg && leg.price != null && market
      ? `${this.fmtNum(leg.price, market.priceDecimals)} ${market.quote}`
      : `Step ${median + 1}`);
  }

  private renderDistReadback(values: number[], bad: number,
                             axis: { priced: boolean; span: number }): void {
    const n = values.length;
    const median = this.distMedianIndex(values);
    const nearPct = Math.round(this.distNearShare(values) * 100);
    const parts: string[] = [];

    if (this.distIsEven()) {
      parts.push(`Even split — ${n} steps, the same ${this.wizardSide === 'sell'
        ? 'amount' : 'spend'} on each`);
    } else {
      const offset = this.legs[median] ? this.legOffsetPct(this.legs[median]) : null;
      parts.push(axis.priced && offset != null
        ? `Half the volume rests within ${Math.abs(offset).toFixed(1)}% of the market`
        : `Heaviest at step ${median + 1} of ${n}`);
      parts.push(`${nearPct}% in the near half of the band`);
    }
    if (bad > 0) {
      parts.push(`${bad} step${bad === 1 ? '' : 's'} unplaceable at this shape`);
    }
    this.setText('limit-dist-readback', parts.join(' · '));
    this.setText('limit-dist-metric', this.distMetricLabel());
    // The panel is shut by default, so the summary has to say whether anything in
    // there is doing something — otherwise a leaned ladder looks like an even one.
    this.setText('limit-dist-state', this.distStateLabel());

    const note = document.getElementById('limit-dist-note');
    if (note) {
      const warning = this.distMetricWarning();
      note.textContent = warning;
      note.classList.toggle('d-none', warning === '');
    }
  }

  /** Plain-language shape, for the collapsed summary. */
  private distStateLabel(): string {
    if (this.distIsEven()) return 'Even split';
    if (this.distShape < 0) return 'Weighted to both ends';
    if (this.distLean <= 0.25) return 'Weighted near the market';
    if (this.distLean >= 0.75) return 'Weighted far from the market';
    return 'Weighted to the middle of the band';
  }

  /** Push the current shape back into the chips and the slider. */
  private syncDistControls(): void {
    const presets = LimitOrdersController.DIST_PRESETS;
    const active = Object.keys(presets).find(name => {
      const preset = presets[name];
      // Lean is irrelevant once the shape is flat — every step weighs the same.
      const leanMatches = Math.abs(preset.shape) < LimitOrdersController.DIST_FLAT_EPSILON
        || Math.abs(preset.lean - this.distLean) < 0.02;
      return leanMatches && Math.abs(preset.shape - this.distShape) < 0.02;
    });
    document.querySelectorAll('#limit-dist-shapes [data-preset]').forEach(chip => {
      chip.classList.toggle('active', chip.getAttribute('data-preset') === active);
    });

    const slider = document.getElementById('limit-dist-shape') as HTMLInputElement | null;
    if (slider && document.activeElement !== slider) {
      slider.value = String(Math.round(this.distShape * 100));
    }
  }

  // ── Controls ──────────────────────────────────────────────────────────────

  private bindDist(): void {
    const handle = document.getElementById('limit-dist-handle');
    const plot = document.getElementById('limit-dist-plot');
    if (!handle || !plot) return;

    handle.addEventListener('pointerdown', (e) => {
      const rect = plot.getBoundingClientRect();
      this.distDrag = {
        pointerId: e.pointerId,
        y: e.clientY,
        lean: this.distLean, shape: this.distShape,
        height: rect.height || 1,
        moved: false,
      };
      handle.classList.add('is-dragging');
      // Capture on the handle: the rows underneath are re-rendered on every
      // frame, so a pointer that wandered onto one would lose its target.
      try { handle.setPointerCapture(e.pointerId); } catch {}
      handle.focus();
      e.preventDefault();
    });

    handle.addEventListener('pointermove', (e) => {
      const drag = this.distDrag;
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dy = e.clientY - drag.y;
      // A few pixels of slop, so a click on the handle isn't a shape change.
      if (!drag.moved && Math.abs(dy) < 3) return;
      if (!drag.moved) {
        drag.moved = true;
        if (Math.abs(drag.shape) < LimitOrdersController.DIST_FLAT_EPSILON) {
          drag.shape = LimitOrdersController.DIST_SEED_SHAPE;
          this.distShape = drag.shape;
        }
      }
      // Vertical only, and as a delta from where the drag started: the line's
      // height is the median row's, which has no fixed mapping to a lean value,
      // so an absolute mapping would make it jump on grab.
      this.distLean = this.clampLean(drag.lean + this.distDragDelta(dy) / drag.height);
      this.queueRedistribute();
    });

    const endDrag = (e: PointerEvent) => {
      if (!this.distDrag || e.pointerId !== this.distDrag.pointerId) return;
      const moved = this.distDrag.moved;
      this.distDrag = null;
      handle.classList.remove('is-dragging');
      // Whatever the live path skipped for speed is caught up here.
      if (moved) this.flushRedistribute();
    };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
    handle.addEventListener('keydown', (e) => this.onDistKey(e));

    document.getElementById('limit-dist-shapes')?.addEventListener('click', (e) => {
      const chip = (e.target as HTMLElement).closest('[data-preset]') as HTMLElement | null;
      const preset = LimitOrdersController.DIST_PRESETS[chip?.getAttribute('data-preset') || ''];
      if (!preset) return;
      this.distLean = preset.lean;
      this.distShape = preset.shape;
      this.redistribute(true);
    });

    const slider = document.getElementById('limit-dist-shape') as HTMLInputElement | null;
    slider?.addEventListener('input', () => {
      this.distShape = this.clampShape(parseFloat(slider.value) / 100);
      // Same coalescing as the drag — `input` on a range fires just as fast.
      this.queueRedistribute();
    });
    slider?.addEventListener('change', () => this.flushRedistribute());
  }

  /**
   * Pointer travel to lean travel. Higher price is always up, so "further from
   * the market" is up for a sell ladder and down for a buy one — the drag has to
   * follow the picture, not a fixed direction.
   */
  private distDragDelta(dy: number): number {
    return this.wizardSide === 'sell' ? -dy : dy;
  }

  private onDistKey(e: KeyboardEvent): void {
    const step = 1 / Math.max(1, this.legs.length);
    const away = this.wizardSide === 'sell' ? 'ArrowUp' : 'ArrowDown';
    let handled = true;

    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown': {
        // Same reasoning as the drag: an even split has no median to move.
        if (this.distIsEven()) this.distShape = LimitOrdersController.DIST_SEED_SHAPE;
        this.distLean = this.clampLean(
          this.distLean + (e.key === away ? step : -step));
        break;
      }
      case 'Home':
      case 'End':
        this.distLean = 0.5;
        this.distShape = 0;
        break;
      default:
        handled = false;
    }
    if (!handled) return;
    e.preventDefault();
    this.redistribute(true);
  }

  /**
   * Coalesce a drag to one recompute per frame. Pointermove fires far faster
   * than the ladder can be re-split and redrawn.
   */
  private queueRedistribute(): void {
    if (this.distRaf) return;
    this.distRaf = window.requestAnimationFrame(() => {
      this.distRaf = 0;
      this.redistribute(this.legs.length <= LimitOrdersController.DIST_LIVE_ROW_LIMIT);
    });
  }

  private flushRedistribute(): void {
    if (this.distRaf) {
      window.cancelAnimationFrame(this.distRaf);
      this.distRaf = 0;
    }
    this.redistribute(true);
  }

  /**
   * Re-split the budget and show the result. `rows` off leaves the legs table
   * alone for a frame — see DIST_LIVE_ROW_LIMIT.
   */
  private redistribute(rows: boolean): void {
    this.splitAmounts();
    if (rows) for (const leg of this.legs) this.updateLegRow(leg);
    // Errors don't scroll the modal here: an invalid shape mid-drag would yank
    // the plot out from under the pointer.
    this.renderTotals(false);
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
      return `${leg.pair} prices move in ${this.fmtTick(market.priceTick)} increments.`;
    }
    if (!this.isOnTick(leg.amount!, market.amountTick)) {
      return `${leg.pair} amounts move in ${this.fmtTick(market.amountTick)} increments.`;
    }
    // "order size" / "order value" rather than a bare "minimum" on both: the two
    // limits are separate, published separately, and can differ by an order of
    // magnitude, so a message has to say which one it means.
    if (market.minAmount > 0 && leg.amount! < market.minAmount) {
      return `${this.fmtNum(leg.amount!, market.amountDecimals)} ${market.base} is below `
           + `${leg.pair}'s minimum order size of `
           + `${this.fmtNum(market.minAmount, market.amountDecimals)} ${market.base}`
           + `${market.minAmountOverridden ? ' (set in Cyrus)' : ''}.`;
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

    // Deliberately a count rather than the first problem: renderLegProblems()
    // spells out every reason next to the rows they belong to, and naming just
    // one of several here made the other red rows look unexplained.
    const bad = this.legs.filter(leg => this.legProblem(leg) !== null).length;
    if (bad > 0) {
      return `${bad} step${bad === 1 ? '' : 's'} cannot be placed as set — see the `
           + 'reasons listed under the table.';
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

  /**
   * Say why the outlined inputs are outlined.
   *
   * A red border on a row means legProblem() rejected it, and one shape change can
   * redden a dozen rows for two or three different reasons at once. Problems are
   * grouped by reason with their step numbers, so the fix is obvious without
   * clicking through every red field to find out what each one wants.
   */
  private renderLegProblems(): void {
    const host = document.getElementById('limit-legs-problems');
    if (!host) return;

    const groups = new Map<string, number[]>();
    this.legs.forEach((leg, i) => {
      const problem = this.legProblem(leg);
      if (!problem) return;
      const steps = groups.get(problem) || [];
      steps.push(i + 1);
      groups.set(problem, steps);
    });

    if (groups.size === 0) {
      host.classList.add('d-none');
      host.innerHTML = '';
      return;
    }

    const total = Array.from(groups.values()).reduce((sum, steps) => sum + steps.length, 0);
    const one = total === 1;
    host.classList.remove('d-none');
    host.innerHTML =
      `<p class="limit-legs-problems-head">`
      + `<i class="fa-solid fa-circle-exclamation"></i>`
      + `<span><strong>${total} step${one ? '' : 's'} outlined in red</strong> — `
      + `${one ? 'it' : 'they'} cannot be placed as set. Edit the price or amount, or `
      + `remove the step${one ? '' : 's'} with the &times; button. Nothing is sent until `
      + `every step is valid.</span></p>`
      + `<ul class="limit-legs-problems-list">`
      + Array.from(groups.entries()).map(([problem, steps]) =>
          `<li><span class="limit-legs-problems-steps">Step${steps.length === 1 ? '' : 's'} `
          + `${this.escapeHtml(this.formatStepList(steps))}</span>`
          + `<span>${this.escapeHtml(problem)}</span></li>`).join('')
      + `</ul>`
      + this.legProblemsAdvice();
  }

  /**
   * The one fix that actually helps when the reason is an exchange minimum.
   *
   * Editing a red row can't solve "the balance divided this many ways is too
   * small" — the count, the budget or the shape has to change. Step 2 blocks the
   * even-split case, but a lean applied afterwards starves its lightest steps, so
   * the same advice has to exist here.
   */
  private legProblemsAdvice(): string {
    const afford = this.affordableSteps();
    if (!afford || afford.max >= this.legs.length) {
      return this.distIsEven() ? '' :
        `<p class="limit-legs-problems-tip">Leaning the ladder gives its lightest steps a `
        + `smaller share, which can push them under the exchange's minimum. `
        + `<strong>Even split</strong> in Advanced puts them back.</p>`;
    }
    return `<p class="limit-legs-problems-tip">`
      + `${this.escapeHtml(this.stepFloorText(afford.floor))}, so this balance stretches to `
      + `about <strong>${Math.max(0, afford.max)} step${afford.max === 1 ? '' : 's'}</strong>, `
      + `not ${this.legs.length}. Go back and lower the step count, raise "Total to use", or `
      + `remove the steps that fall short.</p>`;
  }

  /**
   * "6–8, 12" rather than "6, 7, 8, 12".
   *
   * A hard lean on a long ladder can invalidate a run of forty consecutive steps,
   * and forty comma-separated numbers is not a sentence anybody reads.
   */
  private formatStepList(steps: number[]): string {
    const runs: string[] = [];
    let start = steps[0];
    let prev = steps[0];
    for (const step of steps.slice(1)) {
      if (step === prev + 1) { prev = step; continue; }
      runs.push(start === prev ? String(start) : `${start}–${prev}`);
      start = prev = step;
    }
    runs.push(start === prev ? String(start) : `${start}–${prev}`);
    // Scattered single steps can still make a long list; cap the tail.
    return runs.length > 6
      ? `${runs.slice(0, 6).join(', ')} and ${runs.length - 6} more`
      : runs.join(', ');
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

  /**
   * `scrollToError` off suppresses the scroll-into-view on the alert. A drag of
   * the distribution line calls this on every frame, and scrolling the modal body
   * each time would fight the pointer.
   */
  private renderTotals(scrollToError = true): void {
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
    if (problem) this.showModalError(problem, scrollToError); else this.hideModalError();

    this.renderLegProblems();
    this.renderEstimate();
    this.renderDist();
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

  private setText(id: string, text: string): void {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

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

  private showModalError(message: string, scroll = true): void {
    const el = this.modalErrorEl();
    if (!el) return;
    el.textContent = message;
    el.classList.remove('d-none');
    // The wizard body scrolls, so the alert can sit below the fold on step 3.
    if (scroll) {
      try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch {}
    }
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
