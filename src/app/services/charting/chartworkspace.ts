/*
 * Charts page: one interactive chart. Owns the lightweight-charts instance,
 * its stacked panes (one per compared symbol, plus a pane per oscillator),
 * the candle data (loaded per source/symbol/timeframe, paged back as you
 * scroll left, polled for the live bar), indicators, the drawing layers, and
 * the HTML pane headers. Used by the Charts page ('edit') and the Overview's
 * Chart widget ('view').
 */

interface ChartWorkspaceOptions {
  mode: 'edit' | 'view';
  /** Something the user would want saved changed (not pan/zoom). */
  onChange?: () => void;
  /** A pane header button the page handles (symbol picker, indicator menu). */
  onPaneAction?: (paneId: string, action: 'symbol' | 'indicators', anchor: HTMLElement) => void;
  /** A script indicator's chip button: open it in the Pine Editor, or add an alert. */
  onScriptAction?: (action: 'edit' | 'alert', paneId: string, indId: string, anchor: HTMLElement) => void;
}

/** A Pine Script indicator on the chart: its compiled script, last run and drawing objects. */
interface ScriptRuntime {
  compiled: PineCompiled | null;
  /** Why it isn't drawing (compile/run error, missing script). */
  error: string | null;
  /** A price overlay sitting out % compare mode. */
  off: boolean;
  result: PineRunResult | null;
  /** The bars `result` is indexed by. */
  bars: ChartBar[];
  /** Invisible series on the script's pane: hosts the primitive, markers and autoscale. */
  anchor: any;
  /** Output key → series, created once the first run says what to draw. */
  plots: Map<string, any>;
  /** Output key → the style a series was created with (recreated if it changes). */
  plotKinds: Map<string, string>;
  primitive: ScriptPanePrimitive | null;
  markers: any | null;
  tableEls: HTMLElement[];
}

/** Scripts run over at most this many of the newest bars. */
const CHART_SCRIPT_MAX_BARS = 5000;

interface CandleSet {
  bars: ChartBar[];
  hasMore: boolean;
  loaded: boolean;
  loading: Promise<void> | null;
  olderLoading: boolean;
  error: string | null;
}

interface IndicatorRuntime {
  spec: ChartIndicatorSpec;
  def: IndicatorDef;
  series: Map<string, any>;
  /** The chart pane it draws in (its parent's for overlays). */
  paneIndex: number;
  headerEl: HTMLElement | null;
  /** Set for a volume profile, which paints itself instead of using series. */
  primitive?: VisibleProfilePrimitive;
  /** Set for a Pine Script indicator. */
  script?: ScriptRuntime;
}

interface PaneRuntime {
  st: ChartPaneState;
  key: string;
  paneIndex: number;
  /** Position among the symbol panes; 0 is the primary symbol. */
  order: number;
  /** Plotted as a line (line/area chart, or a coin overlaid in % mode). */
  isLine: boolean;
  color: string | null;
  main: any;
  volume: any | null;
  indicators: IndicatorRuntime[];
  primitive: PaneDrawingsPrimitive;
  headerEl: HTMLElement;
  /** Order and average-cost price lines currently drawn on this pane. */
  mineLines: any[];
  markers: any | null;
}

/** The user's own trading in one coin, as the chart overlays it. */
interface MineData {
  at: number;
  fills: ChartFill[];
  avg: ChartAvgCost | null;
}

/** Quotes that all count as dollars when matching orders and fills to a pane. */
const CHART_DOLLAR_QUOTES = new Set(['USD', 'ZUSD', 'USDT', 'USDC', 'USDG', 'USDS', 'RLUSD', 'PYUSD', 'DAI', 'FDUSD', 'TUSD', 'USDP', 'GUSD', 'BUSD']);
const CHART_MINE_TTL = 5 * 60_000;

const CHART_MAX_PANES = 4;
const CHART_POLL_MS = 15_000;

class ChartWorkspace {
  private static sourcesCache: ChartSource[] | null = null;
  /** Fills and average cost per coin, shared by every chart on screen. */
  private static mineCache = new Map<string, MineData>();
  private static minePending = new Map<string, Promise<void>>();
  private static sourcesPromise: Promise<ChartSource[]> | null = null;

  /** The public candle feeds, fetched once per session. */
  static async loadSources(): Promise<ChartSource[]> {
    if (ChartWorkspace.sourcesCache) return ChartWorkspace.sourcesCache;
    if (!ChartWorkspace.sourcesPromise) {
      ChartWorkspace.sourcesPromise = (async () => {
        const token = AuthController.getToken() || '';
        try {
          const resp = await MarketData.getChartSources(token);
          ChartWorkspace.sourcesCache = resp.data || [];
        } catch {
          ChartWorkspace.sourcesCache = [
            { id: 'coinbase', name: 'Coinbase', kind: 'crypto', can_page: true, max_limit: 300, timeframes: ChartGeo.TIMEFRAMES },
            { id: 'kraken', name: 'Kraken', kind: 'crypto', can_page: false, max_limit: 720, timeframes: ChartGeo.TIMEFRAMES },
          ];
        }
        ChartWorkspace.sourcesPromise = null;
        return ChartWorkspace.sourcesCache;
      })();
    }
    return ChartWorkspace.sourcesPromise;
  }

  static sourceName(id: string): string {
    return ChartWorkspace.sourcesCache?.find((s) => s.id === id)?.name.replace(' Advanced', '') || id;
  }

  /** Whether a source charts stocks (prices get 2 decimals, no "Mine" overlay). */
  static isStock(id: string | undefined): boolean {
    if (!id) return false;
    const src = ChartWorkspace.sourcesCache?.find((s) => s.id === id);
    // Before the sources load (e.g. script alerts on another page), go by id.
    return src ? src.kind === 'stock' : id === 'stocks';
  }

  /** Forget the sources, e.g. after the Alpaca key changes the Stocks entry. */
  static invalidateSources(): void {
    ChartWorkspace.sourcesCache = null;
    ChartWorkspace.sourcesPromise = null;
  }

  static defaultState(symbol = 'BTC/USD', source = 'coinbase'): ChartState {
    return {
      v: 1, timeframe: '1h', chartType: 'candles', compareMode: 'stacked', showMine: true,
      panes: [{ id: ChartGeo.uid('p'), symbol, source, volume: true, indicators: [], drawings: [] }],
      view: { barSpacing: 7 },
    };
  }

  /** Coerce whatever was saved into a well-formed state. */
  static sanitize(raw: any): ChartState {
    const base = ChartWorkspace.defaultState();
    if (!raw || typeof raw !== 'object') return base;
    const tf = ChartGeo.TIMEFRAMES.includes(raw.timeframe) ? raw.timeframe : '1h';
    const chartType: ChartType = ['candles', 'bars', 'line', 'area'].includes(raw.chartType) ? raw.chartType : 'candles';
    const panes: ChartPaneState[] = (Array.isArray(raw.panes) ? raw.panes : []).slice(0, CHART_MAX_PANES)
      .filter((p: any) => p && typeof p.symbol === 'string' && p.symbol)
      .map((p: any) => ({
        id: typeof p.id === 'string' ? p.id : ChartGeo.uid('p'),
        symbol: p.symbol,
        source: typeof p.source === 'string' ? p.source : 'kraken',
        volume: p.volume !== false,
        indicators: (Array.isArray(p.indicators) ? p.indicators : [])
          .filter((i: any) => i && (ChartIndicators.get(i.type) || (i.type === 'script' && Number.isInteger(i.scriptId))))
          .map((i: any): ChartIndicatorSpec => {
            const id = typeof i.id === 'string' ? i.id : ChartGeo.uid('i');
            const color = typeof i.color === 'string' ? i.color : undefined;
            if (i.type !== 'script') {
              return { id, type: i.type, params: { ...ChartIndicators.defaults(i.type), ...(i.params || {}) }, color };
            }
            // A script's settings are checked against its inputs when it runs;
            // here they only need to be plain values.
            const params: Record<string, number | boolean | string> = {};
            for (const [k, v] of Object.entries(i.params || {})) {
              if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') params[k] = v;
            }
            const styles: Record<string, ChartScriptStyle> = {};
            for (const [k, v] of Object.entries(i.styles || {}) as [string, any][]) {
              if (!v || typeof v !== 'object') continue;
              const st: ChartScriptStyle = {};
              if (typeof v.visible === 'boolean') st.visible = v.visible;
              if (typeof v.color === 'string') st.color = v.color;
              if (typeof v.width === 'number' && v.width > 0) st.width = Math.min(10, v.width);
              styles[k] = st;
            }
            return { id, type: 'script', scriptId: i.scriptId, params, color, styles };
          }),
        drawings: (Array.isArray(p.drawings) ? p.drawings : [])
          .filter((d: any) => d && ChartDrawings.get(d.type) && Array.isArray(d.points) &&
            d.points.length && d.points.every((pt: any) => isFinite(pt?.time) && isFinite(pt?.price))),
      }));
    if (!panes.length) return base;
    const barSpacing = Number(raw.view?.barSpacing);
    const compareMode: ChartCompareMode = raw.compareMode === 'percent' ? 'percent' : 'stacked';
    return { v: 1, timeframe: tf, chartType, compareMode, showMine: raw.showMine !== false, panes, view: { barSpacing: isFinite(barSpacing) && barSpacing > 0 ? barSpacing : 7 } };
  }

  readonly root: HTMLElement;
  private chartEl: HTMLElement;
  private headsEl: HTMLElement;
  chart: any = null;
  state: ChartState;
  private panes: PaneRuntime[] = [];
  private axis: number[] = [];
  private data = new Map<string, CandleSet>();
  drawing: DrawingController | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private resizeObs: ResizeObserver | null = null;
  private paneObs: ResizeObserver | null = null;
  private viewApplied = false;
  private pendingRange: { from: number; to: number } | null = null;
  private destroyed = false;
  private popover: HTMLElement | null = null;
  private theme = ChartTheme.get();
  private unsubAlerts: (() => void) | null = null;
  private unsubScripts: (() => void) | null = null;
  private orders: any[] = [];

  constructor(host: HTMLElement, private opts: ChartWorkspaceOptions) {
    this.root = document.createElement('div');
    this.root.className = `cw-root cw-${opts.mode}`;
    this.chartEl = document.createElement('div');
    this.chartEl.className = 'cw-chart';
    this.headsEl = document.createElement('div');
    this.headsEl.className = 'cw-heads';
    this.root.append(this.chartEl, this.headsEl);
    host.appendChild(this.root);
    this.state = ChartWorkspace.defaultState();

    this.resizeObs = new ResizeObserver(() => this.layoutHeads());
    this.resizeObs.observe(this.root);
    if (opts.mode === 'edit') this.drawing = new DrawingController(this);
    this.pollTimer = setInterval(() => { if (!document.hidden) void this.pollLatest(); }, CHART_POLL_MS);
    void ChartWorkspace.loadSources().then(() => this.renderHeads());
    // Lines that carry an alert show its state; refresh when alerts change.
    this.unsubAlerts = ChartAlerts.onChange(() => this.redraw());
    void ChartAlerts.ensureLoaded();
    // A script was saved, renamed or deleted: redraw the ones on this chart.
    this.unsubScripts = CustomIndicators.onChange(() => {
      if (this.chart && this.state.panes.some((p) => p.indicators.some((i) => i.type === 'script'))) this.rebuild(true);
    });
    void CustomIndicators.ensureLoaded();
  }

  get timeframe(): string { return this.state.timeframe; }
  get step(): number { return ChartGeo.tfSeconds(this.state.timeframe); }
  get mode(): 'edit' | 'view' { return this.opts.mode; }

  // ── State ─────────────────────────────────────────────────────────────────

