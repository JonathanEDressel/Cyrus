/*
 * Charts page: technical indicators. Pure calculations over a pane's bars;
 * the workspace turns each output line into a lightweight-charts series.
 * Overlay indicators draw on the price pane; the others get their own pane
 * directly under the symbol they belong to.
 */

/**
 * `color` is a tone the workspace maps to the theme: 'pos', 'neg' or 'muted'.
 * `gap` starts a fresh segment (no line joins it to the point before).
 */
interface IndicatorPoint { time: number; value: number; color?: 'pos' | 'neg' | 'muted'; gap?: boolean; }

interface IndicatorParam {
  key: string;
  label: string;
  def: number;
  min: number;
  max: number;
  step?: number;
  /** A fixed choice (shown as a dropdown) instead of a free number. */
  options?: { value: number; label: string }[];
}

/** Volume traded per price row, for the volume profile tools. */
interface VolumeProfileBin { lo: number; hi: number; up: number; down: number; }
interface VolumeProfile {
  bins: VolumeProfileBin[];
  /** Busiest row (point of control) and the value area around it. */
  poc: number;
  vaLo: number;
  vaHi: number;
  max: number;
}

interface IndicatorLine {
  key: string;
  label: string;
  kind: 'line' | 'histogram';
  points: IndicatorPoint[];
  /** Index into the colour scheme; 0 is the indicator's own colour. */
  tone: number;
}

interface IndicatorDef {
  type: string;
  label: string;
  /** Heading it's listed under in the Indicators menu. */
  group: string;
  overlay: boolean;
  /** Drawn by the chart as a volume profile rather than as series. */
  profile?: boolean;
  params: IndicatorParam[];
  /** Fixed range for oscillators (RSI is always 0-100). */
  range?: [number, number];
  /** Horizontal guide lines (RSI 70/30). */
  guides?: number[];
  short(p: Record<string, number>): string;
  compute(bars: ChartBar[], p: Record<string, number>): IndicatorLine[];
}

