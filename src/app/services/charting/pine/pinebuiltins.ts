/*
 * Pine Script built-ins: variables (close, bar_index, barstate.islast…),
 * named constants (plot.style_circles, position.top_right…) and functions
 * (ta.*, math.*, str.*, color.*, array.*, table.*).
 *
 * A stateful function (every ta.* that looks back) gets a state object that
 * belongs to its call site, so two ta.ema() calls never share a running value.
 * Look-back functions keep a buffer of the inputs that call site has seen and
 * work from it, which mirrors Pine's own series semantics.
 */

/** A Pine array. */
class PineArray {
  constructor(public items: any[] = [], public type = 'float') {}
}

interface PineTableCell {
  text: string;
  textColor: string | null;
  bg: string | null;
  halign: string;
  valign: string;
  size: string;
  tooltip: string;
  width: number;
  height: number;
}

/** A table, as table.new() returns it. Drawn as it stands after the last bar. */
class PineTable {
  cells: (PineTableCell | null)[][] = [];
  deleted = false;
  constructor(
    public position: string,
    public cols: number,
    public rows: number,
    public bg: string | null,
    public frameColor: string | null,
    public frameWidth: number,
    public borderColor: string | null,
    public borderWidth: number,
  ) {
    for (let r = 0; r < rows; r++) this.cells.push(new Array(cols).fill(null));
  }
}

/** What a built-in function gets from the runtime. */
interface PineHost {
  /** Current bar index. */
  i: number;
  bars: ChartBar[];
  version: number;
  opts: PineRunOptions;
  /** A whole-history series computed once per run (ta.obv, ta.vwap…). */
  pre(name: string): Float64Array;
  addTable(siteId: number, t: PineTable): void;
}

interface PineRunOptions {
  symbol: string;
  /** Exchange id (kraken) and display name (Kraken). */
  source: string;
  exchange: string;
  timeframe: string;
  /** The last bar is still forming. */
  lastLive?: boolean;
  /** Abort a run that takes longer than this. */
  maxMs?: number;
}

type PineFn = (a: any[], rt: PineHost, st: any, node: PN) => any;

interface PineFnDef { p: string[]; f: PineFn; variadic?: boolean; }