  /** A signature of everything that needs the chart rebuilt to change. */
  private structure(s: ChartState): string {
    return JSON.stringify([s.timeframe, s.chartType, s.compareMode, s.panes.map((p) => [p.id, p.symbol, p.source, p.volume, p.indicators])]);
  }

  loadState(raw: any): void {
    const next = ChartWorkspace.sanitize(JSON.parse(JSON.stringify(raw)));
    const sameShape = this.chart && this.structure(next) === this.structure(this.state);
    const sameView = this.state.timeframe === next.timeframe;
    this.state = next;
    if (sameShape) {
      // Only drawings differ (undo/redo): swap them in place.
      this.panes.forEach((p) => { p.st = this.state.panes.find((q) => q.id === p.st.id) || p.st; });
      this.drawing?.validateSelection();
      this.redraw();
      return;
    }
    this.rebuild(sameView && !!this.chart);
  }

  getState(): ChartState {
    const s: ChartState = JSON.parse(JSON.stringify(this.state));
    const draft = this.drawing?.draftId();
    if (draft) s.panes.forEach((p) => { p.drawings = p.drawings.filter((d) => d.id !== draft); });
    const bs = this.chart?.timeScale().options().barSpacing;
    if (bs) s.view = { barSpacing: Math.round(bs * 100) / 100 };
    return s;
  }

  private changed(): void {
    this.opts.onChange?.();
  }

  /** Called by the drawing controller after any committed drawing edit. */
  drawingsChanged(): void {
    this.redraw();
    this.changed();
  }

  setTimeframe(tf: string): void {
    if (tf === this.state.timeframe || !ChartGeo.TIMEFRAMES.includes(tf)) return;
    this.state.timeframe = tf;
    this.rebuild(false);
    this.changed();
  }

  /** True when the coins share one pane, each as % change from the left edge. */
  get percentMode(): boolean {
    return this.state.compareMode === 'percent' && this.state.panes.length > 1;
  }

  setCompareMode(mode: ChartCompareMode): void {
    if (mode === (this.state.compareMode || 'stacked')) return;
    this.state.compareMode = mode;
    this.drawing?.validateSelection();
    this.rebuild(true);
    this.changed();
  }

  /** Show or hide the user's open orders, fills and average cost. */
  setShowMine(on: boolean): void {
    if (on === (this.state.showMine !== false)) return;
    this.state.showMine = on;
    if (on) void this.loadMine(true);
    else this.applyMine();
    this.changed();
  }

  /** Latest close of a pane's coin, or null before its candles load. */
  lastPrice(paneId: string): number | null {
    const st = this.paneState(paneId);
    if (!st) return null;
    const bars = this.entry(`${st.source}|${st.symbol}|${this.state.timeframe}`).bars;
    return bars.length ? bars[bars.length - 1].close : null;
  }

  setChartType(t: ChartType): void {
    if (t === this.state.chartType) return;
    this.state.chartType = t;
    this.rebuild(true);
    this.changed();
  }

  /** Timeframes every pane's source can serve. */
  supportedTimeframes(): string[] {
    const sources = ChartWorkspace.sourcesCache || [];
    return ChartGeo.TIMEFRAMES.filter((tf) =>
      this.state.panes.every((p) => {
        const s = sources.find((x) => x.id === p.source);
        return !s || s.timeframes.includes(tf);
      }));
  }

  canAddPane(): boolean { return this.state.panes.length < CHART_MAX_PANES; }

  addPane(symbol: string, source: string): void {
    if (!this.canAddPane()) return;
    this.state.panes.push({ id: ChartGeo.uid('p'), symbol, source, volume: false, indicators: [], drawings: [] });
    this.rebuild(true);
    this.changed();
  }

  setPaneSymbol(paneId: string, symbol: string, source: string): void {
    const p = this.state.panes.find((x) => x.id === paneId);
    if (!p || (p.symbol === symbol && p.source === source)) return;
    if (p.drawings.length && p.symbol !== symbol &&
        !window.confirm(`Drawings on this pane were placed on ${p.symbol}'s prices. Keep them on ${symbol}?`)) {
      const gone = p.drawings;
      p.drawings = [];
      this.drawing?.onDrawingsRemoved(gone);
    }
    p.symbol = symbol;
    p.source = source;
    this.rebuild(true);
    this.changed();
  }

  removePane(paneId: string): void {
    if (this.state.panes.length <= 1) return;
    const p = this.state.panes.find((x) => x.id === paneId);
    if (!p) return;
    if (p.drawings.length && !window.confirm(`Remove ${p.symbol} and its ${p.drawings.length} drawing(s)?`)) return;
    this.state.panes = this.state.panes.filter((x) => x.id !== paneId);
    this.drawing?.onDrawingsRemoved(p.drawings);
    this.drawing?.validateSelection();
    this.rebuild(true);
    this.changed();
  }

  toggleVolume(paneId: string): void {
    const p = this.state.panes.find((x) => x.id === paneId);
    if (!p) return;
    p.volume = !p.volume;
    this.rebuild(true);
    this.changed();
  }

  addIndicator(paneId: string, type: string): void {
    const p = this.state.panes.find((x) => x.id === paneId);
    if (!p || !ChartIndicators.get(type)) return;
    const used = this.state.panes.reduce((n, q) => n + q.indicators.length, 0);
    p.indicators.push({ id: ChartGeo.uid('i'), type, params: ChartIndicators.defaults(type), color: this.theme.palette[(used + 3) % this.theme.palette.length] });
    this.rebuild(true);
    this.changed();
  }

  /** Add a saved Pine Script indicator to a pane. */
  addScript(paneId: string, scriptId: number): void {
    const p = this.state.panes.find((x) => x.id === paneId);
    if (!p || !CustomIndicators.get(scriptId)) return;
    const c = CustomIndicators.compiled(scriptId)?.compiled;
    const used = this.state.panes.reduce((n, q) => n + q.indicators.length, 0);
    p.indicators.push({
      id: ChartGeo.uid('i'), type: 'script', scriptId, params: c ? PineEngine.defaults(c) : {}, styles: {},
      color: this.theme.palette[(used + 3) % this.theme.palette.length],
    });
    this.rebuild(true);
    this.changed();
  }

  /** Every script indicator on this chart that uses a given script. */
  scriptUses(scriptId: number): { paneId: string; indId: string }[] {
    return this.state.panes.flatMap((p) => p.indicators
      .filter((i) => i.type === 'script' && i.scriptId === scriptId)
      .map((i) => ({ paneId: p.id, indId: i.id })));
  }

  /** The last run of a script indicator on screen (for its settings and alerts). */
  scriptRun(paneId: string, indId: string): { compiled: PineCompiled | null; result: PineRunResult | null; error: string | null } | null {
    const ir = this.panes.find((p) => p.st.id === paneId)?.indicators.find((i) => i.spec.id === indId);
    if (!ir?.script) return null;
    return { compiled: ir.script.compiled, result: ir.script.result, error: ir.script.error };
  }

  updateIndicator(paneId: string, indId: string, params: Record<string, number | boolean | string>, color?: string, styles?: Record<string, ChartScriptStyle>): void {
    const ind = this.state.panes.find((x) => x.id === paneId)?.indicators.find((i) => i.id === indId);
    if (!ind) return;
    ind.params = { ...ind.params, ...params };
    if (color) ind.color = color;
    if (styles) ind.styles = styles;
    this.rebuild(true);
    this.changed();
  }

  removeAllIndicators(): void {
    if (!this.state.panes.some((p) => p.indicators.length)) return;
    this.state.panes.forEach((p) => { p.indicators = []; });
    this.rebuild(true);
    this.changed();
  }

  removeIndicator(paneId: string, indId: string): void {
    const p = this.state.panes.find((x) => x.id === paneId);
    if (!p) return;
    p.indicators = p.indicators.filter((i) => i.id !== indId);
    this.rebuild(true);
    this.changed();
  }

  // ── Building the chart ────────────────────────────────────────────────────

  /** Tear down and rebuild the chart; `keepRange` holds the visible time span. */
  private rebuild(keepRange: boolean): void {
    let range: { from: number; to: number } | null = null;
    if (keepRange && this.chart && this.axis.length) {
      const lr = this.chart.timeScale().getVisibleLogicalRange();
      if (lr) range = { from: ChartGeo.logicalToTime(this.axis, lr.from, this.step), to: ChartGeo.logicalToTime(this.axis, lr.to, this.step) };
    }
    const barSpacing = this.chart?.timeScale().options().barSpacing;
    if (barSpacing) this.state.view = { barSpacing };
    this.teardownChart();
    this.pendingRange = range;
    this.viewApplied = false;
    this.build();
  }

  private teardownChart(): void {
    this.closePopover();
    this.paneObs?.disconnect();
    this.paneObs = null;
    if (this.chart) {
      try { this.chart.remove(); } catch { /* already gone */ }
    }
    this.chart = null;
    this.panes = [];
    this.axis = [];
    this.headsEl.innerHTML = '';
  }