const ChartIndicators = (() => {
  function sma(values: number[], n: number): (number | null)[] {
    const out: (number | null)[] = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= n) sum -= values[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function ema(values: number[], n: number): (number | null)[] {
    const out: (number | null)[] = new Array(values.length).fill(null);
    if (values.length < n) return out;
    const k = 2 / (n + 1);
    let prev = 0;
    for (let i = 0; i < n; i++) prev += values[i];
    prev /= n;
    out[n - 1] = prev;
    for (let i = n; i < values.length; i++) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function toPoints(bars: ChartBar[], vals: (number | null)[]): IndicatorPoint[] {
    const pts: IndicatorPoint[] = [];
    for (let i = 0; i < bars.length; i++) {
      const v = vals[i];
      if (v != null && isFinite(v)) pts.push({ time: bars[i].time, value: v });
    }
    return pts;
  }

  const DEFS: IndicatorDef[] = [
    {
      type: 'sma', label: 'Moving Average (SMA)', group: 'Trend', overlay: true,
      params: [{ key: 'length', label: 'Length', def: 20, min: 1, max: 500 }],
      short: (p) => `SMA ${p.length}`,
      compute(bars, p) {
        const v = sma(bars.map((b) => b.close), Math.round(p.length));
        return [{ key: 'sma', label: `SMA ${p.length}`, kind: 'line', points: toPoints(bars, v), tone: 0 }];
      },
    },
    {
      type: 'ema', label: 'Exponential MA (EMA)', group: 'Trend', overlay: true,
      params: [{ key: 'length', label: 'Length', def: 21, min: 1, max: 500 }],
      short: (p) => `EMA ${p.length}`,
      compute(bars, p) {
        const v = ema(bars.map((b) => b.close), Math.round(p.length));
        return [{ key: 'ema', label: `EMA ${p.length}`, kind: 'line', points: toPoints(bars, v), tone: 0 }];
      },
    },
    {
      type: 'bb', label: 'Bollinger Bands', group: 'Trend', overlay: true,
      params: [
        { key: 'length', label: 'Length', def: 20, min: 2, max: 500 },
        { key: 'mult', label: 'Std dev', def: 2, min: 0.5, max: 5, step: 0.1 },
      ],
      short: (p) => `BB ${p.length} ${p.mult}`,
      compute(bars, p) {
        const n = Math.round(p.length);
        const closes = bars.map((b) => b.close);
        const mid = sma(closes, n);
        const up: (number | null)[] = [], lo: (number | null)[] = [];
        for (let i = 0; i < closes.length; i++) {
          const m = mid[i];
          if (m == null) { up.push(null); lo.push(null); continue; }
          let s = 0;
          for (let j = i - n + 1; j <= i; j++) s += (closes[j] - m) ** 2;
          const sd = Math.sqrt(s / n);
          up.push(m + p.mult * sd);
          lo.push(m - p.mult * sd);
        }
        return [
          { key: 'upper', label: 'Upper', kind: 'line', points: toPoints(bars, up), tone: 0 },
          { key: 'basis', label: 'Basis', kind: 'line', points: toPoints(bars, mid), tone: 1 },
          { key: 'lower', label: 'Lower', kind: 'line', points: toPoints(bars, lo), tone: 0 },
        ];
      },
    },
    {
      type: 'rsi', label: 'Relative Strength (RSI)', group: 'Momentum', overlay: false,
      params: [{ key: 'length', label: 'Length', def: 14, min: 2, max: 200 }],
      range: [0, 100], guides: [70, 30],
      short: (p) => `RSI ${p.length}`,
      compute(bars, p) {
        const n = Math.round(p.length);
        const out: (number | null)[] = new Array(bars.length).fill(null);
        let gain = 0, loss = 0;
        for (let i = 1; i < bars.length; i++) {
          const ch = bars[i].close - bars[i - 1].close;
          const g = Math.max(ch, 0), l = Math.max(-ch, 0);
          if (i <= n) {
            gain += g; loss += l;
            if (i === n) { gain /= n; loss /= n; }
            else continue;
          } else {
            // Wilder's smoothing.
            gain = (gain * (n - 1) + g) / n;
            loss = (loss * (n - 1) + l) / n;
          }
          out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
        }
        return [{ key: 'rsi', label: `RSI ${n}`, kind: 'line', points: toPoints(bars, out), tone: 0 }];
      },
    },
    {
      type: 'macd', label: 'MACD', group: 'Momentum', overlay: false,
      params: [
        { key: 'fast', label: 'Fast', def: 12, min: 1, max: 200 },
        { key: 'slow', label: 'Slow', def: 26, min: 2, max: 300 },
        { key: 'signal', label: 'Signal', def: 9, min: 1, max: 100 },
      ],
      guides: [0],
      short: (p) => `MACD ${p.fast} ${p.slow} ${p.signal}`,
      compute(bars, p) {
        const closes = bars.map((b) => b.close);
        const f = ema(closes, Math.round(p.fast)), s = ema(closes, Math.round(p.slow));
        const macd: (number | null)[] = closes.map((_, i) => (f[i] != null && s[i] != null ? (f[i] as number) - (s[i] as number) : null));
        // Signal is an EMA of the MACD line where it exists.
        const start = macd.findIndex((v) => v != null);
        const sig: (number | null)[] = new Array(closes.length).fill(null);
        if (start >= 0) {
          const tail = ema(macd.slice(start) as number[], Math.round(p.signal));
          tail.forEach((v, i) => { sig[start + i] = v; });
        }
        const hist: (number | null)[] = macd.map((m, i) => (m != null && sig[i] != null ? m - (sig[i] as number) : null));
        return [
          { key: 'hist', label: 'Histogram', kind: 'histogram', points: toPoints(bars, hist), tone: 2 },
          { key: 'macd', label: 'MACD', kind: 'line', points: toPoints(bars, macd), tone: 0 },
          { key: 'signal', label: 'Signal', kind: 'line', points: toPoints(bars, sig), tone: 1 },
        ];
      },
    },
  ];

  // ── Volume ──────────────────────────────────────────────────────────────

  const typical = (b: ChartBar) => (b.high + b.low + b.close) / 3;

  /** Money-flow multiplier: where the close sits in the bar's range, -1..1. */
  const mfm = (b: ChartBar) => (b.high > b.low ? ((b.close - b.low) - (b.high - b.close)) / (b.high - b.low) : 0);

  /** Start of the UTC day / week (Monday) / month containing `t`. */
  function periodStart(t: number, anchor: number): number {
    const d = new Date(t * 1000);
    if (anchor === 2) return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
    const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
    if (anchor === 1) return day - ((d.getUTCDay() + 6) % 7) * 86400;
    return day;
  }

  /** Cumulative running total of per-bar values. */
  function cumulative(vals: number[]): number[] {
    let acc = 0;
    return vals.map((v) => (acc += v));
  }

  DEFS.push(
    {
      type: 'vpvr', label: 'Volume Profile (visible range)', group: 'Volume', overlay: true, profile: true,
      params: [
        { key: 'rows', label: 'Rows', def: 24, min: 6, max: 200 },
        { key: 'va', label: 'Value area %', def: 70, min: 10, max: 100 },
        { key: 'width', label: 'Width % of pane', def: 30, min: 5, max: 80 },
        { key: 'side', label: 'Placement', def: 0, min: 0, max: 1, options: [{ value: 0, label: 'Right' }, { value: 1, label: 'Left' }] },
      ],
      short: (p) => `VPVR ${p.rows}`,
      compute: () => [],
    },
    {
      type: 'vwap', label: 'VWAP', group: 'Volume', overlay: true,
      params: [
        { key: 'anchor', label: 'Resets every', def: 0, min: 0, max: 2, options: [{ value: 0, label: 'Day' }, { value: 1, label: 'Week' }, { value: 2, label: 'Month' }] },
        { key: 'bands', label: 'Band std devs (0 = off)', def: 0, min: 0, max: 4, step: 0.5 },
      ],
      short: (p) => `VWAP ${['D', 'W', 'M'][p.anchor] || 'D'}${p.bands ? ` ±${p.bands}` : ''}`,
      compute(bars, p) {
        const vwap: (number | null)[] = [], up: (number | null)[] = [], dn: (number | null)[] = [];
        let period = -1, pv = 0, vol = 0, pv2 = 0;
        for (const b of bars) {
          const start = periodStart(b.time, Math.round(p.anchor));
          if (start !== period) { period = start; pv = 0; vol = 0; pv2 = 0; }
          const tp = typical(b);
          pv += tp * b.volume; vol += b.volume; pv2 += tp * tp * b.volume;
          if (!vol) { vwap.push(null); up.push(null); dn.push(null); continue; }
          const m = pv / vol;
          const sd = Math.sqrt(Math.max(0, pv2 / vol - m * m));
          vwap.push(m);
          up.push(p.bands ? m + p.bands * sd : null);
          dn.push(p.bands ? m - p.bands * sd : null);
        }
        // Each period starts afresh: no line from the last period's close.
        const resets = new Set<number>();
        let prevStart = -1;
        bars.forEach((b, i) => {
          const st = periodStart(b.time, Math.round(p.anchor));
          if (i && st !== prevStart) resets.add(b.time);
          prevStart = st;
        });
        const gapped = (vals: (number | null)[]) => toPoints(bars, vals).map((pt) => (resets.has(pt.time) ? { ...pt, gap: true } : pt));
        const out: IndicatorLine[] = [{ key: 'vwap', label: 'VWAP', kind: 'line', points: gapped(vwap), tone: 0 }];
        if (p.bands) {
          out.push({ key: 'upper', label: 'Upper', kind: 'line', points: gapped(up), tone: 1 });
          out.push({ key: 'lower', label: 'Lower', kind: 'line', points: gapped(dn), tone: 1 });
        }
        return out;
      },
    },
    {
      type: 'vwma', label: 'Volume-Weighted MA (VWMA)', group: 'Volume', overlay: true,
      params: [{ key: 'length', label: 'Length', def: 20, min: 1, max: 500 }],
      short: (p) => `VWMA ${p.length}`,
      compute(bars, p) {
        const n = Math.round(p.length);
        const pv = sma(bars.map((b) => b.close * b.volume), n), v = sma(bars.map((b) => b.volume), n);
        const out = pv.map((x, i) => (x != null && v[i] ? x / (v[i] as number) : null));
        return [{ key: 'vwma', label: `VWMA ${n}`, kind: 'line', points: toPoints(bars, out), tone: 0 }];
      },
    },
    {
      type: 'obv', label: 'On-Balance Volume (OBV)', group: 'Volume', overlay: false,
      params: [],
      short: () => 'OBV',
      compute(bars) {
        const vals = cumulative(bars.map((b, i) => (i === 0 ? 0 : Math.sign(b.close - bars[i - 1].close) * b.volume)));
        return [{ key: 'obv', label: 'OBV', kind: 'line', points: toPoints(bars, vals), tone: 0 }];
      },
    },
    {
      type: 'ad', label: 'Accumulation/Distribution', group: 'Volume', overlay: false,
      params: [],
      short: () => 'A/D',
      compute(bars) {
        const vals = cumulative(bars.map((b) => mfm(b) * b.volume));
        return [{ key: 'ad', label: 'A/D', kind: 'line', points: toPoints(bars, vals), tone: 0 }];
      },
    },
    {
      type: 'cmf', label: 'Chaikin Money Flow (CMF)', group: 'Volume', overlay: false,
      params: [{ key: 'length', label: 'Length', def: 20, min: 1, max: 200 }],
      guides: [0],
      short: (p) => `CMF ${p.length}`,
      compute(bars, p) {
        const n = Math.round(p.length);
        const mfv = sma(bars.map((b) => mfm(b) * b.volume), n), v = sma(bars.map((b) => b.volume), n);
        const out = mfv.map((x, i) => (x != null && v[i] ? x / (v[i] as number) : null));
        return [{ key: 'cmf', label: `CMF ${n}`, kind: 'line', points: toPoints(bars, out), tone: 0 }];
      },
    },
    {
      type: 'mfi', label: 'Money Flow Index (MFI)', group: 'Volume', overlay: false,
      params: [{ key: 'length', label: 'Length', def: 14, min: 2, max: 200 }],
      range: [0, 100], guides: [80, 20],
      short: (p) => `MFI ${p.length}`,
      compute(bars, p) {
        const n = Math.round(p.length);
        const out: (number | null)[] = new Array(bars.length).fill(null);
        const pos: number[] = [], neg: number[] = [];
        for (let i = 0; i < bars.length; i++) {
          const tp = typical(bars[i]), prev = i ? typical(bars[i - 1]) : tp;
          const flow = tp * bars[i].volume;
          pos.push(tp > prev ? flow : 0);
          neg.push(tp < prev ? flow : 0);
          if (i >= n) {
            let ps = 0, ns = 0;
            for (let j = i - n + 1; j <= i; j++) { ps += pos[j]; ns += neg[j]; }
            out[i] = ns === 0 ? 100 : 100 - 100 / (1 + ps / ns);
          }
        }
        return [{ key: 'mfi', label: `MFI ${n}`, kind: 'line', points: toPoints(bars, out), tone: 0 }];
      },
    },
    {
      type: 'vosc', label: 'Volume Oscillator', group: 'Volume', overlay: false,
      params: [
        { key: 'fast', label: 'Fast', def: 5, min: 1, max: 200 },
        { key: 'slow', label: 'Slow', def: 10, min: 2, max: 400 },
      ],
      guides: [0],
      short: (p) => `Vol Osc ${p.fast} ${p.slow}`,
      compute(bars, p) {
        const v = bars.map((b) => b.volume);
        const f = ema(v, Math.round(p.fast)), sl = ema(v, Math.round(p.slow));
        const out = f.map((x, i) => (x != null && sl[i] ? (100 * (x - (sl[i] as number))) / (sl[i] as number) : null));
        return [{ key: 'vosc', label: 'Vol Osc %', kind: 'line', points: toPoints(bars, out), tone: 0 }];
      },
    },
    {
      type: 'pvt', label: 'Price Volume Trend', group: 'Volume', overlay: false,
      params: [],
      short: () => 'PVT',
      compute(bars) {
        const vals = cumulative(bars.map((b, i) => (i && bars[i - 1].close ? ((b.close - bars[i - 1].close) / bars[i - 1].close) * b.volume : 0)));
        return [{ key: 'pvt', label: 'PVT', kind: 'line', points: toPoints(bars, vals), tone: 0 }];
      },
    },
    {
      type: 'efi', label: "Elder's Force Index", group: 'Volume', overlay: false,
      params: [{ key: 'length', label: 'Length', def: 13, min: 1, max: 200 }],
      guides: [0],
      short: (p) => `EFI ${p.length}`,
      compute(bars, p) {
        const raw = bars.map((b, i) => (i ? (b.close - bars[i - 1].close) * b.volume : 0));
        const out = ema(raw, Math.round(p.length));
        return [{ key: 'efi', label: `EFI ${p.length}`, kind: 'line', points: toPoints(bars, out), tone: 0 }];
      },
    },
    {
      type: 'eom', label: 'Ease of Movement', group: 'Volume', overlay: false,
      params: [{ key: 'length', label: 'Length', def: 14, min: 1, max: 200 }],
      guides: [0],
      short: (p) => `EOM ${p.length}`,
      compute(bars, p) {
        // change(hl2) * (high - low) / volume, as TradingView computes it,
        // with the average volume as the divisor so values stay readable.
        const avgVol = bars.reduce((a, b) => a + b.volume, 0) / Math.max(1, bars.length) || 1;
        const raw = bars.map((b, i) => {
          if (!i || !b.volume) return 0;
          const mid = (b.high + b.low) / 2 - (bars[i - 1].high + bars[i - 1].low) / 2;
          return (mid * (b.high - b.low)) / (b.volume / avgVol);
        });
        const out = sma(raw, Math.round(p.length));
        return [{ key: 'eom', label: `EOM ${p.length}`, kind: 'line', points: toPoints(bars, out), tone: 0 }];
      },
    },
    {
      type: 'netvol', label: 'Net Volume', group: 'Volume', overlay: false,
      params: [],
      guides: [0],
      short: () => 'Net Volume',
      compute(bars) {
        const pts = bars.map((b, i) => {
          const dir = i ? Math.sign(b.close - bars[i - 1].close) : Math.sign(b.close - b.open);
          return { time: b.time, value: dir * b.volume };
        });
        return [{ key: 'net', label: 'Net', kind: 'histogram', points: pts, tone: 2 }];
      },
    },
    {
      type: 'rvol', label: 'Relative Volume', group: 'Volume', overlay: false,
      params: [{ key: 'length', label: 'Average of', def: 20, min: 2, max: 500 }],
      guides: [1],
      short: (p) => `RVOL ${p.length}`,
      compute(bars, p) {
        const n = Math.round(p.length);
        // Each bar against the average of the n bars before it.
        const avg = sma(bars.map((b) => b.volume), n);
        const pts: IndicatorPoint[] = [];
        for (let i = 1; i < bars.length; i++) {
          const a = avg[i - 1];
          if (!a) continue;
          const r = bars[i].volume / a;
          pts.push({ time: bars[i].time, value: r, color: r >= 2 ? 'pos' : r >= 1 ? 'muted' : 'neg' });
        }
        return [{ key: 'rvol', label: 'RVOL', kind: 'histogram', points: pts, tone: 2 }];
      },
    },
  );

  /**
   * Volume by price over some bars. With no finer-grained trades to go on,
   * each bar's volume is spread evenly across the price rows its range
   * covers (as TradingView does without lower-timeframe data). The value
   * area grows out from the busiest row, taking the busier neighbour each
   * step, until it holds `vaPct` of the volume.
   */
  function volumeProfile(bars: ChartBar[], rows: number, vaPct: number): VolumeProfile | null {
    if (!bars.length) return null;
    let lo = Infinity, hi = -Infinity;
    for (const b of bars) { if (b.low < lo) lo = b.low; if (b.high > hi) hi = b.high; }
    if (!isFinite(lo) || !isFinite(hi)) return null;
    if (hi <= lo) hi = lo + Math.max(Math.abs(lo) * 1e-4, 1e-8);
    const n = Math.max(1, Math.round(rows));
    const step = (hi - lo) / n;
    const bins: VolumeProfileBin[] = Array.from({ length: n }, (_, i) => ({ lo: lo + i * step, hi: lo + (i + 1) * step, up: 0, down: 0 }));
    const idx = (p: number) => Math.max(0, Math.min(n - 1, Math.floor((p - lo) / step)));
    for (const b of bars) {
      const v = b.volume || 0;
      if (!(v > 0)) continue;
      const side: 'up' | 'down' = b.close >= b.open ? 'up' : 'down';
      if (b.high <= b.low) { bins[idx(b.close)][side] += v; continue; }
      for (let i = idx(b.low); i <= idx(b.high); i++) {
        const overlap = Math.min(b.high, bins[i].hi) - Math.max(b.low, bins[i].lo);
        if (overlap > 0) bins[i][side] += (v * overlap) / (b.high - b.low);
      }
    }
    const tot = (i: number) => bins[i].up + bins[i].down;
    let total = 0, poc = 0, max = 0;
    for (let i = 0; i < n; i++) {
      total += tot(i);
      if (tot(i) > max) { max = tot(i); poc = i; }
    }
    if (!(total > 0)) return null;
    let a = poc, z = poc, acc = tot(poc);
    const target = total * Math.min(1, Math.max(0, vaPct / 100));
    while (acc < target && (a > 0 || z < n - 1)) {
      const below = a > 0 ? tot(a - 1) : -1;
      const above = z < n - 1 ? tot(z + 1) : -1;
      if (above >= below) { z++; acc += above; } else { a--; acc += below; }
    }
    return { bins, poc, vaLo: a, vaHi: z, max };
  }

  const byType: Record<string, IndicatorDef> = {};
  DEFS.forEach((d) => { byType[d.type] = d; });

  function defaults(type: string): Record<string, number> {
    const d = byType[type];
    const out: Record<string, number> = {};
    d?.params.forEach((p) => { out[p.key] = p.def; });
    return out;
  }

  return { list: DEFS, get: (type: string): IndicatorDef | undefined => byType[type], defaults, volumeProfile };
})();
