/*
 * Charts page: drawing tools. Each tool is a definition (how many clicks it
 * takes, its defaults, how it renders and how it's hit-tested); every pane
 * gets one PaneDrawingsPrimitive that paints all of that pane's drawings onto
 * the chart's own canvas, so they pan, zoom and scale with it for free.
 */

/** What a drawing renders against: coordinate converters for one pane. */
interface DrawingFrame {
  toX(time: number): number | null;
  toY(price: number): number | null;
  /** Fractional logical index of a time on the shared axis (for bar counts). */
  logical(time: number): number;
  width: number;
  height: number;
  theme: ReturnType<typeof ChartTheme.get>;
  /** The pane's candles, for tools that read volume. */
  bars: ChartBar[];
  /** Times at the left and right edges of the visible area. */
  visible: [number, number];
}

interface DrawingHit { part: 'body' | 'handle'; index: number; }

interface DrawingToolDef {
  type: string;
  label: string;
  /** Inline SVG (18x18 viewBox) for the toolbar. */
  icon: string;
  /** Clicks needed to place it. */
  points: number;
  /** Line options the style bar should offer. */
  lineStyle: boolean;
  canFill: boolean;
  canExtend: boolean;
  /** The colour swatches don't apply (the tool uses fixed colours). */
  noColor?: boolean;
  /** Settings offered as chips in the style bar. */
  params?: { key: string; label: string; options: number[]; def: number }[];
  init(d: ChartDrawing, theme: ReturnType<typeof ChartTheme.get>): void;
  draw(ctx: CanvasRenderingContext2D, d: ChartDrawing, f: DrawingFrame): void;
  hit(d: ChartDrawing, f: DrawingFrame, x: number, y: number): boolean;
  handles(d: ChartDrawing, f: DrawingFrame): ({ x: number; y: number } | null)[];
  /** Move handle `index` to `p`; the default replaces that anchor. */
  moveHandle?(d: ChartDrawing, index: number, p: ChartPoint): void;
}