  private chartOptions(): any {
    const LWC = (window as any).LightweightCharts;
    const t = this.theme;
    return {
      autoSize: true,
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: t.text,
        fontFamily: t.font,
        fontSize: 11,
        attributionLogo: false,
        panes: { separatorColor: t.border, separatorHoverColor: ChartTheme.alpha(t.accent, 0.25), enableResize: true },
      },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      crosshair: {
        mode: LWC.CrosshairMode.Normal,
        vertLine: { color: t.crosshair, labelBackgroundColor: t.dark ? '#2E3438' : '#52606A' },
        horzLine: { color: t.crosshair, labelBackgroundColor: t.dark ? '#2E3438' : '#52606A' },
      },
      rightPriceScale: { borderColor: t.border, scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderColor: t.border, timeVisible: true, secondsVisible: false, rightOffset: 8, minBarSpacing: 0.5 },
      // On the Overview the mouse wheel should scroll the page, not the chart;
      // drag to pan and drag the axes to zoom still work there.
      handleScroll: this.opts.mode === 'edit' ? true : { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: this.opts.mode === 'edit' ? true : { mouseWheel: false, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
    };
  }

  private build(): void {
    const LWC = (window as any).LightweightCharts;
    this.theme = ChartTheme.get();
    this.chart = LWC.createChart(this.chartEl, this.chartOptions());
    if (this.state.view?.barSpacing) this.chart.timeScale().applyOptions({ barSpacing: this.state.view.barSpacing });

    const percent = this.percentMode;
    // In % mode every coin shares pane 0; oscillators still get panes below.
    let paneIndex = percent ? 1 : 0;
    this.state.panes.forEach((st, order) => {
      const key = `${st.source}|${st.symbol}|${this.state.timeframe}`;
      const idx = percent ? 0 : paneIndex++;
      const overlaid = percent && order > 0;
      const color = overlaid ? this.theme.palette[(order * 3 + 1) % this.theme.palette.length] : null;
      const main = overlaid
        ? this.chart.addSeries(LWC.LineSeries, { color, lineWidth: 2 }, idx)
        : this.chart.addSeries(this.mainSeriesDef(), this.mainSeriesOptions(), idx);
      let volume = null;
      if (st.volume && !overlaid) {
        volume = this.chart.addSeries(LWC.HistogramSeries, {
          priceScaleId: `vol_${st.id}`, priceFormat: { type: 'volume' },
          lastValueVisible: false, priceLineVisible: false,
        }, idx);
        volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      }
      const rt: PaneRuntime = {
        st, key, paneIndex: idx, order, main, volume, indicators: [], mineLines: [], markers: null,
        isLine: overlaid || this.state.chartType === 'line' || this.state.chartType === 'area',
        color,
        primitive: null as any, headerEl: document.createElement('div'),
      };
      rt.primitive = new PaneDrawingsPrimitive({
        // Overlaid coins' drawings sit out % mode; the primary coin's still show.
        drawings: () => (overlaid ? [] : rt.st.drawings),
        frame: () => this.frameFor(rt),
        selectedId: () => this.drawing?.selectedIdIn(rt.st.id) ?? null,
        hoverId: () => this.drawing?.hoverIdIn(rt.st.id) ?? null,
        allHidden: () => !!this.drawing?.allHidden,
      });
      main.attachPrimitive(rt.primitive);

      st.indicators.forEach((spec, n) => {
        if (spec.type === 'script') {
          rt.indicators.push(this.buildScript(spec, idx, percent, () => paneIndex++));
          return;
        }
        const def = ChartIndicators.get(spec.type);
        if (!def) return;
        // A price overlay can't share a % scale with the coin (each series is
        // rebased to its own first value), so overlays sit out % mode.
        if (def.overlay && percent) {
          rt.indicators.push({ spec, def, series: new Map(), paneIndex: idx, headerEl: null });
          return;
        }
        const ir: IndicatorRuntime = { spec, def, series: new Map(), paneIndex: def.overlay ? idx : paneIndex++, headerEl: null };
        if (def.profile) {
          ir.primitive = new VisibleProfilePrimitive(() => this.frameFor(rt), () => ir.spec.params as Record<string, number>);
          main.attachPrimitive(ir.primitive);
          rt.indicators.push(ir);
          return;
        }
        const color = spec.color || this.theme.palette[(n + 3) % this.theme.palette.length];
        const alt = this.theme.palette[(n + 6) % this.theme.palette.length];
        // Compute once with no bars just to learn the output lines.
        for (const line of def.compute([], spec.params as Record<string, number>)) {
          const base = { lastValueVisible: !def.overlay, priceLineVisible: false, crosshairMarkerVisible: false };
          let s;
          if (line.kind === 'histogram') {
            s = this.chart.addSeries(LWC.HistogramSeries, { ...base, color: ChartTheme.alpha(color, 0.5) }, ir.paneIndex);
          } else {
            s = this.chart.addSeries(LWC.LineSeries, {
              ...base, color: line.tone === 0 ? color : alt, lineWidth: line.tone === 0 ? 2 : 1,
            }, ir.paneIndex);
          }
          if (def.range) {
            const [lo, hi] = def.range;
            s.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: lo, maxValue: hi } }) });
          }
          ir.series.set(line.key, s);
        }
        const first = ir.series.values().next().value;
        def.guides?.forEach((g) => first?.createPriceLine({
          price: g, color: ChartTheme.alpha(this.theme.text, 0.5), lineWidth: 1,
          lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: false,
        }));
        rt.indicators.push(ir);
      });
      this.panes.push(rt);
    });
    if (percent) this.panes[0].main.priceScale().applyOptions({ mode: LWC.PriceScaleMode.Percentage });

    // Oscillator panes are short; symbol panes share the rest.
    const chartPanes = this.chart.panes();
    for (const rt of this.panes) {
      for (const ir of rt.indicators) if (!ir.def.overlay) chartPanes[ir.paneIndex]?.setStretchFactor(0.32);
    }

    this.chart.subscribeCrosshairMove((param: any) => this.updateLegends(param));
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((r: any) => this.maybeLoadOlder(r));

    this.paneObs = new ResizeObserver(() => this.layoutHeads());
    chartPanes.forEach((p: any) => { const el = p.getHTMLElement(); if (el) this.paneObs!.observe(el); });

    this.renderHeads();
    this.applyData();
    for (const rt of this.panes) void this.ensureData(rt.key, rt.st);
    void this.loadMine(false);
  }

  private mainSeriesDef(): any {
    const LWC = (window as any).LightweightCharts;
    switch (this.state.chartType) {
      case 'bars': return LWC.BarSeries;
      case 'line': return LWC.LineSeries;
      case 'area': return LWC.AreaSeries;
      default: return LWC.CandlestickSeries;
    }
  }

  private mainSeriesOptions(): any {
    const t = this.theme;
    switch (this.state.chartType) {
      case 'bars': return { upColor: t.pos, downColor: t.neg, thinBars: false };
      case 'line': return { color: t.accent, lineWidth: 2 };
      case 'area': return { lineColor: t.accent, topColor: t.areaTop, bottomColor: t.areaBottom, lineWidth: 2 };
      default: return { upColor: t.pos, downColor: t.neg, borderVisible: false, wickUpColor: t.pos, wickDownColor: t.neg };
    }
  }

  // ── Script (Pine) indicators ──────────────────────────────────────────────

  /** An IndicatorDef stand-in so a script fits the chips, legends and screenshot code. */
  private scriptDef(spec: ChartIndicatorSpec, c: PineCompiled | null): IndicatorDef {
    return {
      type: 'script', label: CustomIndicators.label(spec), group: 'My scripts', overlay: !!c?.overlay, params: [],
      short: () => CustomIndicators.shortLabel(spec), compute: () => [],
    };
  }

  private buildScript(spec: ChartIndicatorSpec, priceIdx: number, percent: boolean, nextPane: () => number): IndicatorRuntime {
    const LWC = (window as any).LightweightCharts;
    const comp = CustomIndicators.compiled(spec.scriptId);
    const compiled = comp?.compiled ?? null;
    const def = this.scriptDef(spec, compiled);
    const sr: ScriptRuntime = {
      compiled, error: null, off: false, result: null, bars: [], anchor: null,
      plots: new Map(), plotKinds: new Map(), primitive: null, markers: null, tableEls: [],
    };
    if (!comp) sr.error = CustomIndicators.isLoaded ? 'This script was deleted' : null;
    else if (comp.error) sr.error = PineEngine.describe(comp.error);
    const ir: IndicatorRuntime = { spec, def, series: sr.plots, paneIndex: priceIdx, headerEl: null, script: sr };
    if (def.overlay && percent) {
      sr.off = true;
      return ir;
    }
    if (!def.overlay) ir.paneIndex = nextPane();
    const host: ScriptPaneHost = {
      result: () => sr.result,
      bars: () => sr.bars,
      series: () => sr.anchor,
      toX: (t) => (this.chart ? this.chart.timeScale().logicalToCoordinate(ChartGeo.timeToLogical(this.axis, t, this.step)) : null),
      barSpacing: () => this.chart?.timeScale().options().barSpacing || 6,
      visible: () => {
        const lr = this.chart?.timeScale().getVisibleLogicalRange();
        if (!lr || !this.axis.length) return null;
        return [ChartGeo.logicalToTime(this.axis, lr.from, this.step), ChartGeo.logicalToTime(this.axis, lr.to, this.step)];
      },
      styles: () => ir.spec.styles,
    };
    // An invisible series on the script's pane: it anchors the price scale for
    // fills, hlines and markers, and tells autoscale about fills and hlines.
    sr.anchor = this.chart.addSeries(LWC.LineSeries, {
      color: 'rgba(0,0,0,0)', lineVisible: false, pointMarkersVisible: false, crosshairMarkerVisible: false,
      lastValueVisible: false, priceLineVisible: false, autoscaleInfoProvider: () => ScriptRender.autoscale(host),
    }, ir.paneIndex);
    sr.primitive = new ScriptPanePrimitive(host);
    sr.anchor.attachPrimitive(sr.primitive);
    return ir;
  }

  /** Run every script on a pane over its bars (before the candles are set, for barcolor). */
  private runScripts(rt: PaneRuntime, all: ChartBar[]): boolean {
    let changed = false;
    const bars = all.length > CHART_SCRIPT_MAX_BARS ? all.slice(-CHART_SCRIPT_MAX_BARS) : all;
    const last = bars[bars.length - 1];
    const lastLive = !!last && last.time + this.step > Date.now() / 1000;
    for (const ir of rt.indicators) {
      const sr = ir.script;
      if (!sr || sr.off || !sr.compiled) continue;
      const before = sr.error;
      if (!bars.length) {
        sr.result = null;
        sr.bars = [];
        continue;
      }
      const res = PineEngine.run(sr.compiled, bars, CustomIndicators.params(sr.compiled, ir.spec.params), {
        symbol: rt.st.symbol, source: rt.st.source, exchange: ChartWorkspace.sourceName(rt.st.source),
        timeframe: this.state.timeframe, lastLive,
      });
      sr.bars = bars;
      sr.result = res.error ? null : res;
      sr.error = res.error ? PineEngine.describe(res.error) : null;
      if (sr.error !== before) changed = true;
    }
    return changed;
  }

  /** barcolor() from this pane's scripts, by bar time. */
  private barColors(rt: PaneRuntime): Map<number, string> | null {
    let out: Map<number, string> | null = null;
    for (const ir of rt.indicators) {
      const sr = ir.script, res = sr?.result;
      if (!sr || !res) continue;
      for (const o of res.outputs) {
        if (o.kind !== 'bar' || !ScriptRender.shown(o, ir.spec.styles)) continue;
        for (let i = 0; i < sr.bars.length; i++) {
          const c = ScriptRender.colorAt(o, i, ir.spec.styles);
          if (c) (out || (out = new Map())).set(sr.bars[i].time, c);
        }
      }
    }
    return out;
  }

  /** A main-series bar with a script's barcolor applied. */
  private paintedBar(b: ChartBar, color: string | undefined): any {
    const d: any = { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close };
    if (color) {
      d.color = color;
      if (this.state.chartType === 'candles') { d.borderColor = color; d.wickColor = color; }
    }
    return d;
  }

  /** 'rgba(r,g,b,a)' or '#RRGGBB' with its alpha scaled by k. */
  private static fade(css: string, k: number): string {
    const p = PineColors.parse(css);
    if (!p) return ChartTheme.alpha(css, k);
    const a = (1 - p.t / 100) * k;
    return `rgba(${p.r},${p.g},${p.b},${Math.round(a * 1000) / 1000})`;
  }

  private static plotKind(o: PineOutput): string {
    switch (o.style) {
      case 'circles': case 'cross': return 'points';
      case 'histogram': case 'columns': return 'hist';
      case 'area': case 'areabr': return 'area';
      case 'stepline': case 'steplinebr': case 'stepline_diamond': return 'step';
      default: return 'line';
    }
  }

  private createPlotSeries(o: PineOutput, ir: IndicatorRuntime, kind: string, bars: ChartBar[], source?: string): any {
    const LWC = (window as any).LightweightCharts;
    const ov = ir.spec.styles?.[o.key];
    const width = ov?.width || o.width || 1;
    const color = ov?.color || o.color || '#2962FF';
    const prec = ir.script?.compiled?.precision ?? (ir.def.overlay ? this.precisionFor(bars, source) : 2);
    const base = {
      lastValueVisible: !ir.def.overlay && (o.display & 4) !== 0, priceLineVisible: false, crosshairMarkerVisible: false,
      priceFormat: { type: 'price', precision: prec, minMove: Math.pow(10, -prec) },
    };
    const dashStyle = o.lineStyle === 'dotted' ? LWC.LineStyle.Dotted : o.lineStyle === 'dashed' ? LWC.LineStyle.Dashed : LWC.LineStyle.Solid;
    switch (kind) {
      case 'points':
        return this.chart.addSeries(LWC.LineSeries, { ...base, color, lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: Math.max(2, width) }, ir.paneIndex);
      case 'hist':
        return this.chart.addSeries(LWC.HistogramSeries, { ...base, color, base: o.histbase || 0 }, ir.paneIndex);
      case 'area':
        return this.chart.addSeries(LWC.AreaSeries, {
          ...base, lineColor: color, topColor: ChartWorkspace.fade(color, 0.4), bottomColor: ChartWorkspace.fade(color, 0), lineWidth: width,
        }, ir.paneIndex);
      default:
        return this.chart.addSeries(LWC.LineSeries, {
          ...base, color, lineWidth: width, lineStyle: dashStyle, lineType: kind === 'step' ? LWC.LineType.WithSteps : LWC.LineType.Simple,
        }, ir.paneIndex);
    }
  }

  /** Series data for one plot. Line segments take the colour of the bar they lead into, as in TradingView. */
  private plotData(o: PineOutput, bars: ChartBar[], styles: Record<string, ChartScriptStyle> | undefined, kind: string): any[] {
    const breaks = o.style === 'linebr' || o.style === 'steplinebr' || o.style === 'areabr';
    const out: any[] = [];
    for (let i = 0; i < bars.length; i++) {
      const v = o.values[i];
      if (!isFinite(v)) {
        if (breaks) out.push({ time: bars[i].time });
        continue;
      }
      const c = ScriptRender.colorAt(o, i, styles) || 'rgba(0,0,0,0)';
      if (kind === 'area') out.push({ time: bars[i].time, value: v, lineColor: c, topColor: ChartWorkspace.fade(c, 0.4), bottomColor: ChartWorkspace.fade(c, 0) });
      else out.push({ time: bars[i].time, value: v, color: c });
    }
    if (kind === 'line' || kind === 'step') {
      for (let k = 0; k < out.length - 1; k++) {
        if (out[k].value !== undefined && out[k + 1].value !== undefined) out[k].color = out[k + 1].color;
      }
    }
    return out;
  }

  /** Push a script's last run into its series, markers, primitive and tables. */
  private applyScript(rt: PaneRuntime, ir: IndicatorRuntime): void {
    const sr = ir.script!;
    if (sr.off || !sr.anchor) return;
    const LWC = (window as any).LightweightCharts;
    const res = sr.result, bars = sr.bars, styles = ir.spec.styles;

    // The anchor follows the first plot, so markers in an own-pane script sit on it.
    const first = res?.outputs.find((o) => o.kind === 'plot' && ScriptRender.shown(o, styles));
    let lastV = 0;
    if (first) for (let i = 0; i < bars.length; i++) if (isFinite(first.values[i])) { lastV = first.values[i]; break; }
    sr.anchor.setData(bars.map((b, i) => {
      const v = first?.values[i];
      if (v !== undefined && isFinite(v)) lastV = v;
      return { time: b.time, value: lastV };
    }));

    const seen = new Set<string>();
    for (const o of res?.outputs || []) {
      if (o.kind !== 'plot') continue;
      seen.add(o.key);
      const kind = ScriptRender.shown(o, styles) ? ChartWorkspace.plotKind(o) : 'hidden';
      let s = sr.plots.get(o.key);
      if (sr.plotKinds.get(o.key) !== kind && s) {
        try { this.chart.removeSeries(s); } catch { /* gone */ }
        sr.plots.delete(o.key);
        s = undefined;
      }
      sr.plotKinds.set(o.key, kind);
      if (kind === 'hidden') continue;
      if (!s) {
        s = this.createPlotSeries(o, ir, kind, bars, rt.st.source);
        sr.plots.set(o.key, s);
      }
      s.setData(this.plotData(o, bars, styles, kind));
      // The axis label shows the newest bar's value; a plot that's na there
      // (a dot that fired bars ago) shouldn't leave an old value on the scale.
      const lastOk = bars.length > 0 && isFinite(o.values[bars.length - 1]);
      s.applyOptions({ lastValueVisible: !ir.def.overlay && (o.display & 4) !== 0 && lastOk });
    }
    // Outputs that went away (the run failed) leave empty series behind.
    sr.plots.forEach((s, key) => { if (!seen.has(key)) s.setData([]); });

    const list = res ? ScriptRender.markers(res, bars, styles) : [];
    if (sr.markers) sr.markers.setMarkers(list);
    else if (list.length) sr.markers = LWC.createSeriesMarkers(ir.def.overlay ? rt.main : sr.anchor, list);

    this.renderScriptTables(ir);
    sr.primitive?.update();
  }

  private renderScriptTables(ir: IndicatorRuntime): void {
    const sr = ir.script!;
    sr.tableEls.forEach((el) => el.remove());
    sr.tableEls = (sr.result?.tables || []).map((t) => {
      const el = document.createElement('div');
      el.className = 'cw-script-table-wrap';
      el.dataset.pos = t.position;
      el.innerHTML = ScriptRender.tableHtml(t);
      this.headsEl.appendChild(el);
      return el;
    });
    this.layoutTables(ir);
  }

  /** Place a script's tables at their position.* inside its pane. */
  private layoutTables(ir: IndicatorRuntime): void {
    const sr = ir.script;
    if (!sr?.tableEls.length || !this.chart) return;
    const pel = this.chart.panes()[ir.paneIndex]?.getHTMLElement();
    if (!pel) return;
    const top = this.root.getBoundingClientRect().top;
    const r = pel.getBoundingClientRect();
    const paneTop = r.top - top, paneH = r.height;
    const width = this.headsEl.clientWidth;
    for (const el of sr.tableEls) {
      const [v, h] = String(el.dataset.pos || 'top_right').split('_');
      const eh = el.offsetHeight, ew = el.offsetWidth;
      const y = v === 'top' ? paneTop + 6 : v === 'bottom' ? paneTop + paneH - eh - 6 : paneTop + (paneH - eh) / 2;
      const x = h === 'left' ? 8 : h === 'right' ? width - ew : (width - ew) / 2;
      el.style.top = `${Math.max(paneTop, y)}px`;
      el.style.left = `${Math.max(0, x)}px`;
    }
  }

  /** Values of a script's plots on the bar at `time` (or the last bar), in their colours. */
  private scriptLegend(ir: IndicatorRuntime, time: number | null): string {
    const sr = ir.script!;
    const res = sr.result;
    if (!res || !sr.bars.length) return '';
    const i = time == null ? sr.bars.length - 1 : ScriptRender.indexAt(sr.bars, time);
    if (i < 0) return '';
    const prec = sr.compiled?.precision ?? null;
    const parts: string[] = [];
    for (const o of res.outputs) {
      if (o.kind !== 'plot' || !ScriptRender.shown(o, ir.spec.styles) || !(o.display & 8)) continue;
      const v = o.values[i];
      const c = ScriptRender.colorAt(o, i, ir.spec.styles) || o.color || '';
      const txt = !isFinite(v) ? '∅' : prec != null ? v.toFixed(prec) : ir.def.overlay ? ChartGeo.formatPrice(v) : ChartWorkspace.fmtValue(v);
      parts.push(`<span style="color:${ChartWorkspace.esc(c)}">${txt}</span>`);
    }
    return parts.join(' ');
  }

  /** An oscillator value with sensible precision. */
  private static fmtValue(v: number): string {
    const a = Math.abs(v);
    return a >= 1000 ? v.toFixed(0) : a >= 1 ? v.toFixed(2) : a >= 0.01 ? v.toFixed(4) : v.toPrecision(3);
  }

  // ── Data ──────────────────────────────────────────────────────────────────

  private entry(key: string): CandleSet {
    let e = this.data.get(key);
    if (!e) {
      e = { bars: [], hasMore: false, loaded: false, loading: null, olderLoading: false, error: null };
      this.data.set(key, e);
    }
    return e;
  }

  private async ensureData(key: string, st: ChartPaneState): Promise<void> {
    const e = this.entry(key);
    // A failed load is retried whenever the chart is rebuilt.
    if (e.loaded && e.error && !e.bars.length) { e.loaded = false; e.error = null; }
    if (e.loaded) return;
    if (!e.loading) {
      e.loading = (async () => {
        try {
          const resp = await MarketData.getCandles(AuthController.getToken() || '', {
            symbol: st.symbol, source: st.source, timeframe: this.state.timeframe,
          });
          e.bars = (resp.data?.candles || []).slice().sort((a, b) => a.time - b.time);
          e.hasMore = !!resp.data?.has_more;
          e.error = e.bars.length ? null : 'No candles for this symbol';
        } catch (err: any) {
          e.error = typeof err === 'string' ? err : (err?.message || 'Couldn’t load candles');
        }
        e.loaded = true;
        e.loading = null;
      })();
    }
    await e.loading;
    if (this.destroyed) return;
    if (this.panes.some((p) => p.key === key)) {
      this.applyData();
      this.renderHeads();
    }
  }

  /** Price precision for a series from its typical price (stocks trade in cents). */
  private precisionFor(bars: ChartBar[], source?: string): number {
    const last = bars[bars.length - 1]?.close || 1;
    const a = Math.abs(last);
    if (ChartWorkspace.isStock(source)) return a >= 1 ? 2 : 4;
    return a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8;
  }

  /** (Re)set every series from the cached candles, aligned to one shared axis. */
  private applyData(): void {
    if (!this.chart) return;
    const times = new Set<number>();
    for (const rt of this.panes) this.entry(rt.key).bars.forEach((b) => times.add(b.time));
    this.axis = Array.from(times).sort((a, b) => a - b);

    let headsDirty = false;
    for (const rt of this.panes) {
      const line = rt.isLine;
      const bars = this.entry(rt.key).bars;
      // Scripts run first: their barcolor() paints the candles.
      if (this.runScripts(rt, bars)) headsDirty = true;
      const painted = line ? null : this.barColors(rt);
      const byTime = new Map(bars.map((b) => [b.time, b]));
      const mainData: any[] = [];
      const volData: any[] = [];
      for (const t of this.axis) {
        const b = byTime.get(t);
        if (!b) { mainData.push({ time: t }); continue; }
        mainData.push(line ? { time: t, value: b.close } : this.paintedBar(b, painted?.get(t)));
        if (rt.volume) volData.push({ time: t, value: b.volume, color: ChartTheme.alpha(b.close >= b.open ? this.theme.pos : this.theme.neg, 0.35) });
      }
      const prec = this.precisionFor(bars, rt.st.source);
      rt.main.applyOptions({ priceFormat: { type: 'price', precision: prec, minMove: Math.pow(10, -prec) } });
      rt.main.setData(mainData);
      rt.volume?.setData(volData);
      this.applyIndicators(rt, bars);
    }

    if (this.axis.length && !this.viewApplied) {
      this.viewApplied = true;
      const ts = this.chart.timeScale();
      if (this.pendingRange) {
        ts.setVisibleLogicalRange({
          from: ChartGeo.timeToLogical(this.axis, this.pendingRange.from, this.step),
          to: ChartGeo.timeToLogical(this.axis, this.pendingRange.to, this.step),
        });
        this.pendingRange = null;
      } else {
        ts.scrollToRealTime();
      }
    }
    this.applyMine();
    this.redraw();
    // Chip values (and a script's error state) follow the data just set.
    if (headsDirty) this.renderHeads();
    else this.updateLegends(null);
    requestAnimationFrame(() => this.layoutHeads());
  }

  // ── The user's own trading: open orders, fills, average cost ─────────────

  private static quoteMatches(a: string, b: string): boolean {
    const x = a.toUpperCase(), y = b.toUpperCase();
    return x === y || (CHART_DOLLAR_QUOTES.has(x) && CHART_DOLLAR_QUOTES.has(y));
  }

  /** Fetch orders (every connected account) and each coin's fills and cost. */
  private async loadMine(force: boolean): Promise<void> {
    if (this.state.showMine === false || this.destroyed) return;
    const token = AuthController.getToken();
    if (!token) return;
    const bases = Array.from(new Set(this.state.panes
      .filter((p) => !ChartWorkspace.isStock(p.source))
      .map((p) => p.symbol.split('/')[0].toUpperCase())));
    const jobs: Promise<void>[] = bases.map((base) => {
      const cached = ChartWorkspace.mineCache.get(base);
      if (!force && cached && Date.now() - cached.at < CHART_MINE_TTL) return Promise.resolve();
      let job = ChartWorkspace.minePending.get(base);
      if (!job) {
        job = (async () => {
          const [fills, avg] = await Promise.all([
            TaxData.fills(token, base).then((r) => r.data || []).catch(() => [] as ChartFill[]),
            TaxData.avgCost(token, base, TaxController.getPreferredMethod()).then((r) => r.data || null).catch(() => null),
          ]);
          ChartWorkspace.mineCache.set(base, { at: Date.now(), fills, avg });
        })().finally(() => ChartWorkspace.minePending.delete(base));
        ChartWorkspace.minePending.set(base, job);
      }
      return job;
    });
    jobs.push((async () => {
      const conns = (ExchangeStore.connections || []) as any[];
      const lists = await Promise.all(conns.map(async (c) => {
        try {
          const { orders } = await ExchangeStore.getConnectionData(c.id, force);
          const name = ExchangeStore.getExchangeName(c.id);
          return orders.map((o: any) => ({ ...o, exchangeName: name }));
        } catch { return []; }
      }));
      this.orders = lists.flat();
    })());
    await Promise.all(jobs);
    if (!this.destroyed) this.applyMine();
  }

  /** (Re)draw order lines, fill markers and the average-cost line on each pane. */
  private applyMine(): void {
    if (!this.chart) return;
    const LWC = (window as any).LightweightCharts;
    const t = this.theme;
    for (const rt of this.panes) {
      rt.mineLines.forEach((l) => { try { rt.main.removePriceLine(l); } catch { /* gone */ } });
      rt.mineLines = [];
      // Stocks aren't traded in Cyrus; a ticker like SOL must not pick up crypto fills.
      if (this.state.showMine === false || (this.percentMode && rt.order > 0) || ChartWorkspace.isStock(rt.st.source)) {
        rt.markers?.setMarkers([]);
        continue;
      }
      const [base, quote = 'USD'] = rt.st.symbol.toUpperCase().split('/');

      for (const o of this.orders) {
        const [ob, oq = ''] = String(o.pair || '').toUpperCase().split('/');
        const price = parseFloat(o.price);
        if (ob !== base || !ChartWorkspace.quoteMatches(oq, quote) || !(price > 0)) continue;
        const buy = String(o.side).toLowerCase() === 'buy';
        const left = Math.max(0, parseFloat(o.volume) - (parseFloat(o.filled) || 0));
        rt.mineLines.push(rt.main.createPriceLine({
          price, color: buy ? t.pos : t.neg, lineWidth: 1, lineStyle: LWC.LineStyle.Dashed,
          axisLabelVisible: true,
          title: `${buy ? 'BUY' : 'SELL'} ${ChartWorkspace.fmtAmount(left)} · ${o.exchangeName || ''}`.trim(),
        }));
      }

      const mine = ChartWorkspace.mineCache.get(base);
      const avg = mine?.avg;
      if (avg?.avg_cost_usd && avg.amount > 0 && CHART_DOLLAR_QUOTES.has(quote)) {
        const partial = avg.known_amount < avg.amount * 0.999;
        rt.mineLines.push(rt.main.createPriceLine({
          price: avg.avg_cost_usd, color: t.palette[3], lineWidth: 1, lineStyle: LWC.LineStyle.Solid,
          axisLabelVisible: true, title: `Avg cost${partial ? '*' : ''}`,
        }));
      }

      // Fills: one marker per bar and side, positioned on the bar they fall in.
      const bars = this.entry(rt.key).bars;
      const markers: any[] = [];
      if (mine?.fills.length && bars.length) {
        const times = bars.map((b) => b.time);
        const groups = new Map<string, { time: number; buy: boolean; n: number; amount: number }>();
        for (const f of mine.fills) {
          if (!ChartWorkspace.quoteMatches(f.quote, quote) || f.time < times[0]) continue;
          const i = ChartGeo.floorIndex(times, f.time);
          if (i < 0) continue;
          const buy = f.side === 'buy';
          const k = `${times[i]}|${buy}`;
          const g = groups.get(k) || { time: times[i], buy, n: 0, amount: 0 };
          g.n += 1;
          g.amount += f.amount;
          groups.set(k, g);
        }
        for (const g of Array.from(groups.values()).sort((a, b) => a.time - b.time)) {
          markers.push({
            time: g.time, position: g.buy ? 'belowBar' : 'aboveBar',
            color: g.buy ? t.pos : t.neg, shape: g.buy ? 'arrowUp' : 'arrowDown',
            text: `${g.buy ? 'B' : 'S'}${g.n > 1 ? `×${g.n}` : ''}`,
          });
        }
      }
      if (!rt.markers) {
        if (!markers.length) continue;
        rt.markers = LWC.createSeriesMarkers(rt.main, markers);
      } else {
        rt.markers.setMarkers(markers);
      }
    }
  }

  private static fmtAmount(n: number): string {
    if (!isFinite(n)) return '';
    const a = Math.abs(n);
    return n.toLocaleString(undefined, { maximumFractionDigits: a >= 100 ? 2 : a >= 1 ? 4 : 8 });
  }

  private applyIndicators(rt: PaneRuntime, bars: ChartBar[]): void {
    for (const ir of rt.indicators) {
      if (ir.script) { this.applyScript(rt, ir); continue; }
      const lines = ir.def.compute(bars, ir.spec.params as Record<string, number>);
      for (const l of lines) {
        const s = ir.series.get(l.key);
        if (!s) continue;
        if (l.kind === 'histogram') {
          const tone = (p: IndicatorPoint) => p.color === 'muted' ? this.theme.text
            : p.color === 'pos' || (!p.color && p.value >= 0) ? this.theme.pos : this.theme.neg;
          s.setData(l.points.map((p) => ({ time: p.time, value: p.value, color: ChartTheme.alpha(tone(p), 0.5) })));
        } else {
          // A line segment takes its starting point's colour, so the point
          // before a gap goes transparent and a reset starts clean.
          s.setData(l.points.map((p, i) => (l.points[i + 1]?.gap
            ? { time: p.time, value: p.value, color: 'rgba(0,0,0,0)' }
            : { time: p.time, value: p.value })));
        }
      }
    }
  }

  /** Fetch the newest few bars for every pane and merge them in. */
  private async pollLatest(): Promise<void> {
    if (!this.chart) return;
    const keys = new Map<string, ChartPaneState>();
    this.panes.forEach((p) => { if (this.entry(p.key).loaded && !this.entry(p.key).error) keys.set(p.key, p.st); });
    // Bars that changed, per data key.
    const changed = new Map<string, Map<number, ChartBar>>();
    await Promise.all(Array.from(keys.entries()).map(async ([key, st]) => {
      try {
        const resp = await MarketData.getCandles(AuthController.getToken() || '', {
          symbol: st.symbol, source: st.source, timeframe: this.state.timeframe, limit: 3,
        });
        const e = this.entry(key);
        const mine = new Map<number, ChartBar>();
        for (const b of resp.data?.candles || []) {
          const last = e.bars[e.bars.length - 1];
          if (!last || b.time > last.time) { e.bars.push(b); mine.set(b.time, b); }
          else if (b.time === last.time) { e.bars[e.bars.length - 1] = b; mine.set(b.time, b); }
        }
        if (mine.size) changed.set(key, mine);
      } catch { /* try again next cycle */ }
    }));
    if (!changed.size || this.destroyed || !this.chart) return;

    const lastAxis = this.axis[this.axis.length - 1];
    const axisSet = new Set(this.axis);
    const appendedSet = new Set<number>();
    let needFull = !this.axis.length;
    changed.forEach((m) => m.forEach((_b, t) => {
      if (axisSet.has(t)) return;
      if (t > lastAxis) appendedSet.add(t);
      else needFull = true;   // a gap filled mid-axis: re-set everything
    }));
    if (needFull) { this.applyData(); return; }

    // New times only ever arrive at the end here, so update() keeps the viewport.
    const appended = Array.from(appendedSet).sort((a, b) => a - b);
    this.axis.push(...appended);
    let headsDirty = false;
    for (const rt of this.panes) {
      const line = rt.isLine;
      const mine = changed.get(rt.key);
      if (mine && this.runScripts(rt, this.entry(rt.key).bars)) headsDirty = true;
      const painted = mine && !line ? this.barColors(rt) : null;
      for (const t of [lastAxis, ...appended]) {
        const b = mine?.get(t);
        try {
          if (!b) { if (t > lastAxis) rt.main.update({ time: t }); continue; }
          rt.main.update(line ? { time: t, value: b.close } : this.paintedBar(b, painted?.get(t)));
          rt.volume?.update({ time: t, value: b.volume, color: ChartTheme.alpha(b.close >= b.open ? this.theme.pos : this.theme.neg, 0.35) });
        } catch { /* out of order; the next full load fixes it */ }
      }
      if (mine) this.applyIndicators(rt, this.entry(rt.key).bars);
    }
    if (headsDirty) this.renderHeads();
    else this.updateLegends(null);
    this.redraw();
  }

  /** Load older candles when the user scrolls near the left edge of a pane's data. */
  private maybeLoadOlder(range: any): void {
    if (!range || !this.chart) return;
    this.layoutHeads();
    // % mode measures from the first bar on screen, which just moved.
    if (this.percentMode) this.updateLegends(null);
    for (const rt of this.panes) {
      const e = this.entry(rt.key);
      if (!e.loaded || !e.hasMore || e.olderLoading || !e.bars.length) continue;
      const firstIdx = ChartGeo.floorIndex(this.axis, e.bars[0].time);
      if (range.from > firstIdx + 25) continue;
      e.olderLoading = true;
      const st = rt.st;
      void (async () => {
        try {
          const resp = await MarketData.getCandles(AuthController.getToken() || '', {
            symbol: st.symbol, source: st.source, timeframe: this.state.timeframe, before: e.bars[0].time,
          });
          const first = e.bars[0]?.time ?? Infinity;
          const older = (resp.data?.candles || []).filter((b) => b.time < first);
          e.bars = older.concat(e.bars);
          e.hasMore = !!resp.data?.has_more && older.length > 0;
        } catch {
          e.hasMore = false;
        }
        e.olderLoading = false;
        if (!this.destroyed && this.panes.some((p) => p.key === rt.key)) this.applyData();
      })();
    }
  }

  // ── Geometry for drawings ─────────────────────────────────────────────────

  private paneElement(rt: { paneIndex: number }): HTMLElement | null {
    return this.chart?.panes()[rt.paneIndex]?.getHTMLElement() ?? null;
  }

  frameFor(rt: PaneRuntime): DrawingFrame | null {
    if (!this.chart || !this.axis.length) return null;
    const ts = this.chart.timeScale();
    const axis = this.axis, step = this.step;
    const lr = ts.getVisibleLogicalRange();
    return {
      toX: (t) => ts.logicalToCoordinate(ChartGeo.timeToLogical(axis, t, step)),
      toY: (p) => rt.main.priceToCoordinate(p),
      logical: (t) => ChartGeo.timeToLogical(axis, t, step),
      width: ts.width(),
      height: this.paneElement(rt)?.clientHeight || 0,
      theme: this.theme,
      bars: this.entry(rt.key).bars,
      visible: lr
        ? [ChartGeo.logicalToTime(axis, lr.from, step), ChartGeo.logicalToTime(axis, lr.to, step)]
        : [axis[0], axis[axis.length - 1]],
    };
  }

  /** The symbol pane under a client point (not an oscillator pane or the axes). */
  locate(clientX: number, clientY: number): { rt: PaneRuntime; x: number; y: number; frame: DrawingFrame } | null {
    if (!this.chart) return null;
    const box = this.chartEl.getBoundingClientRect();
    const x = clientX - box.left;
    if (x < 0 || x > this.chart.timeScale().width()) return null;
    for (const rt of this.panes) {
      if (this.percentMode && rt.order > 0) continue;
      const el = this.paneElement(rt);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) {
        const frame = this.frameFor(rt);
        return frame ? { rt, x, y: clientY - r.top, frame } : null;
      }
    }
    return null;
  }

  /** Pane-relative coordinates for a client point, in a given pane (even outside it). */
  locateIn(paneId: string, clientX: number, clientY: number): { rt: PaneRuntime; x: number; y: number; frame: DrawingFrame } | null {
    const rt = this.panes.find((p) => p.st.id === paneId);
    const el = rt && this.paneElement(rt);
    if (!rt || !el) return null;
    const box = this.chartEl.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const frame = this.frameFor(rt);
    return frame ? { rt, x: clientX - box.left, y: clientY - r.top, frame } : null;
  }

  xToLogical(x: number): number {
    return this.chart?.timeScale().coordinateToLogical(x) ?? 0;
  }

  logicalToTime(l: number): number { return ChartGeo.logicalToTime(this.axis, l, this.step); }
  timeToLogical(t: number): number { return ChartGeo.timeToLogical(this.axis, t, this.step); }

  /** The (time, price) under pane coordinates, optionally snapped to the nearest O/H/L/C. */
  pointAt(rt: PaneRuntime, x: number, y: number, magnet: boolean): ChartPoint {
    const l = this.xToLogical(x);
    let time = this.logicalToTime(l);
    let price = rt.main.coordinateToPrice(y) ?? 0;
    if (magnet && this.axis.length) {
      const idx = Math.max(0, Math.min(this.axis.length - 1, Math.round(l)));
      const t = this.axis[idx];
      const bar = this.entry(rt.key).bars.find((b) => b.time === t);
      if (bar) {
        let best = price, bestD = Infinity;
        for (const v of [bar.open, bar.high, bar.low, bar.close]) {
          const vy = rt.main.priceToCoordinate(v);
          if (vy != null && Math.abs(vy - y) < bestD) { bestD = Math.abs(vy - y); best = v; }
        }
        if (bestD <= 40) { price = best; time = t; }
      }
    }
    return { time, price };
  }

  paneState(paneId: string): ChartPaneState | undefined {
    return this.state.panes.find((p) => p.id === paneId);
  }

  redraw(): void {
    this.panes.forEach((p) => p.primitive.update());
  }

  // ── Pane headers ──────────────────────────────────────────────────────────

  private renderHeads(): void {
    this.headsEl.innerHTML = '';
    const esc = ChartWorkspace.esc;
    const edit = this.opts.mode === 'edit';
    for (const rt of this.panes) {
      const e = this.entry(rt.key);
      const h = rt.headerEl;
      h.className = 'cw-head';
      const status = e.error ? `<span class="cw-status cw-status-err">${esc(e.error)}</span>`
        : !e.loaded ? '<span class="cw-status">Loading…</span>' : '';
      const sym = edit
        ? `<button type="button" class="cw-sym" data-act="symbol" title="Change symbol or exchange">${esc(rt.st.symbol)} <i class="fa-solid fa-chevron-down"></i></button>`
        : `<span class="cw-sym">${esc(rt.st.symbol)}</span>`;
      const actions = edit ? `<span class="cw-actions">
          <button type="button" data-act="indicators" title="Add an indicator"><i class="fa-solid fa-wave-square"></i></button>
          <button type="button" data-act="volume" class="${rt.st.volume ? 'on' : ''}" title="${rt.st.volume ? 'Hide' : 'Show'} volume"><i class="fa-solid fa-chart-column"></i></button>
          ${this.state.panes.length > 1 ? '<button type="button" data-act="remove" title="Remove this pane"><i class="fa-solid fa-xmark"></i></button>' : ''}
        </span>` : '';
      const overlays = rt.indicators.filter((i) => i.def.overlay).map((i) => this.indicatorChip(rt, i)).join('');
      const swatch = rt.color ? `<i class="cw-swatch cw-line-swatch" style="background:${esc(rt.color)}"></i>` : '';
      h.innerHTML = `<div class="cw-head-row">${swatch}${sym}<span class="cw-src">${esc(ChartWorkspace.sourceName(rt.st.source))} · ${esc(this.state.timeframe)}</span>
          <span class="cw-ohlc"></span>${status}${actions}</div>
        ${overlays ? `<div class="cw-chips">${overlays}</div>` : ''}`;
      this.headsEl.appendChild(h);
      for (const ir of rt.indicators) {
        if (ir.def.overlay) { ir.headerEl = null; continue; }
        const oh = document.createElement('div');
        oh.className = 'cw-head cw-head-osc';
        oh.innerHTML = `<div class="cw-chips">${this.indicatorChip(rt, ir)}</div>`;
        ir.headerEl = oh;
        this.headsEl.appendChild(oh);
      }
    }
    this.headsEl.querySelectorAll<HTMLElement>('[data-act]').forEach((btn) => {
      btn.addEventListener('click', (ev) => this.onHeadAction(ev, btn));
    });
    // Script tables live in the same overlay, which was just emptied.
    for (const rt of this.panes) for (const ir of rt.indicators) ir.script?.tableEls.forEach((el) => this.headsEl.appendChild(el));
    this.updateLegends(null);
    this.layoutHeads();
  }

  private indicatorChip(rt: PaneRuntime, ir: IndicatorRuntime): string {
    const esc = ChartWorkspace.esc;
    const sr = ir.script;
    const firstPlot = sr?.result?.outputs.find((o) => o.kind === 'plot' && ScriptRender.shown(o, ir.spec.styles));
    const color = (firstPlot && (ir.spec.styles?.[firstPlot.key]?.color || firstPlot.color)) || ir.spec.color || this.theme.palette[3];
    const edit = this.opts.mode === 'edit';
    const off = sr ? sr.off : !ir.series.size && !ir.primitive;
    const err = sr?.error || '';
    const name = ir.def.short(ir.spec.params as Record<string, number>);
    const ids = `data-pane="${esc(rt.st.id)}" data-ind="${esc(ir.spec.id)}"`;
    const title = off ? ' title="Price overlays are off while coins are compared in %"' : err ? ` title="${esc(err)}"` : '';
    const scriptTools = sr && edit && CustomIndicators.get(ir.spec.scriptId) ? `
          <button type="button" class="cw-chip-btn" data-act="ind-code" ${ids} title="Open in Pine Editor" aria-label="Open ${esc(ir.def.label)} in the Pine Editor"><i class="fa-solid fa-code"></i></button>
          ${sr?.compiled && (sr.compiled.alertConditions.length || sr.compiled.usesAlertFn) ? `<button type="button" class="cw-chip-btn" data-act="ind-alert" ${ids} title="Add an alert on this indicator" aria-label="Add an alert on ${esc(ir.def.label)}"><i class="fa-regular fa-bell"></i></button>` : ''}` : '';
    return `<span class="cw-chip${off ? ' cw-chip-off' : ''}${err ? ' cw-chip-err' : ''}" data-ind="${esc(ir.spec.id)}"${title}>
        <i class="cw-swatch" style="background:${esc(color)}"></i>
        ${edit ? `<button type="button" class="cw-chip-name" data-act="ind-edit" ${ids} title="Settings">${esc(name)}</button>`
               : `<span class="cw-chip-name">${esc(name)}</span>`}
        ${err ? `<span class="cw-chip-errtext"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(err.length > 70 ? `${err.slice(0, 70)}…` : err)}</span>` : '<span class="cw-chip-val"></span>'}
        ${edit ? `<span class="cw-chip-tools">${scriptTools}
          <button type="button" class="cw-chip-btn" data-act="ind-edit" ${ids} title="Settings" aria-label="${esc(ir.def.label)} settings"><i class="fa-solid fa-gear"></i></button>
          <button type="button" class="cw-chip-btn cw-chip-x" data-act="ind-remove" ${ids} title="Remove ${esc(ir.def.label)}" aria-label="Remove ${esc(ir.def.label)}"><i class="fa-solid fa-xmark"></i></button>
        </span>` : ''}
      </span>`;
  }

  private onHeadAction(ev: Event, btn: HTMLElement): void {
    ev.preventDefault();
    ev.stopPropagation();
    const act = btn.dataset.act;
    const head = btn.closest('.cw-head') as HTMLElement | null;
    const rt = this.panes.find((p) => p.headerEl === head) ||
      this.panes.find((p) => p.st.id === btn.dataset.pane);
    if (!rt) return;
    switch (act) {
      case 'symbol': this.opts.onPaneAction?.(rt.st.id, 'symbol', btn); break;
      case 'indicators': this.opts.onPaneAction?.(rt.st.id, 'indicators', btn); break;
      case 'volume': this.toggleVolume(rt.st.id); break;
      case 'remove': this.removePane(rt.st.id); break;
      case 'ind-remove': this.removeIndicator(rt.st.id, btn.dataset.ind || ''); break;
      case 'ind-edit': this.openIndicatorSettings(rt.st.id, btn.dataset.ind || '', btn); break;
      case 'ind-code': this.opts.onScriptAction?.('edit', rt.st.id, btn.dataset.ind || '', btn); break;
      case 'ind-alert': this.opts.onScriptAction?.('alert', rt.st.id, btn.dataset.ind || '', btn); break;
    }
  }

  private layoutHeads(): void {
    if (!this.chart) return;
    const top = this.root.getBoundingClientRect().top;
    const place = (el: HTMLElement | null, paneIndex: number, offset = 0) => {
      const pel = this.chart.panes()[paneIndex]?.getHTMLElement();
      if (!el || !pel) return;
      el.style.top = `${pel.getBoundingClientRect().top - top + 4 + offset}px`;
    };
    let stacked = 0;
    for (const rt of this.panes) {
      place(rt.headerEl, rt.paneIndex, this.percentMode ? stacked : 0);
      if (this.percentMode) stacked += rt.headerEl.offsetHeight + 2;
      rt.indicators.forEach((ir) => { if (!ir.def.overlay) place(ir.headerEl, ir.paneIndex); });
    }
    this.headsEl.style.right = `${(this.chart.priceScale('right', 0)?.width?.() || 60) + 8}px`;
    for (const rt of this.panes) for (const ir of rt.indicators) this.layoutTables(ir);
  }

  /** O/H/L/C and indicator values under the crosshair (or the latest bar). */
  private updateLegends(param: any): void {
    for (const rt of this.panes) {
      const stock = ChartWorkspace.isStock(rt.st.source);
      const fmt = (p: number) => ChartGeo.formatPrice(p, stock);
      const bars = this.entry(rt.key).bars;
      const bar = param?.time != null ? ChartWorkspace.barAt(bars, param.time) : bars[bars.length - 1];
      const el = rt.headerEl.querySelector('.cw-ohlc');
      if (el) {
        if (!bar) el.innerHTML = '';
        else if (this.percentMode) {
          const base = this.firstVisibleBar(bars);
          const ch = base?.close ? ((bar.close - base.close) / base.close) * 100 : 0;
          const tone = ch >= 0 ? 'cw-pos' : 'cw-neg';
          el.innerHTML = `<b>C</b>${fmt(bar.close)} <span class="${tone}">${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%</span>`;
        } else {
          const ch = bar.open ? ((bar.close - bar.open) / bar.open) * 100 : 0;
          const tone = ch >= 0 ? 'cw-pos' : 'cw-neg';
          el.innerHTML = `<b>O</b>${fmt(bar.open)} <b>H</b>${fmt(bar.high)} <b>L</b>${fmt(bar.low)} <b>C</b><span class="${tone}">${fmt(bar.close)}</span> <span class="${tone}">${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%</span>`;
        }
      }
      for (const ir of rt.indicators) {
        const holder = ir.headerEl || rt.headerEl;
        const val = holder.querySelector(`.cw-chip[data-ind="${CSS.escape(ir.spec.id)}"] .cw-chip-val`);
        if (!val) continue;
        if (ir.script) {
          val.innerHTML = this.scriptLegend(ir, param?.time ?? null);
          continue;
        }
        const parts: string[] = [];
        ir.series.forEach((s) => {
          const d = param?.seriesData?.get(s) ?? (param?.time == null ? s.data()[s.data().length - 1] : undefined);
          if (d && typeof d.value === 'number') parts.push(ir.def.overlay ? fmt(d.value) : d.value.toFixed(2));
        });
        val.textContent = parts.join(' ');
      }
    }
  }

  /** Where a popover goes: under its anchor, kept inside the chart. */
  private placePopover(pop: HTMLElement, anchor: HTMLElement): void {
    this.root.appendChild(pop);
    const a = anchor.getBoundingClientRect(), r = this.root.getBoundingClientRect();
    const w = pop.offsetWidth || 230;
    pop.style.left = `${Math.max(4, Math.min(a.left - r.left, r.width - w - 4))}px`;
    // Below the anchor, or above it when that's where the room is.
    const below = r.height - (a.bottom - r.top) - 12, above = a.top - r.top - 12;
    const h = pop.offsetHeight;
    if (h > below && above > below) {
      const maxH = Math.max(160, above);
      pop.style.maxHeight = `${maxH}px`;
      pop.style.top = `${Math.max(4, a.top - r.top - 6 - Math.min(h, maxH))}px`;
    } else {
      pop.style.top = `${a.bottom - r.top + 6}px`;
      pop.style.maxHeight = `${Math.max(160, below)}px`;
    }
    this.popover = pop;
  }

  /** TradingView-style settings for a script: its inputs, and a style row per output. */
  private openScriptSettings(paneId: string, indId: string, anchor: HTMLElement): void {
    const spec = this.paneState(paneId)?.indicators.find((i) => i.id === indId);
    if (!spec) return;
    this.closePopover();
    const esc = ChartWorkspace.esc;
    const run = this.scriptRun(paneId, indId);
    const c = run?.compiled ?? CustomIndicators.compiled(spec.scriptId)?.compiled ?? null;
    const pop = document.createElement('div');
    pop.className = 'cw-popover cw-script-pop';
    const remove = '<button type="button" class="cw-pop-remove" data-pop="remove"><i class="fa-regular fa-trash-can"></i> Remove</button>';
    if (!c) {
      const err = run?.error || CustomIndicators.compiled(spec.scriptId)?.error?.message || 'This script was deleted.';
      pop.innerHTML = `<div class="cw-pop-title">${esc(CustomIndicators.label(spec))}</div>
        <p class="cw-pop-note">${esc(err)}</p>
        <div class="cw-pop-actions">${remove}<span class="cw-pop-spacer"></span>
          ${CustomIndicators.get(spec.scriptId) ? '<button type="button" class="btn-primary" data-pop="code">Open in Pine Editor</button>' : ''}</div>`;
      pop.querySelector('[data-pop="remove"]')?.addEventListener('click', () => { this.closePopover(); this.removeIndicator(paneId, indId); });
      pop.querySelector('[data-pop="code"]')?.addEventListener('click', () => { this.closePopover(); this.opts.onScriptAction?.('edit', paneId, indId, anchor); });
      this.placePopover(pop, anchor);
      return;
    }
    const params = CustomIndicators.params(c, spec.params);
    const styles = spec.styles || {};

    // Inputs, grouped and laid out on rows the way the script asks (group / inline).
    let inputsHtml = '';
    let group: string | undefined;
    for (let k = 0; k < c.inputs.length; k++) {
      const i = c.inputs[k];
      if (i.group && i.group !== group) inputsHtml += `<div class="cw-pop-group">${esc(i.group)}</div>`;
      group = i.group;
      const row: PineInputDef[] = [i];
      while (i.inline && c.inputs[k + 1]?.inline === i.inline) row.push(c.inputs[++k]);
      inputsHtml += `<div class="cw-pop-inrow">${row.map((d) => this.inputField(d, params[d.key])).join('')}</div>`;
    }
    if (!c.inputs.length) inputsHtml = '<p class="cw-pop-note">This script has no inputs.</p>';

    // Style: one row per output that draws something.
    const outs: { key: string; kind: PineOutputKind; title: string; color: string | null; width: number; visible: boolean }[] =
      // editable=false outputs are the script's own scaffolding (TradingView hides them too).
      (run?.result?.outputs || []).filter((o) => o.kind !== 'alertcondition' && o.editable).map((o) => ({
        key: o.key, kind: o.kind, title: o.title, width: o.width,
        color: o.color || o.colors.find((x) => x) || null,
        visible: (o.display & 1) !== 0,
      }));
    const kindName: Record<string, string> = { plot: 'Plot', shape: 'Shape', char: 'Character', arrow: 'Arrows', hline: 'Level', fill: 'Fill', bg: 'Background', bar: 'Bar colour' };
    const styleHtml = outs.length ? outs.map((o) => {
      const ov = styles[o.key] || {};
      const vis = ov.visible ?? o.visible;
      const col = ov.color || o.color;
      const hex = col ? PineColors.toHex(PineColors.parse(col) || PineColors.rgb(41, 98, 255)) : '#2962ff';
      const title = o.title && o.title !== o.key ? o.title : kindName[o.kind] || o.key;
      return `<div class="cw-pop-style" data-out="${esc(o.key)}">
          <label class="cw-pop-check"><input type="checkbox" data-s="visible"${vis ? ' checked' : ''}> <span>${esc(title)}</span></label>
          <span class="cw-pop-spacer"></span>
          <input type="color" data-s="color" value="${hex}" title="Colour"${col ? '' : ' data-unset="1"'}>
          ${o.kind === 'plot' || o.kind === 'hline' ? `<input type="number" data-s="width" min="1" max="10" step="1" value="${ov.width || o.width || 1}" title="Line width">` : ''}
        </div>`;
    }).join('') : '<p class="cw-pop-note">Styles appear once the script has run on this chart.</p>';

    pop.innerHTML = `<div class="cw-pop-title">${esc(c.title)}</div>
      <div class="cw-pop-tabs" role="tablist">
        <button type="button" class="on" data-tab="inputs" role="tab">Inputs</button>
        <button type="button" data-tab="style" role="tab">Style</button>
      </div>
      <div class="cw-pop-body" data-body="inputs">${inputsHtml}</div>
      <div class="cw-pop-body d-none" data-body="style">${styleHtml}</div>
      <div class="cw-pop-actions">${remove}<button type="button" class="btn-cancel" data-pop="defaults" title="Reset inputs and styles">Defaults</button>
        <span class="cw-pop-spacer"></span><button type="button" class="btn-cancel" data-pop="cancel">Cancel</button><button type="button" class="btn-primary" data-pop="apply">Apply</button></div>`;

    pop.querySelectorAll<HTMLElement>('[data-tab]').forEach((t) => t.addEventListener('click', () => {
      pop.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === t));
      pop.querySelectorAll<HTMLElement>('[data-body]').forEach((b) => b.classList.toggle('d-none', b.dataset.body !== t.dataset.tab));
    }));
    pop.querySelectorAll<HTMLInputElement>('input[type="color"][data-s]').forEach((inp) => inp.addEventListener('input', () => { delete inp.dataset.unset; }));
    pop.querySelector('[data-pop="cancel"]')?.addEventListener('click', () => this.closePopover());
    pop.querySelector('[data-pop="remove"]')?.addEventListener('click', () => { this.closePopover(); this.removeIndicator(paneId, indId); });
    pop.querySelector('[data-pop="defaults"]')?.addEventListener('click', () => {
      this.closePopover();
      const ind = this.paneState(paneId)?.indicators.find((i) => i.id === indId);
      if (!ind) return;
      ind.params = PineEngine.defaults(c);
      ind.styles = {};
      this.rebuild(true);
      this.changed();
    });
    pop.querySelector('[data-pop="apply"]')?.addEventListener('click', () => {
      const next: Record<string, number | boolean | string> = {};
      for (const d of c.inputs) {
        const el = pop.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-k="${CSS.escape(d.key)}"]`);
        if (!el) continue;
        next[d.key] = this.readInput(d, el, params[d.key]);
      }
      const nextStyles: Record<string, ChartScriptStyle> = {};
      for (const o of outs) {
        const row = pop.querySelector<HTMLElement>(`.cw-pop-style[data-out="${CSS.escape(o.key)}"]`);
        if (!row) continue;
        const st: ChartScriptStyle = {};
        const vis = (row.querySelector('[data-s="visible"]') as HTMLInputElement).checked;
        if (vis !== o.visible) st.visible = vis;
        const colEl = row.querySelector('[data-s="color"]') as HTMLInputElement;
        const origHex = o.color ? PineColors.toHex(PineColors.parse(o.color) || PineColors.rgb(0, 0, 0)) : null;
        if (!colEl.dataset.unset && colEl.value.toLowerCase() !== origHex?.toLowerCase()) {
          // Keep the output's own transparency when only the hue changes.
          const p = PineColors.parse(colEl.value)!;
          const t = o.color ? PineColors.parse(o.color)?.t ?? 0 : 0;
          st.color = PineColors.css({ ...p, t }) || colEl.value;
        }
        const wEl = row.querySelector('[data-s="width"]') as HTMLInputElement | null;
        if (wEl) {
          const w = Math.max(1, Math.min(10, Math.round(Number(wEl.value) || 1)));
          if (w !== o.width) st.width = w;
        }
        if (Object.keys(st).length) nextStyles[o.key] = st;
      }
      this.closePopover();
      const ind = this.paneState(paneId)?.indicators.find((i) => i.id === indId);
      if (ind) ind.params = {};
      this.updateIndicator(paneId, indId, next, undefined, nextStyles);
    });
    this.placePopover(pop, anchor);
  }

  /** One input's control in the settings dialog. */
  private inputField(d: PineInputDef, value: any): string {
    const esc = ChartWorkspace.esc;
    const tip = d.tooltip ? ` <i class="fa-regular fa-circle-question cw-pop-tip" title="${esc(d.tooltip)}"></i>` : '';
    const key = esc(d.key);
    let control: string;
    if (d.type === 'bool') {
      return `<label class="cw-pop-check"><input type="checkbox" data-k="${key}"${value ? ' checked' : ''}> <span>${esc(d.title)}</span>${tip}</label>`;
    }
    if (d.options && d.options.length) {
      control = `<select data-k="${key}">${d.options.map((o) => `<option value="${esc(String(o))}"${String(o) === String(value) ? ' selected' : ''}>${esc(String(o))}</option>`).join('')}</select>`;
    } else if (d.type === 'source') {
      control = `<select data-k="${key}">${PineCompiler.SOURCES.map((s) => `<option value="${s}"${s === value ? ' selected' : ''}>${s}</option>`).join('')}</select>`;
    } else if (d.type === 'color') {
      const p = PineColors.parse(String(value)) || PineColors.parse(String(d.def));
      control = `<input type="color" data-k="${key}" value="${p ? PineColors.toHex(p) : '#2962ff'}">`;
    } else if (d.type === 'int' || d.type === 'float') {
      const step = d.step ?? (d.type === 'int' ? 1 : 'any');
      control = `<input type="number" data-k="${key}" value="${esc(String(value))}"${d.min != null ? ` min="${d.min}"` : ''}${d.max != null ? ` max="${d.max}"` : ''} step="${step}">`;
    } else if (d.type === 'timeframe') {
      control = `<select data-k="${key}" disabled><option value="">Same as chart</option></select>`;
    } else {
      control = `<input type="text" data-k="${key}" value="${esc(String(value ?? ''))}">`;
    }
    return `<label class="cw-pop-field"><span>${esc(d.title)}${tip}</span>${control}</label>`;
  }

  /** Read one input's control back into a setting. */
  private readInput(d: PineInputDef, el: HTMLInputElement | HTMLSelectElement, prev: any): number | boolean | string {
    if (d.type === 'bool') return (el as HTMLInputElement).checked;
    if (d.type === 'int' || d.type === 'float') {
      let v = Number(el.value);
      if (!isFinite(v)) return prev;
      if (d.min != null) v = Math.max(d.min, v);
      if (d.max != null) v = Math.min(d.max, v);
      return d.type === 'int' ? Math.round(v) : v;
    }
    if (d.type === 'color') {
      // Keep the default's transparency (the picker has none).
      const p = PineColors.parse(el.value);
      const t = PineColors.parse(String(prev))?.t ?? PineColors.parse(String(d.def))?.t ?? 0;
      return p ? PineColors.css({ ...p, t }) || el.value : prev;
    }
    if (d.type === 'timeframe') return '';
    return el.value;
  }

  private openIndicatorSettings(paneId: string, indId: string, anchor: HTMLElement): void {
    const spec = this.paneState(paneId)?.indicators.find((i) => i.id === indId);
    if (spec?.type === 'script') { this.openScriptSettings(paneId, indId, anchor); return; }
    const def = spec && ChartIndicators.get(spec.type);
    if (!spec || !def) return;
    this.closePopover();
    const esc = ChartWorkspace.esc;
    const pop = document.createElement('div');
    pop.className = 'cw-popover';
    pop.innerHTML = `<div class="cw-pop-title">${esc(def.label)}</div>
      ${def.params.map((p) => `<label class="cw-pop-field"><span>${esc(p.label)}</span>
        ${p.options
          ? `<select data-k="${esc(p.key)}">${p.options.map((o) => `<option value="${o.value}"${o.value === spec.params[p.key] ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`
          : `<input type="number" data-k="${esc(p.key)}" value="${spec.params[p.key]}" min="${p.min}" max="${p.max}" step="${p.step || 1}">`}</label>`).join('')}
      <div class="cw-pop-swatches">${this.theme.palette.map((c) => `<button type="button" class="cw-swatch-btn${c === spec.color ? ' on' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('')}</div>
      <div class="cw-pop-actions"><button type="button" class="cw-pop-remove" data-pop="remove"><i class="fa-regular fa-trash-can"></i> Remove</button><span class="cw-pop-spacer"></span><button type="button" class="btn-cancel" data-pop="cancel">Cancel</button><button type="button" class="btn-primary" data-pop="apply">Apply</button></div>`;
    let color = spec.color;
    pop.querySelectorAll<HTMLElement>('.cw-swatch-btn').forEach((b) => b.addEventListener('click', () => {
      color = b.dataset.color;
      pop.querySelectorAll('.cw-swatch-btn').forEach((x) => x.classList.toggle('on', x === b));
    }));
    pop.querySelector('[data-pop="cancel"]')?.addEventListener('click', () => this.closePopover());
    pop.querySelector('[data-pop="remove"]')?.addEventListener('click', () => {
      this.closePopover();
      this.removeIndicator(paneId, indId);
    });
    pop.querySelector('[data-pop="apply"]')?.addEventListener('click', () => {
      const params: Record<string, number> = {};
      pop.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[data-k], select[data-k]').forEach((inp) => {
        const p = def.params.find((x) => x.key === inp.dataset.k)!;
        const v = Number(inp.value);
        params[p.key] = isFinite(v) ? Math.max(p.min, Math.min(p.max, v)) : p.def;
      });
      this.closePopover();
      this.updateIndicator(paneId, indId, params, color);
    });
    this.root.appendChild(pop);
    const a = anchor.getBoundingClientRect(), r = this.root.getBoundingClientRect();
    pop.style.left = `${Math.min(a.left - r.left, r.width - 230)}px`;
    pop.style.top = `${a.bottom - r.top + 6}px`;
    this.popover = pop;
  }

  closePopover(): void {
    this.popover?.remove();
    this.popover = null;
  }

  // ── Misc ──────────────────────────────────────────────────────────────────

  /**
   * PNG-ready canvas of the chart under a Cyrus header: the logo and
   * wordmark, the chart's name, what it shows (coins, exchanges, timeframe)
   * and when it was taken. Pane titles and indicator names are burned in too,
   * since the on-screen headers are HTML and not part of the chart canvas.
   */
  screenshot(title: string): HTMLCanvasElement | null {
    if (!this.chart) return null;
    const shot: HTMLCanvasElement = this.chart.takeScreenshot();
    const ratio = shot.width / Math.max(1, this.chartEl.clientWidth);
    const cssW = shot.width / ratio;
    const HEAD = 56;
    const css = getComputedStyle(document.body);
    const tok = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const t = this.theme;
    const bg = tok('--bg-secondary', t.dark ? '#121517' : '#FFFFFF');
    const headBg = tok('--bg-primary', t.dark ? '#0B0D0E' : '#F3F4F1');
    const textMain = tok('--text-primary', t.dark ? '#E6E8E6' : '#111413');
    const textMuted = tok('--text-muted', t.text);
    const border = tok('--border-secondary', t.border);
    const sans = tok('--font-sans', "'Inter Tight', 'Segoe UI', sans-serif");

    const out = document.createElement('canvas');
    out.width = shot.width;
    out.height = shot.height + Math.round(HEAD * ratio);
    const o = out.getContext('2d')!;
    o.fillStyle = bg;
    o.fillRect(0, 0, out.width, out.height);
    o.drawImage(shot, 0, Math.round(HEAD * ratio));
    o.setTransform(ratio, 0, 0, ratio, 0, 0);

    // Header band
    o.fillStyle = headBg;
    o.fillRect(0, 0, cssW, HEAD);
    o.fillStyle = border;
    o.fillRect(0, HEAD - 1, cssW, 1);

    // Logo mark: the same drawing as the app's top bar (64x64 viewBox).
    const size = 30, lx = 14, ly = (HEAD - size) / 2;
    o.save();
    o.translate(lx, ly);
    o.scale(size / 64, size / 64);
    const markBox = new Path2D();
    (markBox as any).roundRect ? (markBox as any).roundRect(0.75, 0.75, 62.5, 62.5, 13.25) : markBox.rect(0.75, 0.75, 62.5, 62.5);
    o.fillStyle = '#0B0D0E';
    o.fill(markBox);
    o.strokeStyle = '#262C1E';
    o.lineWidth = 1.5;
    o.stroke(markBox);
    o.fillStyle = '#C6F432';
    o.fill(new Path2D('M11 14h25v7H18v22h18v7H11z'));
    o.fillRect(40, 44, 14, 6);
    o.restore();

    // Wordmark
    o.textBaseline = 'middle';
    o.textAlign = 'left';
    o.fillStyle = textMain;
    o.font = `700 14px ${t.font}`;
    (o as any).letterSpacing = '3px';
    const word = 'CYRUS';
    const wx = lx + size + 10;
    o.fillText(word, wx, HEAD / 2 + 0.5);
    const wordW = o.measureText(word).width + 3 * word.length;
    (o as any).letterSpacing = '0px';

    // Divider, then the chart's name and what it shows.
    const dx = wx + wordW + 14;
    o.fillStyle = border;
    o.fillRect(dx, 12, 1, HEAD - 24);
    const tx = dx + 14;
    o.fillStyle = textMain;
    o.font = `600 15px ${sans}`;
    o.fillText(title || 'Untitled', tx, 20);
    const tf = ({ '1h': '1H', '4h': '4H', '1d': '1D', '1w': '1W' } as Record<string, string>)[this.state.timeframe] || this.state.timeframe;
    const what = `${this.state.panes.map((p) => `${p.symbol} · ${ChartWorkspace.sourceName(p.source)}`).join('   |   ')}   ·   ${tf}`
      + (this.percentMode ? '   ·   compared in %' : '');
    o.fillStyle = textMuted;
    o.font = `11px ${t.font}`;
    o.fillText(what, tx, 38);

    // When it was taken, on the right.
    const now = new Date();
    const stamp = now.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    o.textAlign = 'right';
    o.fillStyle = textMuted;
    o.font = `11px ${t.font}`;
    o.fillText(stamp, cssW - 14, HEAD / 2 + 0.5);
    o.textAlign = 'left';

    // Pane titles and indicator names, where the HTML headers sit on screen.
    const chartTop = this.chartEl.getBoundingClientRect().top;
    const paneY = (paneIndex: number) => {
      const el = this.chart.panes()[paneIndex]?.getHTMLElement();
      return el ? el.getBoundingClientRect().top - chartTop + HEAD : null;
    };
    let stacked = 0;
    for (const rt of this.panes) {
      const top = paneY(rt.paneIndex);
      if (top == null) continue;
      const y = top + 14 + (this.percentMode ? stacked : 0);
      if (this.percentMode) stacked += 18;
      o.font = `600 13px ${sans}`;
      o.fillStyle = rt.color || textMain;
      o.fillText(rt.st.symbol, 10, y);
      const symW = o.measureText(rt.st.symbol).width;
      o.font = `11px ${t.font}`;
      o.fillStyle = textMuted;
      o.fillText(`${ChartWorkspace.sourceName(rt.st.source)} · ${tf}`, 18 + symW, y);
      const overlays = rt.indicators.filter((ir) => ir.def.overlay && (ir.series.size || ir.primitive));
      if (overlays.length && !this.percentMode) {
        o.fillText(overlays.map((ir) => ir.def.short(ir.spec.params as Record<string, number>)).join('   '), 10, y + 18);
      }
      for (const ir of rt.indicators) {
        if (ir.def.overlay) continue;
        const oy = paneY(ir.paneIndex);
        if (oy == null) continue;
        o.fillStyle = textMuted;
        o.fillText(ir.def.short(ir.spec.params as Record<string, number>), 10, oy + 12);
      }
    }
    return out;
  }

  /** Re-read theme colours (after a light/dark switch). */
  refreshTheme(): void {
    this.rebuild(true);
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubAlerts?.();
    this.unsubScripts?.();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.resizeObs?.disconnect();
    this.drawing?.destroy();
    this.drawing = null;
    this.teardownChart();
    this.root.remove();
  }

  /** This pane's first bar inside the visible range (the base of % mode). */
  private firstVisibleBar(bars: ChartBar[]): ChartBar | undefined {
    const lr = this.chart?.timeScale().getVisibleLogicalRange();
    if (!lr || !bars.length) return bars[0];
    const t = ChartGeo.logicalToTime(this.axis, Math.max(0, Math.ceil(lr.from)), this.step);
    const i = bars.findIndex((b) => b.time >= t);
    return i >= 0 ? bars[i] : bars[bars.length - 1];
  }

  /** The bar at exactly time `t` (binary search), if this pane has one. */
  static barAt(bars: ChartBar[], t: number): ChartBar | undefined {
    let lo = 0, hi = bars.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const mt = bars[mid].time;
      if (mt === t) return bars[mid];
      if (mt < t) lo = mid + 1; else hi = mid - 1;
    }
    return undefined;
  }

  static esc(s: string): string {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
  }
}
