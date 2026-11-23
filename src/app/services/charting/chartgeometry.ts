/*
 * Charts page: shared types and pure geometry helpers.
 *
 * Drawings are anchored to (time, price), never to pixels or bar indexes, so
 * they survive a timeframe change, older history loading in, and a reload.
 * Converting between time and x goes through the chart's shared time axis
 * (one sorted list of bar times across every pane): a time maps to a
 * fractional "logical" index on that axis, and lightweight-charts maps logical
 * indexes to x. Times past either end of the data extrapolate at one bar per
 * timeframe step, so an anchor out in empty space still lands correctly.
 */

interface ChartBar { time: number; open: number; high: number; low: number; close: number; volume: number; }
interface ChartPoint { time: number; price: number; }

type ChartDash = 'solid' | 'dashed' | 'dotted';

interface ChartDrawingStyle {
  color: string;
  width: number;
  dash: ChartDash;
  fill: boolean;
  extendLeft?: boolean;
  extendRight?: boolean;
}

interface ChartFibLevel { value: number; on: boolean; }

interface ChartDrawing {
  id: string;
  type: string;
  points: ChartPoint[];
  style: ChartDrawingStyle;
  levels?: ChartFibLevel[];
  text?: string;
  locked?: boolean;
  hidden?: boolean;
  /** A price alert that follows this line (see ChartAlerts). */
  alertId?: number;
  /** Tool settings, e.g. a volume profile's row count. */
  params?: Record<string, number>;
}

/** Per-output style overrides for a script indicator (its Style settings). */
interface ChartScriptStyle { visible?: boolean; color?: string; width?: number; }

interface ChartIndicatorSpec {
  id: string;
  /** A ChartIndicators type, or 'script' for a custom Pine Script indicator. */
  type: string;
  /** For type 'script': the saved script (CustomIndicators). */
  scriptId?: number;
  /** Built-ins hold numbers; scripts also hold bools, strings and colours. */
  params: Record<string, number | boolean | string>;
  color?: string;
  /** For scripts: style overrides per output key. */
  styles?: Record<string, ChartScriptStyle>;
}

interface ChartPaneState {
  id: string;
  symbol: string;
  source: string;
  volume: boolean;
  indicators: ChartIndicatorSpec[];
  drawings: ChartDrawing[];
}

type ChartType = 'candles' | 'bars' | 'line' | 'area';

/** How compared coins are shown: a pane each, or overlaid as % change. */
type ChartCompareMode = 'stacked' | 'percent';

interface ChartState {
  v: 1;
  timeframe: string;
  chartType: ChartType;
  compareMode?: ChartCompareMode;
  /** Draw the user's open orders, fills and average cost (default on). */
  showMine?: boolean;
  panes: ChartPaneState[];
  view?: { barSpacing?: number };
}

const ChartGeo = (() => {
  const TIMEFRAME_SECONDS: Record<string, number> = {
    '1m': 60, '5m': 300, '15m': 900, '30m': 1800,
    '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800,
  };

  function tfSeconds(tf: string): number {
    return TIMEFRAME_SECONDS[tf] || 3600;
  }

  /** Index of the last element <= t, or -1. `times` is sorted ascending. */
  function floorIndex(times: number[], t: number): number {
    let lo = 0, hi = times.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  /** Time -> fractional logical index on the axis, extrapolating past the ends. */
  function timeToLogical(times: number[], t: number, step: number): number {
    const n = times.length;
    if (n === 0) return 0;
    if (t <= times[0]) return (t - times[0]) / step;
    if (t >= times[n - 1]) return n - 1 + (t - times[n - 1]) / step;
    const i = floorIndex(times, t);
    const t0 = times[i], t1 = times[i + 1];
    return t1 === t0 ? i : i + (t - t0) / (t1 - t0);
  }

  /** Fractional logical index -> time, the inverse of timeToLogical. */
  function logicalToTime(times: number[], l: number, step: number): number {
    const n = times.length;
    if (n === 0) return Math.round(Date.now() / 1000);
    if (l <= 0) return Math.round(times[0] + l * step);
    if (l >= n - 1) return Math.round(times[n - 1] + (l - (n - 1)) * step);
    const i = Math.floor(l);
    const f = l - i;
    return Math.round(times[i] + f * (times[i + 1] - times[i]));
  }

  /** Distance from (px,py) to the segment a-b. */
  function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  /**
   * The segment a-b stretched to the edges of a box `w` wide when extended
   * left and/or right. A vertical segment can't extend sideways.
   */
  function extendSegment(ax: number, ay: number, bx: number, by: number, w: number,
                         left: boolean, right: boolean): [number, number, number, number] {
    if (ax === bx) return [ax, ay, bx, by];
    const slope = (by - ay) / (bx - ax);
    let x1 = ax, y1 = ay, x2 = bx, y2 = by;
    // Order so (x1,y1) is the left end.
    if (x1 > x2) { [x1, y1, x2, y2] = [x2, y2, x1, y1]; }
    const goLeft = ax <= bx ? left : right;
    const goRight = ax <= bx ? right : left;
    if (goLeft) { y1 = y1 + slope * (-1e4 - x1); x1 = -1e4; }
    if (goRight) { y2 = y2 + slope * (w + 1e4 - x2); x2 = w + 1e4; }
    return [x1, y1, x2, y2];
  }

  /** A price with sensible decimals; `stock` prices trade in cents. */
  function formatPrice(p: number, stock = false): string {
    if (!isFinite(p)) return '—';
    const a = Math.abs(p);
    const digits = stock ? (a >= 1 ? 2 : 4) : a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8;
    return p.toLocaleString(undefined, { minimumFractionDigits: Math.min(digits, 2), maximumFractionDigits: digits });
  }

  function formatSpan(seconds: number): string {
    const s = Math.abs(seconds);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return h ? `${d}d ${h}h` : `${d}d`;
    if (h) return m ? `${h}h ${m}m` : `${h}h`;
    return `${m}m`;
  }

  function uid(prefix: string): string {
    return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  return {
    TIMEFRAMES: Object.keys(TIMEFRAME_SECONDS),
    tfSeconds, floorIndex, timeToLogical, logicalToTime,
    distToSegment, extendSegment, formatPrice, formatSpan, uid,
  };
})();