const ChartDrawings = (() => {
  const HIT_PX = 6;

  const FIB_DEFAULT: ChartFibLevel[] = [
    { value: 0, on: true }, { value: 0.236, on: true }, { value: 0.382, on: true },
    { value: 0.5, on: true }, { value: 0.618, on: true }, { value: 0.786, on: true },
    { value: 1, on: true }, { value: 1.618, on: false }, { value: 2.618, on: false },
    { value: 3.618, on: false }, { value: 4.236, on: false },
  ];
  const FIB_COLORS: Record<string, string> = {
    '0': '#8B9196', '0.236': '#F2545B', '0.382': '#FF9F5B', '0.5': '#3DDC97',
    '0.618': '#2EC4B6', '0.786': '#5CA8E0', '1': '#8B9196', '1.618': '#7AA2F7',
    '2.618': '#F2545B', '3.618': '#B9A3FF', '4.236': '#FF8FA3',
  };

  function fibColor(v: number): string {
    return FIB_COLORS[String(v)] || '#9FB0B8';
  }

  // ── Canvas helpers ────────────────────────────────────────────────────────

  function stroke(ctx: CanvasRenderingContext2D, s: ChartDrawingStyle, color?: string): void {
    ctx.strokeStyle = color || s.color;
    ctx.lineWidth = s.width;
    ctx.setLineDash(s.dash === 'dashed' ? [6, 4] : s.dash === 'dotted' ? [1.5, 3] : []);
  }

  function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string,
                  theme: DrawingFrame['theme'], align: 'left' | 'right' | 'center' = 'left', boxed = false): { w: number; h: number } {
    ctx.font = `11px ${theme.font}`;
    const w = ctx.measureText(text).width;
    const h = 16;
    let bx = align === 'right' ? x - w - 8 : align === 'center' ? x - w / 2 - 4 : x;
    if (boxed) {
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      roundRect(ctx, bx, y - h / 2, w + 8, h, 3);
      ctx.fill();
      ctx.fillStyle = theme.dark ? '#0B0D0E' : '#FFFFFF';
    } else {
      ctx.fillStyle = color;
    }
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(text, bx + 4, y + 0.5);
    return { w: w + 8, h };
  }

  function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function xy(f: DrawingFrame, p: ChartPoint | undefined): { x: number; y: number } | null {
    if (!p) return null;
    const x = f.toX(p.time), y = f.toY(p.price);
    return x == null || y == null ? null : { x, y };
  }

  /** A two-point line's on-screen segment, extended per its style. */
  function lineSeg(d: ChartDrawing, f: DrawingFrame): [number, number, number, number] | null {
    const a = xy(f, d.points[0]), b = xy(f, d.points[1]);
    if (!a || !b) return null;
    return ChartGeo.extendSegment(a.x, a.y, b.x, b.y, f.width, !!d.style.extendLeft, !!d.style.extendRight);
  }

  /** The channel's parallel line: the base line shifted by the 3rd anchor's price offset. */
  function channelOffset(d: ChartDrawing): number {
    const [a, b, c] = d.points;
    if (!c) return 0;
    if (b.time === a.time) return c.price - a.price;
    const slope = (b.price - a.price) / (b.time - a.time);
    return c.price - (a.price + slope * (c.time - a.time));
  }

  /** Prices of the fib levels that are switched on. Level 0 sits at B, 1 at A. */
  function fibLevels(d: ChartDrawing): { value: number; price: number }[] {
    const [a, b] = d.points;
    const levels = (d.levels || FIB_DEFAULT).filter((l) => l.on);
    return levels.map((l) => ({ value: l.value, price: b.price - (b.price - a.price) * l.value }));
  }

  function fmtTime(t: number): string {
    const dt = new Date(t * 1000);
    return dt.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // ── Icons ─────────────────────────────────────────────────────────────────

  const svg = (body: string) =>
    `<svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">${body}</svg>`;
  const dot = (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="1.6" fill="currentColor" stroke="none"/>`;

  // ── Tool definitions ──────────────────────────────────────────────────────

  function lineTool(type: string, label: string, icon: string, extendLeft: boolean, extendRight: boolean): DrawingToolDef {
    return {
      type, label, icon, points: 2, lineStyle: true, canFill: false, canExtend: true,
      init(d) { d.style.extendLeft = extendLeft; d.style.extendRight = extendRight; },
      draw(ctx, d, f) {
        const s = lineSeg(d, f);
        if (!s) return;
        stroke(ctx, d.style);
        line(ctx, ...s);
      },
      hit(d, f, x, y) {
        const s = lineSeg(d, f);
        return !!s && ChartGeo.distToSegment(x, y, ...s) <= HIT_PX;
      },
      handles: (d, f) => [xy(f, d.points[0]), xy(f, d.points[1])],
    };
  }

  // ── Volume tools ──────────────────────────────────────────────────────────

  /** The pane's bars between two times (inclusive). */
  function barsBetween(f: DrawingFrame, t1: number, t2: number): ChartBar[] {
    const lo = Math.min(t1, t2), hi = Math.max(t1, t2);
    return f.bars.filter((b) => b.time >= lo && b.time <= hi);
  }

  /** Time of the first bar at or after `t` (the bar an anchor lands on). */
  function anchorBar(f: DrawingFrame, t: number): ChartBar | undefined {
    return f.bars.find((b) => b.time >= t) ?? f.bars[f.bars.length - 1];
  }

  function param(d: ChartDrawing, key: string, def: number): number {
    const v = d.params?.[key];
    return typeof v === 'number' && isFinite(v) ? v : def;
  }

  /**
   * Paint a volume profile: one row per price bin, buy volume then sell
   * volume, growing away from `x` (rightwards for 'left', leftwards for
   * 'right'). Rows inside the value area are stronger; the point of control
   * is a line across [spanX1, spanX2].
   */
  function drawProfile(ctx: CanvasRenderingContext2D, prof: VolumeProfile, f: DrawingFrame,
                       x: number, side: 'left' | 'right', maxW: number,
                       spanX1: number, spanX2: number, vaLines: boolean): void {
    const upC = f.theme.palette[4], downC = f.theme.palette[3];
    ctx.setLineDash([]);
    prof.bins.forEach((bin, i) => {
      const y1 = f.toY(bin.hi), y2 = f.toY(bin.lo);
      if (y1 == null || y2 == null) return;
      const top = Math.min(y1, y2), h = Math.max(1, Math.abs(y2 - y1) - 1);
      const inVA = i >= prof.vaLo && i <= prof.vaHi;
      const wU = (bin.up / prof.max) * maxW, wD = (bin.down / prof.max) * maxW;
      ctx.fillStyle = ChartTheme.alpha(upC, inVA ? 0.55 : 0.22);
      ctx.fillRect(side === 'left' ? x : x - wU, top, wU, h);
      ctx.fillStyle = ChartTheme.alpha(downC, inVA ? 0.55 : 0.22);
      ctx.fillRect(side === 'left' ? x + wU : x - wU - wD, top, wD, h);
    });
    const poc = prof.bins[prof.poc];
    const py1 = f.toY(poc.hi), py2 = f.toY(poc.lo);
    if (py1 != null && py2 != null) {
      const py = (py1 + py2) / 2;
      ctx.strokeStyle = f.theme.neg;
      ctx.lineWidth = 1.5;
      line(ctx, spanX1, py, spanX2, py);
      // Inside the span's far end, so it never runs off the pane.
      const text = `POC ${ChartGeo.formatPrice((poc.hi + poc.lo) / 2)}`;
      if (side === 'left') label(ctx, text, Math.min(spanX2, f.width) - 2, py - 9, f.theme.neg, f.theme, 'right');
      else label(ctx, text, Math.max(spanX1, 0) + 2, py - 9, f.theme.neg, f.theme, 'left');
    }
    if (vaLines) {
      const vh = f.toY(prof.bins[prof.vaHi].hi), vl = f.toY(prof.bins[prof.vaLo].lo);
      ctx.strokeStyle = ChartTheme.alpha(upC, 0.7);
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      if (vh != null) line(ctx, spanX1, vh, spanX2, vh);
      if (vl != null) line(ctx, spanX1, vl, spanX2, vl);
      ctx.setLineDash([]);
    }
  }

  /** The time range a range/anchored profile covers. */
  function profileSpan(d: ChartDrawing, f: DrawingFrame): [number, number] | null {
    if (!f.bars.length) return null;
    if (d.type === 'avp') return [d.points[0].time, f.bars[f.bars.length - 1].time];
    return [Math.min(d.points[0].time, d.points[1].time), Math.max(d.points[0].time, d.points[1].time)];
  }

  /** The profile and its on-screen box, or null when there's nothing to show. */
  function profileLayout(d: ChartDrawing, f: DrawingFrame) {
    const span = profileSpan(d, f);
    if (!span) return null;
    const bars = barsBetween(f, span[0], span[1]);
    const prof = ChartIndicators.volumeProfile(bars, param(d, 'rows', 24), param(d, 'va', 70));
    const x1 = f.toX(span[0]), x2 = f.toX(span[1]);
    if (!prof || x1 == null || x2 == null) return null;
    const yTop = f.toY(prof.bins[prof.bins.length - 1].hi), yBot = f.toY(prof.bins[0].lo);
    if (yTop == null || yBot == null) return null;
    return { prof, x1, x2: Math.max(x2, x1 + 2), yTop: Math.min(yTop, yBot), yBot: Math.max(yTop, yBot) };
  }

  function drawRangeProfile(ctx: CanvasRenderingContext2D, d: ChartDrawing, f: DrawingFrame): void {
    const L = profileLayout(d, f);
    if (!L) {
      // No candles in range yet: show where it'll go.
      const a = xy(f, d.points[0]), b = d.points[1] ? xy(f, d.points[1]) : null;
      if (a) {
        ctx.strokeStyle = ChartTheme.alpha(f.theme.text, 0.5);
        ctx.setLineDash([4, 4]);
        line(ctx, a.x, 0, a.x, f.height);
        if (b) line(ctx, b.x, 0, b.x, f.height);
      }
      return;
    }
    ctx.fillStyle = ChartTheme.alpha(f.theme.palette[4], 0.04);
    ctx.fillRect(L.x1, L.yTop, L.x2 - L.x1, L.yBot - L.yTop);
    ctx.strokeStyle = ChartTheme.alpha(f.theme.palette[4], 0.35);
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(L.x1, L.yTop, L.x2 - L.x1, L.yBot - L.yTop);
    const width = Math.max(40, (L.x2 - L.x1) * param(d, 'width', 40) / 100);
    drawProfile(ctx, L.prof, f, L.x1, 'left', width, L.x1, L.x2, true);
  }

  function hitRangeProfile(d: ChartDrawing, f: DrawingFrame, x: number, y: number): boolean {
    const L = profileLayout(d, f);
    if (!L) return false;
    return x >= L.x1 - HIT_PX && x <= L.x2 + HIT_PX && y >= L.yTop - HIT_PX && y <= L.yBot + HIT_PX;
  }

  /** Anchored VWAP from the bar at/after the anchor to the latest bar. */
  function avwapPoints(d: ChartDrawing, f: DrawingFrame): { time: number; value: number }[] {
    const start = anchorBar(f, d.points[0].time);
    if (!start) return [];
    const out: { time: number; value: number }[] = [];
    let pv = 0, vol = 0;
    for (const b of f.bars) {
      if (b.time < start.time) continue;
      const tp = (b.high + b.low + b.close) / 3;
      pv += tp * b.volume;
      vol += b.volume;
      out.push({ time: b.time, value: vol ? pv / vol : tp });
    }
    return out;
  }

  const volumeParams = [
    { key: 'rows', label: 'Rows', options: [12, 24, 48, 96], def: 24 },
    { key: 'va', label: 'Value area %', options: [50, 70, 80], def: 70 },
  ];

  const TOOLS: DrawingToolDef[] = [
    lineTool('trend', 'Trend line', svg(`<path d="M3 15 15 3"/>${dot(3, 15)}${dot(15, 3)}`), false, false),
    lineTool('ray', 'Ray', svg(`<path d="M4 14 17 1"/>${dot(4, 14)}${dot(9, 9)}`), false, true),
    lineTool('extended', 'Extended line', svg(`<path d="M1 17 17 1"/>${dot(6, 12)}${dot(12, 6)}`), true, true),
    {
      type: 'hline', label: 'Horizontal line', points: 1, lineStyle: true, canFill: false, canExtend: false,
      icon: svg(`<path d="M1 9h16"/>${dot(9, 9)}`),
      init() {},
      draw(ctx, d, f) {
        const y = f.toY(d.points[0].price);
        if (y == null) return;
        stroke(ctx, d.style);
        line(ctx, 0, y, f.width, y);
      },
      hit(d, f, _x, y) {
        const py = f.toY(d.points[0].price);
        return py != null && Math.abs(py - y) <= HIT_PX;
      },
      handles: (d, f) => [xy(f, d.points[0])],
      moveHandle(d, _i, p) { d.points[0] = { time: p.time, price: p.price }; },
    },
    {
      type: 'hray', label: 'Horizontal ray', points: 1, lineStyle: true, canFill: false, canExtend: false,
      icon: svg(`<path d="M4 9h13"/>${dot(4, 9)}`),
      init() {},
      draw(ctx, d, f) {
        const a = xy(f, d.points[0]);
        if (!a) return;
        stroke(ctx, d.style);
        line(ctx, a.x, a.y, f.width, a.y);
      },
      hit(d, f, x, y) {
        const a = xy(f, d.points[0]);
        return !!a && x >= a.x - HIT_PX && Math.abs(a.y - y) <= HIT_PX;
      },
      handles: (d, f) => [xy(f, d.points[0])],
    },
    {
      type: 'vline', label: 'Vertical line', points: 1, lineStyle: true, canFill: false, canExtend: false,
      icon: svg(`<path d="M9 1v16"/>${dot(9, 9)}`),
      init() {},
      draw(ctx, d, f) {
        const x = f.toX(d.points[0].time);
        if (x == null) return;
        stroke(ctx, d.style);
        line(ctx, x, 0, x, f.height);
      },
      hit(d, f, x) {
        const px = f.toX(d.points[0].time);
        return px != null && Math.abs(px - x) <= HIT_PX;
      },
      handles: (d, f) => [xy(f, d.points[0])],
    },
    {
      type: 'channel', label: 'Parallel channel', points: 3, lineStyle: true, canFill: true, canExtend: true,
      icon: svg(`<path d="M2 11 12 3M6 15 16 7"/><path d="M4 13 14 5" stroke-dasharray="1.5 2"/>`),
      init(d) { d.style.fill = true; },
      draw(ctx, d, f) {
        const off = channelOffset(d);
        const [a, b] = d.points;
        const base = [xy(f, a), xy(f, b)];
        const par = [xy(f, { time: a.time, price: a.price + off }), xy(f, { time: b.time, price: b.price + off })];
        const mid = [xy(f, { time: a.time, price: a.price + off / 2 }), xy(f, { time: b.time, price: b.price + off / 2 })];
        if (!base[0] || !base[1] || !par[0] || !par[1] || !mid[0] || !mid[1]) return;
        const L = !!d.style.extendLeft, R = !!d.style.extendRight;
        const s1 = ChartGeo.extendSegment(base[0].x, base[0].y, base[1].x, base[1].y, f.width, L, R);
        const s2 = ChartGeo.extendSegment(par[0].x, par[0].y, par[1].x, par[1].y, f.width, L, R);
        const sm = ChartGeo.extendSegment(mid[0].x, mid[0].y, mid[1].x, mid[1].y, f.width, L, R);
        if (d.style.fill) {
          ctx.fillStyle = ChartTheme.alpha(d.style.color, 0.1);
          ctx.beginPath();
          ctx.moveTo(s1[0], s1[1]); ctx.lineTo(s1[2], s1[3]);
          ctx.lineTo(s2[2], s2[3]); ctx.lineTo(s2[0], s2[1]);
          ctx.closePath();
          ctx.fill();
        }
        stroke(ctx, d.style);
        line(ctx, ...s1);
        line(ctx, ...s2);
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = ChartTheme.alpha(d.style.color, 0.7);
        line(ctx, ...sm);
      },
      hit(d, f, x, y) {
        const off = channelOffset(d);
        const [a, b] = d.points;
        const pts = [a, b, { time: a.time, price: a.price + off }, { time: b.time, price: b.price + off }].map((p) => xy(f, p));
        if (pts.some((p) => !p)) return false;
        const [p0, p1, p2, p3] = pts as { x: number; y: number }[];
        const L = !!d.style.extendLeft, R = !!d.style.extendRight;
        const s1 = ChartGeo.extendSegment(p0.x, p0.y, p1.x, p1.y, f.width, L, R);
        const s2 = ChartGeo.extendSegment(p2.x, p2.y, p3.x, p3.y, f.width, L, R);
        if (ChartGeo.distToSegment(x, y, ...s1) <= HIT_PX || ChartGeo.distToSegment(x, y, ...s2) <= HIT_PX) return true;
        if (!d.style.fill) return false;
        // Inside the band: between the two lines at this x, within their span.
        const minX = Math.min(s1[0], s1[2]), maxX = Math.max(s1[0], s1[2]);
        if (x < minX || x > maxX || s1[2] === s1[0]) return false;
        const t = (x - s1[0]) / (s1[2] - s1[0]);
        const y1 = s1[1] + t * (s1[3] - s1[1]), y2 = s2[1] + t * (s2[3] - s2[1]);
        return y >= Math.min(y1, y2) && y <= Math.max(y1, y2);
      },
      handles(d, f) {
        const off = channelOffset(d);
        const [a, b] = d.points;
        const midT = (a.time + b.time) / 2;
        const midP = (a.price + b.price) / 2 + off;
        return [xy(f, a), xy(f, b), xy(f, { time: midT, price: midP })];
      },
      moveHandle(d, i, p) {
        if (i < 2) {
          // Keep the parallel line's offset while the base line moves.
          const off = channelOffset(d);
          d.points[i] = p;
          const [a] = d.points;
          d.points[2] = { time: a.time, price: a.price + off };
        } else {
          d.points[2] = p;
        }
      },
    },
    {
      type: 'fib', label: 'Fib retracement', points: 2, lineStyle: false, canFill: true, canExtend: true,
      icon: svg(`<path d="M2 3h14M2 7h14M2 11h14M2 15h14" /><path d="M3 15 15 3" stroke-dasharray="1.5 2"/>`),
      init(d) {
        d.levels = FIB_DEFAULT.map((l) => ({ ...l }));
        d.style.fill = true;
      },
      draw(ctx, d, f) {
        const a = xy(f, d.points[0]), b = xy(f, d.points[1]);
        if (!a || !b) return;
        const x1 = d.style.extendLeft ? 0 : Math.min(a.x, b.x);
        const x2 = d.style.extendRight ? f.width : Math.max(a.x, b.x);
        const levels = fibLevels(d).map((l) => ({ ...l, y: f.toY(l.price) })).filter((l) => l.y != null) as
          { value: number; price: number; y: number }[];
        levels.sort((p, q) => p.y - q.y);
        if (d.style.fill) {
          for (let i = 0; i < levels.length - 1; i++) {
            ctx.fillStyle = ChartTheme.alpha(fibColor(levels[i + 1].value), 0.08);
            ctx.fillRect(x1, levels[i].y, x2 - x1, levels[i + 1].y - levels[i].y);
          }
        }
        for (const l of levels) {
          const c = fibColor(l.value);
          ctx.strokeStyle = c;
          ctx.lineWidth = 1;
          ctx.setLineDash([]);
          line(ctx, x1, l.y, x2, l.y);
          label(ctx, `${l.value} (${ChartGeo.formatPrice(l.price)})`, x1 + 2, l.y - 9, c, f.theme);
        }
        ctx.strokeStyle = ChartTheme.alpha(f.theme.text, 0.8);
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        line(ctx, a.x, a.y, b.x, b.y);
      },
      hit(d, f, x, y) {
        const a = xy(f, d.points[0]), b = xy(f, d.points[1]);
        if (!a || !b) return false;
        const x1 = d.style.extendLeft ? 0 : Math.min(a.x, b.x);
        const x2 = d.style.extendRight ? f.width : Math.max(a.x, b.x);
        if (x < x1 - HIT_PX || x > x2 + HIT_PX) return false;
        if (ChartGeo.distToSegment(x, y, a.x, a.y, b.x, b.y) <= HIT_PX) return true;
        return fibLevels(d).some((l) => {
          const ly = f.toY(l.price);
          return ly != null && Math.abs(ly - y) <= HIT_PX;
        });
      },
      handles: (d, f) => [xy(f, d.points[0]), xy(f, d.points[1])],
    },
    {
      type: 'rect', label: 'Rectangle', points: 2, lineStyle: true, canFill: true, canExtend: false,
      icon: svg(`<rect x="3" y="5" width="12" height="8" rx="1"/>${dot(3, 5)}${dot(15, 13)}`),
      init(d) { d.style.fill = true; },
      draw(ctx, d, f) {
        const a = xy(f, d.points[0]), b = xy(f, d.points[1]);
        if (!a || !b) return;
        const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(a.x - b.x), h = Math.abs(a.y - b.y);
        if (d.style.fill) {
          ctx.fillStyle = ChartTheme.alpha(d.style.color, 0.12);
          ctx.fillRect(x, y, w, h);
        }
        stroke(ctx, d.style);
        ctx.strokeRect(x, y, w, h);
      },
      hit(d, f, x, y) {
        const a = xy(f, d.points[0]), b = xy(f, d.points[1]);
        if (!a || !b) return false;
        const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x), y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
        const inside = x >= x1 - HIT_PX && x <= x2 + HIT_PX && y >= y1 - HIT_PX && y <= y2 + HIT_PX;
        if (!inside) return false;
        if (d.style.fill) return true;
        return Math.abs(x - x1) <= HIT_PX || Math.abs(x - x2) <= HIT_PX || Math.abs(y - y1) <= HIT_PX || Math.abs(y - y2) <= HIT_PX;
      },
      handles: (d, f) => [xy(f, d.points[0]), xy(f, d.points[1])],
    },
    {
      type: 'measure', label: 'Price range', points: 2, lineStyle: false, canFill: false, canExtend: false,
      icon: svg(`<path d="M9 2v14M5 6l4-4 4 4M5 12l4 4 4-4"/>`),
      init() {},
      draw(ctx, d, f) {
        const [pa, pb] = d.points;
        const a = xy(f, pa), b = xy(f, pb);
        if (!a || !b) return;
        const up = pb.price >= pa.price;
        const c = up ? f.theme.pos : f.theme.neg;
        const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(a.x - b.x), h = Math.abs(a.y - b.y);
        ctx.fillStyle = ChartTheme.alpha(c, 0.14);
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = c;
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        const mx = x + w / 2;
        line(ctx, mx, a.y, mx, b.y);
        line(ctx, x, (a.y + b.y) / 2, x + w, (a.y + b.y) / 2);
        // Arrow head at the end point.
        const dir = b.y < a.y ? 1 : -1;
        line(ctx, mx, b.y, mx - 4, b.y + 5 * dir);
        line(ctx, mx, b.y, mx + 4, b.y + 5 * dir);
        const diff = pb.price - pa.price;
        const pct = pa.price ? (diff / pa.price) * 100 : 0;
        const bars = Math.round(Math.abs(f.logical(pb.time) - f.logical(pa.time)));
        const sign = diff >= 0 ? '+' : '−';
        const text = `${sign}${ChartGeo.formatPrice(Math.abs(diff))} (${sign}${Math.abs(pct).toFixed(2)}%) · ${bars} bars · ${ChartGeo.formatSpan(pb.time - pa.time)}`;
        const ly = up ? y - 12 : y + h + 12;
        label(ctx, text, mx, ly, c, f.theme, 'center', true);
      },
      hit(d, f, x, y) {
        const a = xy(f, d.points[0]), b = xy(f, d.points[1]);
        if (!a || !b) return false;
        return x >= Math.min(a.x, b.x) - HIT_PX && x <= Math.max(a.x, b.x) + HIT_PX &&
               y >= Math.min(a.y, b.y) - HIT_PX && y <= Math.max(a.y, b.y) + HIT_PX;
      },
      handles: (d, f) => [xy(f, d.points[0]), xy(f, d.points[1])],
    },
    {
      type: 'text', label: 'Text', points: 1, lineStyle: false, canFill: true, canExtend: false,
      icon: svg(`<path d="M4 4h10M9 4v11"/>`),
      init(d) { d.text = ''; d.style.fill = true; },
      draw(ctx, d, f) {
        const a = xy(f, d.points[0]);
        if (!a) return;
        const text = d.text || 'Text';
        ctx.font = `13px ${f.theme.font}`;
        const w = ctx.measureText(text).width + 12;
        if (d.style.fill) {
          ctx.fillStyle = ChartTheme.alpha(d.style.color, 0.16);
          roundRect(ctx, a.x, a.y - 11, w, 22, 3);
          ctx.fill();
        }
        ctx.fillStyle = d.style.color;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.setLineDash([]);
        ctx.fillText(text, a.x + 6, a.y + 0.5);
      },
      hit(d, f, x, y) {
        const a = xy(f, d.points[0]);
        if (!a) return false;
        const approxW = (d.text || 'Text').length * 8 + 12;
        return x >= a.x - 2 && x <= a.x + approxW && Math.abs(y - a.y) <= 12;
      },
      handles: (d, f) => [xy(f, d.points[0])],
    },
  ];

  TOOLS.push(
    {
      type: 'frvp', label: 'Fixed range volume profile', points: 2, lineStyle: false, canFill: false, canExtend: false,
      noColor: true, params: volumeParams,
      icon: svg(`<path d="M3 3v12M15 3v12" stroke-dasharray="1.5 2"/><path d="M3 5h5M3 8h9M3 11h6M3 14h3" stroke-width="2"/>`),
      init(d) { d.params = { rows: 24, va: 70 }; },
      draw: drawRangeProfile,
      hit: hitRangeProfile,
      handles(d, f) {
        const L = profileLayout(d, f);
        return d.points.map((p, i) => {
          const x = f.toX(p.time);
          if (x == null) return null;
          if (!L) return xy(f, p);
          return { x, y: i === 0 ? L.yTop : L.yBot };
        });
      },
      // Only the time matters: the profile spans whatever prices traded.
      moveHandle(d, i, p) { d.points[i] = { time: p.time, price: d.points[i].price }; },
    },
    {
      type: 'avp', label: 'Anchored volume profile', points: 1, lineStyle: false, canFill: false, canExtend: false,
      noColor: true, params: volumeParams,
      icon: svg(`<path d="M3 3v12" /><path d="M3 5h4M3 8h10M3 11h7M3 14h4" stroke-width="2"/><circle cx="3" cy="3" r="1.6" fill="currentColor" stroke="none"/>`),
      init(d) { d.params = { rows: 24, va: 70 }; },
      draw: drawRangeProfile,
      hit: hitRangeProfile,
      handles(d, f) {
        const L = profileLayout(d, f);
        const x = f.toX(d.points[0].time);
        if (x == null) return [null];
        return [L ? { x, y: L.yTop } : xy(f, d.points[0])];
      },
      moveHandle(d, _i, p) { d.points[0] = { time: p.time, price: d.points[0].price }; },
    },
    {
      type: 'avwap', label: 'Anchored VWAP', points: 1, lineStyle: true, canFill: false, canExtend: false,
      icon: svg(`<path d="M2 14c3-1 4-6 7-6s4 3 7 2" /><circle cx="2" cy="14" r="1.6" fill="currentColor" stroke="none"/>`),
      init(d, theme) { d.style.color = theme.palette[6]; },
      draw(ctx, d, f) {
        const pts = avwapPoints(d, f);
        if (!pts.length) return;
        stroke(ctx, d.style);
        ctx.beginPath();
        let started = false, last: { x: number; y: number } | null = null;
        for (const p of pts) {
          const x = f.toX(p.time), y = f.toY(p.value);
          if (x == null || y == null) continue;
          if (x < -50 || x > f.width + 50) { started = false; continue; }
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
          last = { x, y };
        }
        ctx.stroke();
        if (last) label(ctx, `VWAP ${ChartGeo.formatPrice(pts[pts.length - 1].value)}`, Math.min(last.x, f.width) - 2, last.y - 11, d.style.color, f.theme, 'right');
      },
      hit(d, f, x, y) {
        const pts = avwapPoints(d, f);
        for (let i = 1; i < pts.length; i++) {
          const x1 = f.toX(pts[i - 1].time), x2 = f.toX(pts[i].time);
          if (x1 == null || x2 == null || x < Math.min(x1, x2) - HIT_PX || x > Math.max(x1, x2) + HIT_PX) continue;
          const y1 = f.toY(pts[i - 1].value), y2 = f.toY(pts[i].value);
          if (y1 != null && y2 != null && ChartGeo.distToSegment(x, y, x1, y1, x2, y2) <= HIT_PX) return true;
        }
        return false;
      },
      handles(d, f) {
        const first = avwapPoints(d, f)[0];
        if (!first) return [xy(f, d.points[0])];
        const x = f.toX(first.time), y = f.toY(first.value);
        return [x == null || y == null ? null : { x, y }];
      },
      moveHandle(d, _i, p) { d.points[0] = { time: p.time, price: p.price }; },
    },
  );

  const byType: Record<string, DrawingToolDef> = {};
  TOOLS.forEach((t) => { byType[t.type] = t; });

  /** "ALERT ↑" (armed) or "FIRED" at the right-hand end of a line with an alert. */
  function drawAlertBadge(ctx: CanvasRenderingContext2D, d: ChartDrawing, f: DrawingFrame): void {
    const alert = ChartAlerts.get(d.alertId);
    if (!alert) return;
    let pos: { x: number; y: number } | null;
    if (d.type === 'hline' || d.type === 'hray') {
      const y = f.toY(d.points[0].price);
      pos = y == null ? null : { x: f.width - 4, y };
    } else {
      // Where the (extended) line meets the right edge, or its end point.
      const s = lineSeg(d, f);
      if (!s) return;
      const [x1, y1, x2, y2] = s;
      const right = Math.min(x2, f.width - 4);
      const t = x2 === x1 ? 1 : (right - x1) / (x2 - x1);
      pos = { x: right, y: y1 + t * (y2 - y1) };
    }
    if (!pos) return;
    const armed = alert.status === 'active';
    const text = armed ? `ALERT ${alert.direction === 'above' ? '↑' : '↓'}` : 'FIRED';
    ctx.font = `600 10px ${f.theme.font}`;
    const w = ctx.measureText(text).width + 10;
    const x = Math.max(2, pos.x - w);
    const color = armed ? f.theme.accent : f.theme.text;
    ctx.setLineDash([]);
    ctx.fillStyle = armed ? color : ChartTheme.alpha(color, 0.25);
    roundRect(ctx, x, pos.y - 17, w, 14, 3);
    ctx.fill();
    ctx.fillStyle = armed ? f.theme.accentInk : f.theme.text;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(text, x + 5, pos.y - 9.5);
  }

  function create(type: string, p: ChartPoint, theme: ReturnType<typeof ChartTheme.get>, color?: string): ChartDrawing {
    const def = byType[type];
    const d: ChartDrawing = {
      id: ChartGeo.uid('d'),
      type,
      points: Array.from({ length: def.points }, () => ({ ...p })),
      style: { color: color || theme.palette[4], width: 2, dash: 'solid', fill: false },
    };
    def.init(d, theme);
    return d;
  }

  /** Default handle move: replace the anchor (a horizontal line keeps only the price). */
  function moveHandle(d: ChartDrawing, index: number, p: ChartPoint): void {
    const def = byType[d.type];
    if (def?.moveHandle) def.moveHandle(d, index, p);
    else d.points[index] = { ...p };
  }

  function hitTest(drawings: ChartDrawing[], f: DrawingFrame, x: number, y: number, selectedId: string | null): { d: ChartDrawing; hit: DrawingHit } | null {
    // Handles first (topmost drawing wins), then bodies.
    for (let i = drawings.length - 1; i >= 0; i--) {
      const d = drawings[i];
      if (d.hidden) continue;
      const def = byType[d.type];
      if (!def) continue;
      if (d.id === selectedId || !d.locked) {
        const hs = def.handles(d, f);
        for (let h = 0; h < hs.length; h++) {
          const p = hs[h];
          if (p && Math.hypot(p.x - x, p.y - y) <= HIT_PX + 2) return { d, hit: { part: 'handle', index: h } };
        }
      }
    }
    for (let i = drawings.length - 1; i >= 0; i--) {
      const d = drawings[i];
      if (d.hidden) continue;
      const def = byType[d.type];
      if (def && def.hit(d, f, x, y)) return { d, hit: { part: 'body', index: -1 } };
    }
    return null;
  }

  function drawAll(ctx: CanvasRenderingContext2D, drawings: ChartDrawing[], f: DrawingFrame,
                   selectedId: string | null, hoverId: string | null, allHidden: boolean): void {
    for (const d of drawings) {
      if ((d.hidden || allHidden) && d.id !== selectedId) continue;
      const def = byType[d.type];
      if (!def) continue;
      ctx.save();
      try { def.draw(ctx, d, f); } catch { /* a malformed drawing never breaks the chart */ }
      ctx.restore();
      if (d.alertId != null) {
        ctx.save();
        try { drawAlertBadge(ctx, d, f); } catch { /* cosmetic */ }
        ctx.restore();
      }
      if (d.id === selectedId || d.id === hoverId) {
        ctx.save();
        for (const h of def.handles(d, f)) {
          if (!h) continue;
          ctx.beginPath();
          ctx.arc(h.x, h.y, d.id === selectedId ? 4.5 : 3.5, 0, Math.PI * 2);
          ctx.fillStyle = f.theme.dark ? '#0B0D0E' : '#FFFFFF';
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.setLineDash([]);
          ctx.strokeStyle = d.locked ? f.theme.text : d.style.color;
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }

  return { tools: TOOLS, get: (t: string) => byType[t], create, moveHandle, hitTest, drawAll, fibColor, fmtTime, FIB_DEFAULT, drawProfile };
})();

/**
 * Volume Profile (visible range): recomputed from the bars on screen on every
 * paint, so it follows panning and zooming. Drawn under the candles.
 */
class VisibleProfilePrimitive {
  private requestUpdateFn: (() => void) | null = null;
  private readonly view: any;

  constructor(private frame: () => DrawingFrame | null, private params: () => Record<string, number>) {
    this.view = {
      zOrder: () => 'bottom',
      renderer: () => ({
        draw: (target: any) => {
          const f = this.frame();
          if (!f || !f.bars.length) return;
          target.useMediaCoordinateSpace(({ context, mediaSize }: any) => {
            f.width = mediaSize.width;
            f.height = mediaSize.height;
            const p = this.params();
            const [from, to] = f.visible;
            const bars = f.bars.filter((b) => b.time >= from && b.time <= to);
            const prof = ChartIndicators.volumeProfile(bars, p.rows || 24, p.va || 70);
            if (!prof) return;
            const w = f.width * Math.min(0.8, Math.max(0.05, (p.width || 30) / 100));
            const right = (p.side || 0) === 0;
            ChartDrawings.drawProfile(context, prof, f, right ? f.width : 0, right ? 'right' : 'left', w,
              right ? f.width - w : 0, right ? f.width : w, false);
          });
        },
      }),
    };
  }

  attached(p: { requestUpdate: () => void }): void { this.requestUpdateFn = p.requestUpdate; }
  detached(): void { this.requestUpdateFn = null; }
  update(): void { this.requestUpdateFn?.(); }
  updateAllViews(): void {}
  paneViews(): any[] { return [this.view]; }
}

/** Host-side hooks a pane's drawing layer reads from on every paint. */
interface PaneDrawingsHost {
  drawings(): ChartDrawing[];
  frame(): DrawingFrame | null;
  selectedId(): string | null;
  hoverId(): string | null;
  allHidden(): boolean;
}

/**
 * lightweight-charts series primitive that paints one pane's drawings. It also
 * puts price labels on the axis for horizontal lines and for the selected
 * drawing's anchors, and a time label for vertical lines.
 */
class PaneDrawingsPrimitive {
  private requestUpdateFn: (() => void) | null = null;
  private readonly view: any;

  constructor(private host: PaneDrawingsHost) {
    this.view = {
      zOrder: () => 'top',
      renderer: () => ({
        draw: (target: any) => {
          const f = this.host.frame();
          if (!f) return;
          target.useMediaCoordinateSpace(({ context, mediaSize }: any) => {
            f.width = mediaSize.width;
            f.height = mediaSize.height;
            ChartDrawings.drawAll(context, this.host.drawings(), f, this.host.selectedId(), this.host.hoverId(), this.host.allHidden());
          });
        },
      }),
    };
  }

  attached(p: { requestUpdate: () => void }): void { this.requestUpdateFn = p.requestUpdate; }
  detached(): void { this.requestUpdateFn = null; }
  update(): void { this.requestUpdateFn?.(); }
  updateAllViews(): void {}
  paneViews(): any[] { return [this.view]; }

  priceAxisViews(): any[] {
    const f = this.host.frame();
    if (!f) return [];
    const sel = this.host.selectedId();
    const out: any[] = [];
    const ink = f.theme.dark ? '#0B0D0E' : '#FFFFFF';
    for (const d of this.host.drawings()) {
      if ((d.hidden || this.host.allHidden()) && d.id !== sel) continue;
      const prices: number[] = [];
      if (d.type === 'hline' || d.type === 'hray') prices.push(d.points[0].price);
      else if (d.id === sel && d.type !== 'vline' && d.type !== 'text') d.points.slice(0, 2).forEach((p) => prices.push(p.price));
      for (const price of prices) {
        const y = f.toY(price);
        if (y == null) continue;
        out.push({
          coordinate: () => y,
          text: () => ChartGeo.formatPrice(price),
          textColor: () => ink,
          backColor: () => d.style.color,
          visible: () => true,
          tickVisible: () => true,
        });
      }
    }
    return out;
  }

  timeAxisViews(): any[] {
    const f = this.host.frame();
    if (!f) return [];
    const sel = this.host.selectedId();
    const out: any[] = [];
    const ink = f.theme.dark ? '#0B0D0E' : '#FFFFFF';
    for (const d of this.host.drawings()) {
      if ((d.hidden || this.host.allHidden()) && d.id !== sel) continue;
      if (d.type !== 'vline' && d.id !== sel) continue;
      const pts = d.type === 'vline' ? [d.points[0]] : d.points.slice(0, 2);
      for (const p of pts) {
        const x = f.toX(p.time);
        if (x == null) continue;
        out.push({
          coordinate: () => x,
          text: () => ChartDrawings.fmtTime(p.time),
          textColor: () => ink,
          backColor: () => d.style.color,
          visible: () => true,
          tickVisible: () => true,
        });
      }
    }
    return out;
  }
}