const PineBuiltins = (() => {
  const isNa = (v: any): boolean => v === null || v === undefined || (typeof v === 'number' && isNaN(v));
  const num = (v: any): number => (typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : NaN);
  const truthy = (v: any): boolean => v === true || (typeof v === 'number' && v !== 0 && !isNaN(v));
  const len = (v: any): number => {
    const n = Math.trunc(num(v));
    return isFinite(n) ? n : NaN;
  };

  function buf(st: any, key: string, v: any): any[] {
    const b = st[key] || (st[key] = []);
    b.push(v);
    return b;
  }
  function sub(st: any, key: string): any {
    return st[key] || (st[key] = {});
  }
  /** b[n] counting back from the newest (0 = newest). */
  function back(b: any[], n: number): any {
    const i = b.length - 1 - n;
    return i >= 0 && i < b.length ? b[i] : NaN;
  }

  function smaB(b: number[], n: number): number {
    if (!(n >= 1) || b.length < n) return NaN;
    let s = 0;
    for (let i = b.length - n; i < b.length; i++) s += b[i];
    return s / n;
  }
  function sumB(b: number[], n: number): number {
    if (!(n >= 1) || b.length < n) return NaN;
    let s = 0;
    for (let i = b.length - n; i < b.length; i++) s += b[i];
    return s;
  }

  /** Pine's EMA family: seeded with the SMA of the first `n` values. */
  function emaStep(st: any, src: number, n: number, alpha: number): number {
    const b = buf(st, 'b', src);
    const prev = st.p;
    const v = prev === undefined || isNaN(prev) ? smaB(b, n) : alpha * src + (1 - alpha) * prev;
    st.p = v;
    return v;
  }
  const ema = (st: any, src: number, n: number) => emaStep(st, src, n, 2 / (n + 1));
  const rma = (st: any, src: number, n: number) => emaStep(st, src, n, 1 / n);

  function smaStep(st: any, src: number, n: number): number {
    return smaB(buf(st, 'b', src), n);
  }

  function wmaB(b: number[], n: number): number {
    if (!(n >= 1) || b.length < n) return NaN;
    let s = 0, w = 0;
    for (let k = 0; k < n; k++) {
      const wt = n - k;
      s += b[b.length - 1 - k] * wt;
      w += wt;
    }
    return s / w;
  }

  function stdevB(b: number[], n: number, biased: boolean): number {
    if (!(n >= 1) || b.length < n) return NaN;
    const m = smaB(b, n);
    let s = 0;
    for (let i = b.length - n; i < b.length; i++) s += (b[i] - m) ** 2;
    return Math.sqrt(s / (biased ? n : n - 1));
  }

  function extremeB(b: number[], n: number, hi: boolean): { v: number; off: number } {
    if (!(n >= 1) || b.length < n) return { v: NaN, off: NaN };
    let best = NaN, off = NaN;
    for (let k = 0; k < n; k++) {
      const x = b[b.length - 1 - k];
      if (isNaN(x)) continue;
      if (isNaN(best) || (hi ? x > best : x < best)) { best = x; off = k; }
    }
    return { v: best, off };
  }

  function trAt(rt: PineHost, handleNa: boolean): number {
    const b = rt.bars[rt.i];
    if (rt.i === 0) return handleNa ? b.high - b.low : NaN;
    const pc = rt.bars[rt.i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  }

  function changeOf(st: any, src: any, n: number): any {
    const b = buf(st, 'b', src);
    const prev = back(b, n);
    if (typeof src === 'boolean') return typeof prev === 'boolean' ? src !== prev : false;
    return num(src) - num(prev);
  }

  function percentileLinear(vals: number[], pct: number): number {
    const s = vals.slice().sort((x, y) => x - y);
    if (!s.length) return NaN;
    const rank = (Math.max(0, Math.min(100, pct)) / 100) * (s.length - 1);
    const lo = Math.floor(rank), hi = Math.ceil(rank);
    return s[lo] + (s[hi] - s[lo]) * (rank - lo);
  }

  function windowOf(b: number[], n: number): number[] | null {
    if (!(n >= 1) || b.length < n) return null;
    const w = b.slice(b.length - n);
    return w.some((x) => isNaN(x)) ? null : w;
  }

  function pivot(st: any, src: number, left: number, right: number, hi: boolean): number {
    const b = buf(st, 'b', src);
    const c = b.length - 1 - right;
    if (c - left < 0) return NaN;
    const p = b[c];
    if (isNaN(p)) return NaN;
    for (let j = c - left; j < b.length; j++) {
      if (j === c) continue;
      const x = b[j];
      if (isNaN(x) || (hi ? x >= p : x <= p)) return NaN;
    }
    return p;
  }

  function utc(t: number): Date { return new Date(t); }

  // ── Number formatting for str.tostring / str.format ──────────────────────

  function groupThousands(s: string): string {
    const [i, d] = s.split('.');
    const g = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return d != null ? `${g}.${d}` : g;
  }

  function mintickDecimals(rt: PineHost): number {
    const last = rt.bars[rt.bars.length - 1]?.close || 1;
    const a = Math.abs(last);
    if (ChartWorkspace.isStock(rt.opts.source)) return a >= 1 ? 2 : 4;
    return a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8;
  }

  function formatNumber(v: number, fmt: string | undefined, rt: PineHost | null): string {
    if (isNaN(v)) return 'NaN';
    if (!fmt || fmt === 'inherit' || fmt === 'price') {
      if (Number.isInteger(v)) return String(v);
      return String(Number(v.toFixed(8)));
    }
    if (fmt === 'mintick') return v.toFixed(rt ? mintickDecimals(rt) : 2);
    if (fmt === 'percent') return `${v.toFixed(2)}%`;
    if (fmt === 'volume') {
      const a = Math.abs(v);
      if (a >= 1e9) return `${(v / 1e9).toFixed(3).replace(/\.?0+$/, '')}B`;
      if (a >= 1e6) return `${(v / 1e6).toFixed(3).replace(/\.?0+$/, '')}M`;
      if (a >= 1e3) return `${(v / 1e3).toFixed(3).replace(/\.?0+$/, '')}K`;
      return String(Number(v.toFixed(2)));
    }
    if (fmt === 'integer') return String(Math.round(v));
    // Patterns like "#.##", "0.00", "#,##0.0"
    const m = /^([#0,]*)(?:\.([#0]*))?(%?)$/.exec(fmt);
    if (!m) return String(v);
    const x = m[3] ? v * 100 : v;
    const dec = m[2] || '';
    let s = x.toFixed(dec.length);
    const minDec = (dec.match(/0/g) || []).length;
    if (dec.length > minDec && s.includes('.')) {
      let [i, d] = s.split('.');
      while (d.length > minDec && d.endsWith('0')) d = d.slice(0, -1);
      s = d ? `${i}.${d}` : i;
    }
    if ((m[1] || '').includes(',')) s = groupThousands(s);
    return s + m[3];
  }

  function toStr(v: any, fmt?: string, rt: PineHost | null = null): string {
    if (typeof v === 'string') return v;
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return formatNumber(v, fmt, rt);
    if (v instanceof PineArray) return `[${v.items.map((x) => toStr(x, fmt, rt)).join(', ')}]`;
    if (PineColors.isColor(v)) return PineColors.css(v) || 'na';
    if (Array.isArray(v)) return `[${v.map((x) => toStr(x, fmt, rt)).join(', ')}]`;
    return isNa(v) ? 'NaN' : String(v);
  }

  // ── Constants ────────────────────────────────────────────────────────────

  const CONSTS: Record<string, any> = {
    'math.pi': Math.PI, 'math.e': Math.E, 'math.phi': 1.618033988749895, 'math.rphi': 0.618033988749895,
    'display.none': 0, 'display.pane': 1, 'display.data_window': 2, 'display.price_scale': 4,
    'display.status_line': 8, 'display.all': 15,
    'dayofweek.sunday': 1, 'dayofweek.monday': 2, 'dayofweek.tuesday': 3, 'dayofweek.wednesday': 4,
    'dayofweek.thursday': 5, 'dayofweek.friday': 6, 'dayofweek.saturday': 7,
    'order.ascending': 'asc', 'order.descending': 'desc',
  };
  const STRING_CONSTS: Record<string, string[]> = {
    'plot.style': ['line', 'linebr', 'stepline', 'steplinebr', 'stepline_diamond', 'histogram', 'cross', 'area', 'areabr', 'columns', 'circles'],
    'plot.linestyle': ['solid', 'dashed', 'dotted'],
    'hline.style': ['solid', 'dotted', 'dashed'],
    'shape': ['xcross', 'cross', 'circle', 'triangleup', 'triangledown', 'flag', 'arrowup', 'arrowdown', 'labelup', 'labeldown', 'square', 'diamond'],
    'location': ['abovebar', 'belowbar', 'top', 'bottom', 'absolute'],
    'size': ['auto', 'tiny', 'small', 'normal', 'large', 'huge'],
    'position': ['top_left', 'top_center', 'top_right', 'middle_left', 'middle_center', 'middle_right', 'bottom_left', 'bottom_center', 'bottom_right'],
    'text': ['align_left', 'align_center', 'align_right', 'align_top', 'align_bottom', 'wrap_auto', 'wrap_none'],
    'format': ['inherit', 'price', 'volume', 'percent', 'mintick'],
    'alert': ['freq_once_per_bar', 'freq_once_per_bar_close', 'freq_all'],
    'font': ['family_default', 'family_monospace'],
    'extend': ['none', 'left', 'right', 'both'],
    'xloc': ['bar_index', 'bar_time'],
    'yloc': ['price', 'abovebar', 'belowbar'],
    'barmerge': ['gaps_on', 'gaps_off', 'lookahead_on', 'lookahead_off'],
    'scale': ['right', 'left', 'none'],
    'session': ['regular', 'extended'],
    'currency': ['USD', 'EUR', 'GBP', 'JPY', 'BTC', 'ETH', 'USDT', 'NONE'],
  };
  for (const [ns, names] of Object.entries(STRING_CONSTS)) {
    for (const n of names) {
      const full = ns.includes('.') ? `${ns}_${n}` : `${ns}.${n}`;
      CONSTS[full] = n;
    }
  }

  function constant(name: string): any {
    return Object.prototype.hasOwnProperty.call(CONSTS, name) ? CONSTS[name] : undefined;
  }

  // ── Variables ────────────────────────────────────────────────────────────

  const TF_PERIOD: Record<string, string> = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D', '1w': 'W' };

  function tfSeconds(rt: PineHost): number {
    return ChartGeo.tfSeconds(rt.opts.timeframe);
  }

  function priceAt(bars: ChartBar[], i: number, name: string): number {
    const b = bars[i];
    if (!b) return NaN;
    switch (name) {
      case 'open': return b.open;
      case 'high': return b.high;
      case 'low': return b.low;
      case 'close': return b.close;
      case 'volume': return b.volume;
      case 'hl2': return (b.high + b.low) / 2;
      case 'hlc3': return (b.high + b.low + b.close) / 3;
      case 'ohlc4': return (b.open + b.high + b.low + b.close) / 4;
      case 'hlcc4': return (b.high + b.low + b.close + b.close) / 4;
      case 'time': return b.time * 1000;
      case 'bar_index': return i;
    }
    return NaN;
  }
  const PRICE_SERIES = new Set(['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'time', 'bar_index']);

  function splitSymbol(rt: PineHost): [string, string] {
    const [b, q = 'USD'] = rt.opts.symbol.toUpperCase().split('/');
    return [b, q];
  }

  const VARS: Record<string, (rt: PineHost) => any> = {
    time_close: (rt) => rt.bars[rt.i].time * 1000 + tfSeconds(rt) * 1000,
    timenow: () => Date.now(),
    last_bar_index: (rt) => rt.bars.length - 1,
    last_bar_time: (rt) => rt.bars[rt.bars.length - 1].time * 1000,
    'barstate.isfirst': (rt) => rt.i === 0,
    'barstate.islast': (rt) => rt.i === rt.bars.length - 1,
    'barstate.isrealtime': (rt) => !!rt.opts.lastLive && rt.i === rt.bars.length - 1,
    'barstate.ishistory': (rt) => !(rt.opts.lastLive && rt.i === rt.bars.length - 1),
    'barstate.isconfirmed': (rt) => !(rt.opts.lastLive && rt.i === rt.bars.length - 1),
    'barstate.isnew': () => true,
    'barstate.islastconfirmedhistory': (rt) => rt.i === rt.bars.length - (rt.opts.lastLive ? 2 : 1),
    'timeframe.period': (rt) => TF_PERIOD[rt.opts.timeframe] || rt.opts.timeframe,
    'timeframe.main_period': (rt) => TF_PERIOD[rt.opts.timeframe] || rt.opts.timeframe,
    'timeframe.multiplier': (rt) => {
      const p = TF_PERIOD[rt.opts.timeframe] || '';
      return /^\d+$/.test(p) ? Number(p) : 1;
    },
    'timeframe.isintraday': (rt) => tfSeconds(rt) < 86400,
    'timeframe.isminutes': (rt) => tfSeconds(rt) < 86400,
    'timeframe.isseconds': () => false,
    'timeframe.isticks': () => false,
    'timeframe.isdaily': (rt) => rt.opts.timeframe === '1d',
    'timeframe.isweekly': (rt) => rt.opts.timeframe === '1w',
    'timeframe.ismonthly': () => false,
    'timeframe.isdwm': (rt) => tfSeconds(rt) >= 86400,
    'syminfo.ticker': (rt) => splitSymbol(rt).join(''),
    'syminfo.tickerid': (rt) => `${rt.opts.exchange.toUpperCase().replace(/\s+/g, '')}:${splitSymbol(rt).join('')}`,
    'syminfo.basecurrency': (rt) => splitSymbol(rt)[0],
    'syminfo.currency': (rt) => splitSymbol(rt)[1],
    'syminfo.prefix': (rt) => rt.opts.exchange.toUpperCase().replace(/\s+/g, ''),
    'syminfo.description': (rt) => rt.opts.symbol,
    'syminfo.root': (rt) => splitSymbol(rt)[0],
    'syminfo.type': (rt) => (ChartWorkspace.isStock(rt.opts.source) ? 'stock' : 'crypto'),
    'syminfo.timezone': () => 'Etc/UTC',
    'syminfo.session': () => 'regular',
    'syminfo.mintick': (rt) => Math.pow(10, -mintickDecimals(rt)),
    'syminfo.pointvalue': () => 1,
    'syminfo.volumetype': () => 'base',
    year: (rt) => utc(rt.bars[rt.i].time * 1000).getUTCFullYear(),
    month: (rt) => utc(rt.bars[rt.i].time * 1000).getUTCMonth() + 1,
    dayofmonth: (rt) => utc(rt.bars[rt.i].time * 1000).getUTCDate(),
    dayofweek: (rt) => utc(rt.bars[rt.i].time * 1000).getUTCDay() + 1,
    hour: (rt) => utc(rt.bars[rt.i].time * 1000).getUTCHours(),
    minute: (rt) => utc(rt.bars[rt.i].time * 1000).getUTCMinutes(),
    second: (rt) => utc(rt.bars[rt.i].time * 1000).getUTCSeconds(),
    weekofyear: (rt) => weekOfYear(rt.bars[rt.i].time * 1000),
    'ta.tr': (rt) => trAt(rt, false),
    'ta.obv': (rt) => rt.pre('obv')[rt.i],
    'ta.vwap': (rt) => rt.pre('vwap')[rt.i],
    'ta.accdist': (rt) => rt.pre('accdist')[rt.i],
    'ta.pvt': (rt) => rt.pre('pvt')[rt.i],
    'ta.nvi': (rt) => rt.pre('nvi')[rt.i],
    'ta.pvi': (rt) => rt.pre('pvi')[rt.i],
    'ta.wad': (rt) => rt.pre('wad')[rt.i],
    'ta.iii': (rt) => {
      const b = rt.bars[rt.i];
      return b.high === b.low || !b.volume ? NaN : (2 * b.close - b.high - b.low) / ((b.high - b.low) * b.volume);
    },
    'ta.wvad': (rt) => {
      const b = rt.bars[rt.i];
      return b.high === b.low ? NaN : ((b.close - b.open) / (b.high - b.low)) * b.volume;
    },
  };

  function weekOfYear(ms: number): number {
    const d = new Date(ms);
    const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
    return Math.floor((day - jan1) / 86400000 / 7) + 1;
  }

  /** Whole-history series that don't depend on a call's arguments. */
  function precompute(name: string, bars: ChartBar[]): Float64Array {
    const n = bars.length;
    const out = new Float64Array(n).fill(NaN);
    let acc = 0;
    switch (name) {
      case 'obv':
        for (let i = 0; i < n; i++) {
          if (i) acc += Math.sign(bars[i].close - bars[i - 1].close) * bars[i].volume;
          out[i] = i ? acc : 0;
        }
        break;
      case 'accdist':
        for (let i = 0; i < n; i++) {
          const b = bars[i];
          const mfm = b.high > b.low ? ((b.close - b.low) - (b.high - b.close)) / (b.high - b.low) : 0;
          acc += mfm * b.volume;
          out[i] = acc;
        }
        break;
      case 'pvt':
        for (let i = 0; i < n; i++) {
          if (i && bars[i - 1].close) acc += ((bars[i].close - bars[i - 1].close) / bars[i - 1].close) * bars[i].volume;
          out[i] = acc;
        }
        break;
      case 'wad':
        for (let i = 1; i < n; i++) {
          const b = bars[i], pc = bars[i - 1].close;
          const trh = Math.max(b.high, pc), trl = Math.min(b.low, pc);
          acc += b.close > pc ? b.close - trl : b.close < pc ? b.close - trh : 0;
          out[i] = acc;
        }
        if (n) out[0] = 0;
        break;
      case 'nvi':
      case 'pvi': {
        let v = 1;
        for (let i = 0; i < n; i++) {
          if (i && bars[i - 1].close) {
            const up = bars[i].volume > bars[i - 1].volume;
            const dn = bars[i].volume < bars[i - 1].volume;
            if ((name === 'pvi' && up) || (name === 'nvi' && dn)) v += ((bars[i].close - bars[i - 1].close) / bars[i - 1].close) * v;
          }
          out[i] = v;
        }
        break;
      }
      case 'vwap': {
        let day = -1, pv = 0, vol = 0;
        for (let i = 0; i < n; i++) {
          const b = bars[i];
          const d = Math.floor(b.time / 86400);
          if (d !== day) { day = d; pv = 0; vol = 0; }
          const tp = (b.high + b.low + b.close) / 3;
          pv += tp * b.volume; vol += b.volume;
          out[i] = vol ? pv / vol : NaN;
        }
        break;
      }
    }
    return out;
  }

  // ── Functions ───────────────────────────────────────────────────────────

  const FNS: Record<string, PineFnDef> = {};
  const def = (name: string, p: string[], f: PineFn, variadic = false) => { FNS[name] = { p, f, variadic }; };

  // Basics
  def('na', ['x'], (a) => isNa(a[0]));
  def('nz', ['source', 'replacement'], (a) => (isNa(a[0]) ? (a[1] === undefined ? 0 : a[1]) : a[0]));
  def('fixnan', ['source'], (a, _rt, st) => {
    if (!isNa(a[0])) st.last = a[0];
    return st.last === undefined ? NaN : st.last;
  });
  def('int', ['x'], (a) => (isNa(a[0]) ? NaN : Math.trunc(num(a[0]))));
  def('float', ['x'], (a) => num(a[0]));
  def('bool', ['x'], (a) => truthy(a[0]));
  def('string', ['x'], (a) => toStr(a[0]));
  def('runtime.error', ['message'], (a, _rt, _st, node) => {
    throw new PineError(String(a[0] ?? 'Runtime error'), node.line, node.col, 'runtime');
  });

  // math
  const m1 = (name: string, f: (x: number) => number) => def(`math.${name}`, ['number'], (a) => f(num(a[0])));
  m1('abs', Math.abs); m1('ceil', Math.ceil); m1('floor', Math.floor); m1('sqrt', Math.sqrt);
  m1('log', Math.log); m1('log10', Math.log10); m1('exp', Math.exp); m1('sign', Math.sign);
  m1('sin', Math.sin); m1('cos', Math.cos); m1('tan', Math.tan); m1('asin', Math.asin);
  m1('acos', Math.acos); m1('atan', Math.atan);
  m1('todegrees', (x) => (x * 180) / Math.PI); m1('toradians', (x) => (x * Math.PI) / 180);
  def('math.round', ['number', 'precision'], (a) => {
    const x = num(a[0]);
    if (isNaN(x)) return NaN;
    const p = a[1] === undefined ? 0 : len(a[1]);
    const f = Math.pow(10, p || 0);
    return (Math.sign(x) * Math.round(Math.abs(x) * f)) / f;
  });
  def('math.round_to_mintick', ['number'], (a, rt) => {
    const d = mintickDecimals(rt);
    return Number(num(a[0]).toFixed(d));
  });
  def('math.pow', ['base', 'exponent'], (a) => Math.pow(num(a[0]), num(a[1])));
  def('math.max', ['...'], (a) => {
    const xs = a.map(num);
    return xs.some(isNaN) ? NaN : Math.max(...xs);
  }, true);
  def('math.min', ['...'], (a) => {
    const xs = a.map(num);
    return xs.some(isNaN) ? NaN : Math.min(...xs);
  }, true);
  def('math.avg', ['...'], (a) => a.reduce((s: number, x: any) => s + num(x), 0) / a.length, true);
  def('math.random', ['min', 'max', 'seed'], (a, _rt, st) => {
    // Deterministic per call site, like Pine with a seed.
    st.s = ((st.s ?? (num(a[2]) || 12345)) * 1103515245 + 12345) % 2147483648;
    const lo = a[0] === undefined ? 0 : num(a[0]), hi = a[1] === undefined ? 1 : num(a[1]);
    return lo + (st.s / 2147483648) * (hi - lo);
  });
  def('math.sum', ['source', 'length'], (a, _rt, st) => sumB(buf(st, 'b', num(a[0])), len(a[1])));

  // ta: moving averages
  def('ta.sma', ['source', 'length'], (a, _rt, st) => smaStep(st, num(a[0]), len(a[1])));
  def('ta.ema', ['source', 'length'], (a, _rt, st) => ema(st, num(a[0]), len(a[1])));
  def('ta.rma', ['source', 'length'], (a, _rt, st) => rma(st, num(a[0]), len(a[1])));
  def('ta.wma', ['source', 'length'], (a, _rt, st) => wmaB(buf(st, 'b', num(a[0])), len(a[1])));
  def('ta.vwma', ['source', 'length'], (a, rt, st) => {
    const v = rt.bars[rt.i].volume, n = len(a[1]);
    return smaStep(sub(st, 'pv'), num(a[0]) * v, n) / smaStep(sub(st, 'v'), v, n);
  });
  def('ta.hma', ['source', 'length'], (a, _rt, st) => {
    const n = len(a[1]);
    const b = buf(st, 'b', num(a[0]));
    const diff = 2 * wmaB(b, Math.floor(n / 2)) - wmaB(b, n);
    return wmaB(buf(st, 'd', diff), Math.round(Math.sqrt(n)));
  });
  def('ta.swma', ['source'], (a, _rt, st) => {
    const b = buf(st, 'b', num(a[0]));
    if (b.length < 4) return NaN;
    return (back(b, 3) + 2 * back(b, 2) + 2 * back(b, 1) + back(b, 0)) / 6;
  });
  def('ta.alma', ['series', 'length', 'offset', 'sigma', 'floor'], (a, _rt, st) => {
    const b = buf(st, 'b', num(a[0]));
    const n = len(a[1]);
    if (!(n >= 1) || b.length < n) return NaN;
    const offset = a[2] === undefined ? 0.85 : num(a[2]);
    const sigma = a[3] === undefined ? 6 : num(a[3]);
    const mm = a[4] ? Math.floor(offset * (n - 1)) : offset * (n - 1);
    const s = n / sigma;
    let norm = 0, sum = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.exp(-((i - mm) ** 2) / (2 * s * s));
      norm += w;
      sum += b[b.length - n + i] * w;
    }
    return sum / norm;
  });
  def('ta.linreg', ['source', 'length', 'offset'], (a, _rt, st) => {
    const b = buf(st, 'b', num(a[0]));
    const n = len(a[1]);
    const w = windowOf(b, n);
    if (!w) return NaN;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let x = 0; x < n; x++) { sx += x; sy += w[x]; sxy += x * w[x]; sxx += x * x; }
    const slope = n > 1 ? (n * sxy - sx * sy) / (n * sxx - sx * sx) : 0;
    const intercept = (sy - slope * sx) / n;
    return intercept + slope * (n - 1 - (a[2] === undefined ? 0 : num(a[2])));
  });

  // ta: oscillators
  function rsiStep(st: any, src: number, n: number): number {
    const b = buf(st, 'b', src);
    const ch = src - back(b, 1);
    const up = rma(sub(st, 'u'), Math.max(ch, 0), n);
    const dn = rma(sub(st, 'd'), -Math.min(ch, 0), n);
    if (isNaN(up) || isNaN(dn)) return NaN;
    return dn === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / dn);
  }
  def('ta.rsi', ['source', 'length'], (a, _rt, st) => rsiStep(st, num(a[0]), len(a[1])));
  def('ta.macd', ['source', 'fastlen', 'slowlen', 'siglen'], (a, _rt, st) => {
    const src = num(a[0]);
    const macd = ema(sub(st, 'f'), src, len(a[1])) - ema(sub(st, 's'), src, len(a[2]));
    const signal = ema(sub(st, 'g'), macd, len(a[3]));
    return [macd, signal, macd - signal];
  });
  function stochStep(st: any, src: number, hi: number, lo: number, n: number): number {
    const h = extremeB(buf(st, 'h', hi), n, true).v, l = extremeB(buf(st, 'l', lo), n, false).v;
    return h === l ? NaN : (100 * (src - l)) / (h - l);
  }
  def('ta.stoch', ['source', 'high', 'low', 'length'], (a, _rt, st) => stochStep(st, num(a[0]), num(a[1]), num(a[2]), len(a[3])));
  def('ta.cci', ['source', 'length'], (a, _rt, st) => {
    const b = buf(st, 'b', num(a[0]));
    const n = len(a[1]);
    const w = windowOf(b, n);
    if (!w) return NaN;
    const m = w.reduce((s, x) => s + x, 0) / n;
    const dev = w.reduce((s, x) => s + Math.abs(x - m), 0) / n;
    return dev === 0 ? 0 : (b[b.length - 1] - m) / (0.015 * dev);
  });
  def('ta.mfi', ['series', 'length'], (a, rt, st) => {
    const src = num(a[0]), n = len(a[1]);
    const ch = src - back(buf(st, 'b', src), 1);
    const v = rt.bars[rt.i].volume;
    const upper = sumB(buf(st, 'u', v * (ch <= 0 ? 0 : src)), n);
    const lower = sumB(buf(st, 'l', v * (ch >= 0 ? 0 : src)), n);
    return 100 - 100 / (1 + upper / lower);
  });
  def('ta.atr', ['length'], (a, rt, st) => rma(st, trAt(rt, true), len(a[0])));
  def('ta.tr', ['handle_na'], (a, rt) => trAt(rt, !!a[0]));
  def('ta.stdev', ['source', 'length', 'biased'], (a, _rt, st) => stdevB(buf(st, 'b', num(a[0])), len(a[1]), a[2] !== false));
  def('ta.variance', ['source', 'length', 'biased'], (a, _rt, st) => stdevB(buf(st, 'b', num(a[0])), len(a[1]), a[2] !== false) ** 2);
  def('ta.dev', ['source', 'length'], (a, _rt, st) => {
    const b = buf(st, 'b', num(a[0]));
    const n = len(a[1]);
    const m = smaB(b, n);
    if (isNaN(m)) return NaN;
    let s = 0;
    for (let i = b.length - n; i < b.length; i++) s += Math.abs(b[i] - m);
    return s / n;
  });
  def('ta.median', ['source', 'length'], (a, _rt, st) => {
    const w = windowOf(buf(st, 'b', num(a[0])), len(a[1]));
    if (!w) return NaN;
    const s = w.sort((x, y) => x - y);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  });
  def('ta.range', ['source', 'length'], (a, _rt, st) => {
    const b = buf(st, 'b', num(a[0])), n = len(a[1]);
    return extremeB(b, n, true).v - extremeB(b, n, false).v;
  });

  /** ta.highest(length) uses high; ta.highest(source, length) the given source. */
  function srcLen(a: any[], rt: PineHost, field: 'high' | 'low'): [number, number] {
    if (a[1] === undefined) return [field === 'high' ? rt.bars[rt.i].high : rt.bars[rt.i].low, len(a[0])];
    return [num(a[0]), len(a[1])];
  }
  def('ta.highest', ['source', 'length'], (a, rt, st) => { const [s, n] = srcLen(a, rt, 'high'); return extremeB(buf(st, 'b', s), n, true).v; });
  def('ta.lowest', ['source', 'length'], (a, rt, st) => { const [s, n] = srcLen(a, rt, 'low'); return extremeB(buf(st, 'b', s), n, false).v; });
  def('ta.highestbars', ['source', 'length'], (a, rt, st) => { const [s, n] = srcLen(a, rt, 'high'); return -extremeB(buf(st, 'b', s), n, true).off; });
  def('ta.lowestbars', ['source', 'length'], (a, rt, st) => { const [s, n] = srcLen(a, rt, 'low'); return -extremeB(buf(st, 'b', s), n, false).off; });
  def('ta.max', ['source'], (a, _rt, st) => { const x = num(a[0]); if (!isNaN(x) && !(x <= st.m)) st.m = x; return st.m ?? NaN; });
  def('ta.min', ['source'], (a, _rt, st) => { const x = num(a[0]); if (!isNaN(x) && !(x >= st.m)) st.m = x; return st.m ?? NaN; });

  def('ta.change', ['source', 'length'], (a, _rt, st) => changeOf(st, a[0], a[1] === undefined ? 1 : len(a[1])));
  def('ta.mom', ['source', 'length'], (a, _rt, st) => changeOf(st, num(a[0]), len(a[1])));
  def('ta.roc', ['source', 'length'], (a, _rt, st) => {
    const b = buf(st, 'b', num(a[0]));
    const p = back(b, len(a[1]));
    return (100 * (b[b.length - 1] - p)) / p;
  });
  def('ta.cum', ['source'], (a, _rt, st) => {
    const v = (st.s === undefined || isNaN(st.s) ? 0 : st.s) + num(a[0]);
    st.s = v;
    return v;
  });
  def('ta.cmo', ['series', 'length'], (a, _rt, st) => {
    const src = num(a[0]), n = len(a[1]);
    const ch = src - back(buf(st, 'b', src), 1);
    const up = sumB(buf(st, 'u', ch >= 0 ? ch : 0), n), dn = sumB(buf(st, 'd', ch >= 0 ? 0 : -ch), n);
    return (100 * (up - dn)) / (up + dn);
  });
  def('ta.tsi', ['source', 'short_length', 'long_length'], (a, _rt, st) => {
    const src = num(a[0]);
    const pc = src - back(buf(st, 'b', src), 1);
    const ds = ema(sub(st, 'd2'), ema(sub(st, 'd1'), pc, len(a[2])), len(a[1]));
    const das = ema(sub(st, 'a2'), ema(sub(st, 'a1'), Math.abs(pc), len(a[2])), len(a[1]));
    return ds / das;
  });
  def('ta.wpr', ['length'], (a, rt, st) => {
    const n = len(a[0]), b = rt.bars[rt.i];
    const h = extremeB(buf(st, 'h', b.high), n, true).v, l = extremeB(buf(st, 'l', b.low), n, false).v;
    return h === l ? NaN : (100 * (b.close - h)) / (h - l);
  });
  def('ta.cog', ['source', 'length'], (a, _rt, st) => {
    const w = windowOf(buf(st, 'b', num(a[0])), len(a[1]));
    if (!w) return NaN;
    let s = 0, wsum = 0;
    for (let i = 0; i < w.length; i++) {
      const x = w[w.length - 1 - i];
      s += x; wsum += x * (i + 1);
    }
    return -wsum / s;
  });
  def('ta.percentrank', ['source', 'length'], (a, _rt, st) => {
    const b = buf(st, 'b', num(a[0])), n = len(a[1]);
    if (!(n >= 1) || b.length < n + 1) return NaN;
    const cur = b[b.length - 1];
    let c = 0;
    for (let k = 1; k <= n; k++) if (b[b.length - 1 - k] <= cur) c++;
    return (100 * c) / n;
  });

  function crossOf(st: any, x: number, y: number): [boolean, boolean] {
    const px = st.px, py = st.py;
    st.px = x; st.py = y;
    if ([x, y, px, py].some((v) => v === undefined || isNaN(v))) return [false, false];
    return [x > y && px <= py, x < y && px >= py];
  }
  def('ta.crossover', ['source1', 'source2'], (a, _rt, st) => crossOf(st, num(a[0]), num(a[1]))[0]);
  def('ta.crossunder', ['source1', 'source2'], (a, _rt, st) => crossOf(st, num(a[0]), num(a[1]))[1]);
  def('ta.cross', ['source1', 'source2'], (a, _rt, st) => { const [o, u] = crossOf(st, num(a[0]), num(a[1])); return o || u; });
  def('ta.rising', ['source', 'length'], (a, _rt, st) => {
    const b = buf(st, 'b', num(a[0])), n = len(a[1]);
    if (b.length < n + 1) return false;
    const cur = b[b.length - 1];
    if (isNaN(cur)) return false;
    for (let k = 1; k <= n; k++) { const x = b[b.length - 1 - k]; if (isNaN(x) || !(cur > x)) return false; }
    return true;
  });
  def('ta.falling', ['source', 'length'], (a, _rt, st) => {
    const b = buf(st, 'b', num(a[0])), n = len(a[1]);
    if (b.length < n + 1) return false;
    const cur = b[b.length - 1];
    if (isNaN(cur)) return false;
    for (let k = 1; k <= n; k++) { const x = b[b.length - 1 - k]; if (isNaN(x) || !(cur < x)) return false; }
    return true;
  });
  /** ta.pivothigh(left, right) uses high; ta.pivothigh(source, left, right) the given source. */
  function pivotArgs(a: any[], rt: PineHost, field: 'high' | 'low'): [number, number, number] {
    if (a[2] === undefined) return [field === 'high' ? rt.bars[rt.i].high : rt.bars[rt.i].low, len(a[0]), len(a[1])];
    return [num(a[0]), len(a[1]), len(a[2])];
  }
  def('ta.pivothigh', ['source', 'leftbars', 'rightbars'], (a, rt, st) => { const [s, l, r] = pivotArgs(a, rt, 'high'); return pivot(st, s, l, r, true); });
  def('ta.pivotlow', ['source', 'leftbars', 'rightbars'], (a, rt, st) => { const [s, l, r] = pivotArgs(a, rt, 'low'); return pivot(st, s, l, r, false); });
  def('ta.percentile_linear_interpolation', ['source', 'length', 'percentage'], (a, _rt, st) => {
    const w = windowOf(buf(st, 'b', num(a[0])), len(a[1]));
    return w ? percentileLinear(w, num(a[2])) : NaN;
  });
  def('ta.percentile_nearest_rank', ['source', 'length', 'percentage'], (a, _rt, st) => {
    const w = windowOf(buf(st, 'b', num(a[0])), len(a[1]));
    if (!w) return NaN;
    const s = w.sort((x, y) => x - y);
    const rank = Math.max(1, Math.ceil((Math.max(0, Math.min(100, num(a[2]))) / 100) * s.length));
    return s[rank - 1];
  });
  def('ta.valuewhen', ['condition', 'source', 'occurrence'], (a, _rt, st) => {
    const vals = st.v || (st.v = []);
    if (truthy(a[0])) vals.push(a[1]);
    const occ = a[2] === undefined ? 0 : len(a[2]);
    const v = vals[vals.length - 1 - occ];
    return v === undefined ? NaN : v;
  });
  def('ta.barssince', ['condition'], (a, _rt, st) => {
    st.n = (st.n ?? -1) + 1;
    if (truthy(a[0])) st.last = st.n;
    return st.last === undefined ? NaN : st.n - st.last;
  });
  def('ta.bb', ['series', 'length', 'mult'], (a, _rt, st) => {
    const b = buf(st, 'b', num(a[0])), n = len(a[1]);
    const mid = smaB(b, n), dev = num(a[2]) * stdevB(b, n, true);
    return [mid, mid + dev, mid - dev];
  });
  def('ta.bbw', ['series', 'length', 'mult'], (a, _rt, st) => {
    const b = buf(st, 'b', num(a[0])), n = len(a[1]);
    const mid = smaB(b, n), dev = num(a[2]) * stdevB(b, n, true);
    return ((2 * dev) / mid) * 100;
  });
  function kcOf(a: any[], rt: PineHost, st: any): [number, number, number] {
    const n = len(a[1]), m = num(a[2]);
    const basis = ema(sub(st, 'b'), num(a[0]), n);
    const b = rt.bars[rt.i];
    const span = a[3] === false ? b.high - b.low : trAt(rt, false);
    const r = ema(sub(st, 'r'), span, n);
    return [basis, basis + r * m, basis - r * m];
  }
  def('ta.kc', ['series', 'length', 'mult', 'useTrueRange'], (a, rt, st) => kcOf(a, rt, st));
  def('ta.kcw', ['series', 'length', 'mult', 'useTrueRange'], (a, rt, st) => { const [b, u, l] = kcOf(a, rt, st); return (u - l) / b; });
  def('ta.dmi', ['diLength', 'adxSmoothing'], (a, rt, st) => {
    const n = len(a[0]), sm = len(a[1]);
    const b = rt.bars[rt.i], p = rt.bars[rt.i - 1];
    const up = p ? b.high - p.high : NaN, down = p ? p.low - b.low : NaN;
    const plusDM = isNaN(up) ? NaN : up > down && up > 0 ? up : 0;
    const minusDM = isNaN(down) ? NaN : down > up && down > 0 ? down : 0;
    const trur = rma(sub(st, 't'), trAt(rt, false), n);
    const fix = (s: any, v: number) => { if (!isNaN(v)) s.last = v; return s.last ?? NaN; };
    const plus = fix(sub(st, 'fp'), (100 * rma(sub(st, 'p'), plusDM, n)) / trur);
    const minus = fix(sub(st, 'fm'), (100 * rma(sub(st, 'm'), minusDM, n)) / trur);
    const sum = plus + minus;
    const adx = 100 * rma(sub(st, 'x'), Math.abs(plus - minus) / (sum === 0 ? 1 : sum), sm);
    return [plus, minus, adx];
  });
  def('ta.supertrend', ['factor', 'atrPeriod'], (a, rt, st) => {
    const b = rt.bars[rt.i];
    const src = (b.high + b.low) / 2;
    const atr = rma(sub(st, 'atr'), trAt(rt, true), len(a[1]));
    let upper = src + num(a[0]) * atr, lower = src - num(a[0]) * atr;
    const prevLower = isNaN(st.lower ?? NaN) ? 0 : st.lower, prevUpper = isNaN(st.upper ?? NaN) ? 0 : st.upper;
    const pc = rt.i ? rt.bars[rt.i - 1].close : NaN;
    lower = lower > prevLower || pc < prevLower ? lower : prevLower;
    upper = upper < prevUpper || pc > prevUpper ? upper : prevUpper;
    let dir: number;
    if (isNaN(st.prevAtr ?? NaN)) dir = 1;
    else if (st.st === st.upper) dir = b.close > upper ? -1 : 1;
    else dir = b.close < lower ? 1 : -1;
    const val = dir === -1 ? lower : upper;
    st.prevAtr = atr; st.lower = lower; st.upper = upper; st.st = val;
    return [val, dir];
  });
  def('ta.sar', ['start', 'inc', 'max'], (a, rt, st) => {
    const start = num(a[0]), inc = num(a[1]), mx = num(a[2]);
    const b = rt.bars[rt.i];
    if (st.n === undefined) st.n = 0;
    st.n++;
    if (st.n === 1) { st.prevB = b; return NaN; }
    if (st.n === 2) {
      const p = st.prevB;
      st.up = b.close > p.close;
      st.ep = st.up ? Math.max(b.high, p.high) : Math.min(b.low, p.low);
      st.sar = st.up ? Math.min(b.low, p.low) : Math.max(b.high, p.high);
      st.af = start;
      st.prevB = b;
      return st.sar;
    }
    let sar = st.sar + st.af * (st.ep - st.sar);
    const p = st.prevB;
    if (st.up) {
      sar = Math.min(sar, p.low);
      if (b.low < sar) { st.up = false; sar = st.ep; st.ep = b.low; st.af = start; }
      else if (b.high > st.ep) { st.ep = b.high; st.af = Math.min(mx, st.af + inc); }
    } else {
      sar = Math.max(sar, p.high);
      if (b.high > sar) { st.up = true; sar = st.ep; st.ep = b.high; st.af = start; }
      else if (b.low < st.ep) { st.ep = b.low; st.af = Math.min(mx, st.af + inc); }
    }
    st.sar = sar;
    st.prevB = b;
    return sar;
  });
  def('ta.vwap', ['source', 'anchor', 'stdev_mult'], (a, rt, st) => {
    const b = rt.bars[rt.i];
    const reset = a[1] === undefined ? Math.floor(b.time / 86400) !== st.day : truthy(a[1]);
    if (reset || st.day === undefined) { st.pv = 0; st.v = 0; st.pv2 = 0; }
    st.day = Math.floor(b.time / 86400);
    const src = num(a[0]);
    st.pv += src * b.volume; st.v += b.volume; st.pv2 += src * src * b.volume;
    const m = st.v ? st.pv / st.v : NaN;
    if (a[2] === undefined) return m;
    const sd = Math.sqrt(Math.max(0, st.pv2 / st.v - m * m));
    return [m, m + num(a[2]) * sd, m - num(a[2]) * sd];
  });
  def('ta.correlation', ['source1', 'source2', 'length'], (a, _rt, st) => {
    const n = len(a[2]);
    const x = windowOf(buf(st, 'x', num(a[0])), n), y = windowOf(buf(st, 'y', num(a[1])), n);
    if (!x || !y) return NaN;
    const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
    return sxy / Math.sqrt(sxx * syy);
  });

  // Time
  const timeFn = (f: (d: Date) => number) => (a: any[], rt: PineHost) => {
    const t = a[0] === undefined ? rt.bars[rt.i].time * 1000 : num(a[0]);
    return isNaN(t) ? NaN : f(new Date(t));
  };
  def('year', ['time', 'timezone'], timeFn((d) => d.getUTCFullYear()));
  def('month', ['time', 'timezone'], timeFn((d) => d.getUTCMonth() + 1));
  def('dayofmonth', ['time', 'timezone'], timeFn((d) => d.getUTCDate()));
  def('dayofweek', ['time', 'timezone'], timeFn((d) => d.getUTCDay() + 1));
  def('hour', ['time', 'timezone'], timeFn((d) => d.getUTCHours()));
  def('minute', ['time', 'timezone'], timeFn((d) => d.getUTCMinutes()));
  def('second', ['time', 'timezone'], timeFn((d) => d.getUTCSeconds()));
  def('weekofyear', ['time', 'timezone'], timeFn((d) => weekOfYear(d.getTime())));
  def('time', ['timeframe', 'session', 'timezone'], (_a, rt) => rt.bars[rt.i].time * 1000);
  def('time_close', ['timeframe', 'session', 'timezone'], (_a, rt) => rt.bars[rt.i].time * 1000 + tfSeconds(rt) * 1000);
  def('timestamp', ['year', 'month', 'day', 'hour', 'minute', 'second'], (a) => {
    // timestamp("2024-01-01") or timestamp(y, m, d, h, mi, s); a leading timezone string is ignored.
    let args = a.filter((x) => x !== undefined);
    if (args.length === 1 && typeof args[0] === 'string') return Date.parse(args[0]);
    if (typeof args[0] === 'string') args = args.slice(1);
    const [y, mo, d, h = 0, mi = 0, s = 0] = args.map(num);
    return Date.UTC(y, mo - 1, d, h, mi, s);
  }, true);
  def('timeframe.in_seconds', ['timeframe'], (a, rt) => {
    const tf = a[0] === undefined || a[0] === '' ? rt.opts.timeframe : String(a[0]);
    const m: Record<string, number> = { '1': 60, '5': 300, '15': 900, '30': 1800, '60': 3600, '240': 14400, 'D': 86400, '1D': 86400, 'W': 604800, '1W': 604800 };
    return m[tf] ?? ChartGeo.tfSeconds(tf);
  });
  def('timeframe.change', ['timeframe'], (a, rt) => {
    const tf = String(a[0] ?? '');
    const m: Record<string, number> = { '60': 3600, '240': 14400, 'D': 86400, '1D': 86400, 'W': 604800, '1W': 604800 };
    const sec = m[tf];
    if (!sec || rt.i === 0) return rt.i === 0;
    const off = sec === 604800 ? 4 * 86400 : 0; // weeks start Monday
    const cur = Math.floor((rt.bars[rt.i].time - off) / sec), prev = Math.floor((rt.bars[rt.i - 1].time - off) / sec);
    return cur !== prev;
  });

  // str
  def('str.tostring', ['value', 'format'], (a, rt) => toStr(a[0], a[1], rt));
  def('str.tonumber', ['string'], (a) => { const v = Number(String(a[0]).trim()); return String(a[0]).trim() === '' ? NaN : v; });
  def('str.format', ['formatString', '...'], (a, rt) => {
    const args = a.slice(1);
    return String(a[0]).replace(/\{(\d+)(?:,\s*(number|date|time)(?:,\s*([^}]+))?)?\}/g, (_m, i, type, f) => {
      const v = args[Number(i)];
      if (type === 'number') return toStr(num(v), f === 'percent' ? 'percent' : f === 'integer' ? 'integer' : f || '#.###', rt);
      if (type === 'date' || type === 'time') return isNa(v) ? 'NaN' : new Date(num(v)).toISOString().replace('T', ' ').slice(0, 16);
      return toStr(v, undefined, rt);
    });
  }, true);
  def('str.length', ['string'], (a) => String(a[0] ?? '').length);
  def('str.contains', ['source', 'str'], (a) => String(a[0]).includes(String(a[1])));
  def('str.startswith', ['source', 'str'], (a) => String(a[0]).startsWith(String(a[1])));
  def('str.endswith', ['source', 'str'], (a) => String(a[0]).endsWith(String(a[1])));
  def('str.pos', ['source', 'str'], (a) => { const i = String(a[0]).indexOf(String(a[1])); return i < 0 ? NaN : i; });
  def('str.upper', ['source'], (a) => String(a[0]).toUpperCase());
  def('str.lower', ['source'], (a) => String(a[0]).toLowerCase());
  def('str.trim', ['source'], (a) => String(a[0]).trim());
  def('str.repeat', ['source', 'repeat', 'separator'], (a) => new Array(Math.max(0, len(a[1]) || 0)).fill(String(a[0])).join(a[2] === undefined ? '' : String(a[2])));
  def('str.replace', ['source', 'target', 'replacement', 'occurrence'], (a) => {
    const s = String(a[0]), t = String(a[1]), r = String(a[2]);
    let occ = a[3] === undefined ? 0 : len(a[3]), from = 0;
    while (true) {
      const i = s.indexOf(t, from);
      if (i < 0) return s;
      if (occ-- === 0) return s.slice(0, i) + r + s.slice(i + t.length);
      from = i + t.length;
    }
  });
  def('str.replace_all', ['source', 'target', 'replacement'], (a) => String(a[0]).split(String(a[1])).join(String(a[2])));
  def('str.substring', ['source', 'begin_pos', 'end_pos'], (a) => String(a[0]).substring(len(a[1]), a[2] === undefined ? undefined : len(a[2])));
  def('str.split', ['string', 'separator'], (a) => new PineArray(String(a[0]).split(String(a[1])), 'string'));

  // color
  def('color.new', ['color', 'transp'], (a) => (PineColors.isColor(a[0]) ? { ...a[0], t: Math.max(0, Math.min(100, num(a[1]) || 0)) } : NaN));
  def('color.rgb', ['red', 'green', 'blue', 'transp'], (a) => PineColors.rgb(num(a[0]), num(a[1]), num(a[2]), a[3] === undefined ? 0 : num(a[3])));
  def('color.r', ['color'], (a) => (PineColors.isColor(a[0]) ? a[0].r : NaN));
  def('color.g', ['color'], (a) => (PineColors.isColor(a[0]) ? a[0].g : NaN));
  def('color.b', ['color'], (a) => (PineColors.isColor(a[0]) ? a[0].b : NaN));
  def('color.t', ['color'], (a) => (PineColors.isColor(a[0]) ? a[0].t : NaN));
  def('color.from_gradient', ['value', 'bottom_value', 'top_value', 'bottom_color', 'top_color'], (a) => {
    const v = num(a[0]), lo = num(a[1]), hi = num(a[2]);
    const c1 = a[3], c2 = a[4];
    if (isNaN(v) || !PineColors.isColor(c1) || !PineColors.isColor(c2)) return NaN;
    const r = hi === lo ? 1 : Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
    return PineColors.rgb(c1.r + (c2.r - c1.r) * r, c1.g + (c2.g - c1.g) * r, c1.b + (c2.b - c1.b) * r, c1.t + (c2.t - c1.t) * r);
  });

  // array
  const arr = (v: any, node: PN): PineArray => {
    if (v instanceof PineArray) return v;
    throw new PineError('Expected an array (is it na?)', node.line, node.col, 'runtime');
  };
  const idx = (A: PineArray, i: any, node: PN, insert = false): number => {
    let k = len(i);
    if (k < 0) k += A.items.length;
    if (!(k >= 0 && (insert ? k <= A.items.length : k < A.items.length))) {
      throw new PineError(`Index ${len(i)} is out of bounds (array size is ${A.items.length})`, node.line, node.col, 'runtime');
    }
    return k;
  };
  const nums = (A: PineArray) => A.items.map(num).filter((x) => !isNaN(x));
  const newArr = (type: string) => (a: any[]) => {
    const n = a[0] === undefined ? 0 : len(a[0]);
    return new PineArray(new Array(Math.max(0, n || 0)).fill(a[1] === undefined ? NaN : a[1]), type);
  };
  def('array.new', ['size', 'initial_value'], (a, _rt, _st, node) => newArr(node.typeArgs || 'float')(a));
  for (const t of ['float', 'int', 'bool', 'string', 'color', 'line', 'label', 'box', 'table']) {
    def(`array.new_${t}`, ['size', 'initial_value'], newArr(t));
  }
  def('array.from', ['...'], (a) => new PineArray(a.slice()), true);
  def('array.copy', ['id'], (a, _r, _s, n) => new PineArray(arr(a[0], n).items.slice(), arr(a[0], n).type));
  def('array.size', ['id'], (a, _r, _s, n) => arr(a[0], n).items.length);
  def('array.push', ['id', 'value'], (a, _r, _s, n) => { arr(a[0], n).items.push(a[1]); return NaN; });
  def('array.unshift', ['id', 'value'], (a, _r, _s, n) => { arr(a[0], n).items.unshift(a[1]); return NaN; });
  def('array.pop', ['id'], (a, _r, _s, n) => { const A = arr(a[0], n); return A.items.length ? A.items.pop() : NaN; });
  def('array.shift', ['id'], (a, _r, _s, n) => { const A = arr(a[0], n); return A.items.length ? A.items.shift() : NaN; });
  def('array.get', ['id', 'index'], (a, _r, _s, n) => { const A = arr(a[0], n); return A.items[idx(A, a[1], n)]; });
  def('array.set', ['id', 'index', 'value'], (a, _r, _s, n) => { const A = arr(a[0], n); A.items[idx(A, a[1], n)] = a[2]; return NaN; });
  def('array.insert', ['id', 'index', 'value'], (a, _r, _s, n) => { const A = arr(a[0], n); A.items.splice(idx(A, a[1], n, true), 0, a[2]); return NaN; });
  def('array.remove', ['id', 'index'], (a, _r, _s, n) => { const A = arr(a[0], n); return A.items.splice(idx(A, a[1], n), 1)[0]; });
  def('array.clear', ['id'], (a, _r, _s, n) => { arr(a[0], n).items.length = 0; return NaN; });
  def('array.first', ['id'], (a, _r, _s, n) => { const A = arr(a[0], n); return A.items.length ? A.items[0] : NaN; });
  def('array.last', ['id'], (a, _r, _s, n) => { const A = arr(a[0], n); return A.items.length ? A.items[A.items.length - 1] : NaN; });
  def('array.includes', ['id', 'value'], (a, _r, _s, n) => arr(a[0], n).items.includes(a[1]));
  def('array.indexof', ['id', 'value'], (a, _r, _s, n) => arr(a[0], n).items.indexOf(a[1]));
  def('array.lastindexof', ['id', 'value'], (a, _r, _s, n) => arr(a[0], n).items.lastIndexOf(a[1]));
  def('array.reverse', ['id'], (a, _r, _s, n) => { arr(a[0], n).items.reverse(); return NaN; });
  def('array.concat', ['id1', 'id2'], (a, _r, _s, n) => { const A = arr(a[0], n); A.items.push(...arr(a[1], n).items); return A; });
  def('array.slice', ['id', 'index_from', 'index_to'], (a, _r, _s, n) => {
    const A = arr(a[0], n);
    return new PineArray(A.items.slice(len(a[1]), a[2] === undefined ? undefined : len(a[2])), A.type);
  });
  def('array.fill', ['id', 'value', 'index_from', 'index_to'], (a, _r, _s, n) => {
    const A = arr(a[0], n);
    A.items.fill(a[1], a[2] === undefined ? 0 : len(a[2]), a[3] === undefined ? undefined : len(a[3]));
    return NaN;
  });
  def('array.join', ['id', 'separator'], (a, rt, _s, n) => arr(a[0], n).items.map((x) => toStr(x, undefined, rt)).join(a[1] === undefined ? '' : String(a[1])));
  def('array.sort', ['id', 'order'], (a, _r, _s, n) => {
    const A = arr(a[0], n), desc = a[1] === 'desc';
    A.items.sort((x, y) => (typeof x === 'string' ? String(x).localeCompare(String(y)) : num(x) - num(y)) * (desc ? -1 : 1));
    return NaN;
  });
  def('array.sum', ['id'], (a, _r, _s, n) => nums(arr(a[0], n)).reduce((s, x) => s + x, 0));
  def('array.avg', ['id'], (a, _r, _s, n) => { const xs = nums(arr(a[0], n)); return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN; });
  def('array.max', ['id', 'nth'], (a, _r, _s, n) => { const xs = nums(arr(a[0], n)).sort((x, y) => y - x); return xs[a[1] === undefined ? 0 : len(a[1])] ?? NaN; });
  def('array.min', ['id', 'nth'], (a, _r, _s, n) => { const xs = nums(arr(a[0], n)).sort((x, y) => x - y); return xs[a[1] === undefined ? 0 : len(a[1])] ?? NaN; });
  def('array.range', ['id'], (a, _r, _s, n) => { const xs = nums(arr(a[0], n)); return xs.length ? Math.max(...xs) - Math.min(...xs) : NaN; });
  def('array.median', ['id'], (a, _r, _s, n) => {
    const s = nums(arr(a[0], n)).sort((x, y) => x - y);
    if (!s.length) return NaN;
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  });
  def('array.stdev', ['id', 'biased'], (a, _r, _s, n) => {
    const xs = nums(arr(a[0], n));
    return xs.length ? stdevB(xs, xs.length, a[1] !== false) : NaN;
  });
  def('array.variance', ['id', 'biased'], (a, _r, _s, n) => {
    const xs = nums(arr(a[0], n));
    return xs.length ? stdevB(xs, xs.length, a[1] !== false) ** 2 : NaN;
  });
  def('array.percentile_linear_interpolation', ['id', 'percentage'], (a, _r, _s, n) => percentileLinear(nums(arr(a[0], n)), num(a[1])));
  def('array.abs', ['id'], (a, _r, _s, n) => new PineArray(arr(a[0], n).items.map((x) => Math.abs(num(x)))));
  def('array.every', ['id'], (a, _r, _s, n) => arr(a[0], n).items.every(truthy));
  def('array.some', ['id'], (a, _r, _s, n) => arr(a[0], n).items.some(truthy));

  // table
  const PINE_TEXT_SIZE = new Set(['auto', 'tiny', 'small', 'normal', 'large', 'huge']);
  const tbl = (v: any, node: PN): PineTable | null => {
    if (v instanceof PineTable) return v;
    if (isNa(v)) return null;
    throw new PineError('Expected a table', node.line, node.col, 'runtime');
  };
  def('table.new', ['position', 'columns', 'rows', 'bgcolor', 'frame_color', 'frame_width', 'border_color', 'border_width', 'force_overlay'], (a, rt, _s, node) => {
    const cols = Math.max(1, Math.min(100, len(a[1]) || 1)), rows = Math.max(1, Math.min(100, len(a[2]) || 1));
    const t = new PineTable(String(a[0] || 'top_right'), cols, rows, PineColors.css(a[3]), PineColors.css(a[4]),
      num(a[5]) || 0, PineColors.css(a[6]), num(a[7]) || 0);
    rt.addTable(node.id, t);
    return t;
  });
  def('table.cell', ['table_id', 'column', 'row', 'text', 'width', 'height', 'text_color', 'text_halign', 'text_valign',
    'text_size', 'bgcolor', 'tooltip', 'text_font_family', 'text_formatting'], (a, _rt, _s, node) => {
    const t = tbl(a[0], node);
    if (!t) return NaN;
    const c = len(a[1]), r = len(a[2]);
    if (!(c >= 0 && c < t.cols && r >= 0 && r < t.rows)) {
      throw new PineError(`Cell (${c}, ${r}) is outside the table (${t.cols}×${t.rows})`, node.line, node.col, 'runtime');
    }
    t.cells[r][c] = {
      text: a[3] === undefined || isNa(a[3]) ? '' : String(a[3]),
      width: num(a[4]) || 0, height: num(a[5]) || 0,
      textColor: a[6] === undefined ? '#000000' : PineColors.css(a[6]),
      halign: String(a[7] || 'center'), valign: String(a[8] || 'center'),
      size: PINE_TEXT_SIZE.has(a[9]) ? a[9] : 'normal',
      bg: PineColors.css(a[10]), tooltip: a[11] === undefined ? '' : String(a[11]),
    };
    return NaN;
  });
  const cellSet = (name: string, apply: (cell: PineTableCell, v: any) => void) =>
    def(`table.cell_set_${name}`, ['table_id', 'column', 'row', name], (a, _rt, _s, node) => {
      const t = tbl(a[0], node);
      const cell = t?.cells[len(a[2])]?.[len(a[1])];
      if (cell) apply(cell, a[3]);
      return NaN;
    });
  cellSet('text', (c, v) => { c.text = isNa(v) ? '' : String(v); });
  cellSet('text_color', (c, v) => { c.textColor = PineColors.css(v); });
  cellSet('bgcolor', (c, v) => { c.bg = PineColors.css(v); });
  cellSet('text_size', (c, v) => { c.size = PINE_TEXT_SIZE.has(v) ? v : 'normal'; });
  cellSet('text_halign', (c, v) => { c.halign = String(v); });
  cellSet('text_valign', (c, v) => { c.valign = String(v); });
  cellSet('tooltip', (c, v) => { c.tooltip = String(v ?? ''); });
  cellSet('width', (c, v) => { c.width = num(v) || 0; });
  cellSet('height', (c, v) => { c.height = num(v) || 0; });
  def('table.clear', ['table_id', 'start_column', 'start_row', 'end_column', 'end_row'], (a, _rt, _s, node) => {
    const t = tbl(a[0], node);
    if (!t) return NaN;
    const c0 = len(a[1]), r0 = len(a[2]);
    const c1 = a[3] === undefined ? c0 : len(a[3]), r1 = a[4] === undefined ? r0 : len(a[4]);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (t.cells[r]) t.cells[r][c] = null;
    return NaN;
  });
  def('table.delete', ['table_id'], (a, _rt, _s, node) => { const t = tbl(a[0], node); if (t) t.deleted = true; return NaN; });
  def('table.merge_cells', ['table_id', 'start_column', 'start_row', 'end_column', 'end_row'], () => NaN);
  def('table.set_position', ['table_id', 'position'], (a, _rt, _s, node) => { const t = tbl(a[0], node); if (t) t.position = String(a[1]); return NaN; });
  def('table.set_bgcolor', ['table_id', 'bgcolor'], (a, _rt, _s, node) => { const t = tbl(a[0], node); if (t) t.bg = PineColors.css(a[1]); return NaN; });
  def('table.set_frame_color', ['table_id', 'frame_color'], (a, _rt, _s, node) => { const t = tbl(a[0], node); if (t) t.frameColor = PineColors.css(a[1]); return NaN; });
  def('table.set_border_color', ['table_id', 'border_color'], (a, _rt, _s, node) => { const t = tbl(a[0], node); if (t) t.borderColor = PineColors.css(a[1]); return NaN; });

  function hasFn(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(FNS, name);
  }

  return {
    FNS, VARS, PRICE_SERIES, hasFn, constant, priceAt, precompute, isNa, num, truthy, toStr, back,
  };
})();
