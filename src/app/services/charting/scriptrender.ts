/*
 * Drawing a Pine Script's output on the chart, for what lightweight-charts
 * series can't show on their own: fill() between two plots or hlines,
 * bgcolor() columns, hline() levels, plotshape()/plotchar() markers and
 * table() overlays. Plots themselves are ordinary series (see
 * ChartWorkspace.applyScript).
 */

/** What the primitive reads on every paint. */
interface ScriptPaneHost {
  result(): PineRunResult | null;
  /** The bars the result is indexed by. */
  bars(): ChartBar[];
  /** A series on this pane, for price ↔ y. */
  series(): any;
  /** x for a bar time, or null off the axis. */
  toX(time: number): number | null;
  barSpacing(): number;
  /** Visible bar times [from, to]. */
  visible(): [number, number] | null;
  /** Per-output style overrides from the chart's settings. */
  styles(): Record<string, { visible?: boolean; color?: string; width?: number }> | undefined;
}

const ScriptRender = (() => {
  /** Index of the first bar at or after time t. */
  function lowerBound(bars: ChartBar[], t: number): number {
    let lo = 0, hi = bars.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].time < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** The bar index at exactly time t, or -1. */
  function indexAt(bars: ChartBar[], t: number): number {
    const i = lowerBound(bars, t);
    return i < bars.length && bars[i].time === t ? i : -1;
  }

  function shown(o: PineOutput, styles: Record<string, { visible?: boolean }> | undefined): boolean {
    const ov = styles?.[o.key];
    if (ov && ov.visible === false) return false;
    if (ov && ov.visible === true) return true;
    return (o.display & 1) !== 0;
  }

  /** A bar's colour after the user's override (na stays na). */
  function colorAt(o: PineOutput, i: number, styles: Record<string, any> | undefined): string | null {
    const c = o.colors[i];
    if (c == null) return null;
    const ov = styles?.[o.key]?.color;
    return ov || c;
  }

  /** Values of a fill's side: a plot's series, or an hline's price. */
  function sideValues(res: PineRunResult, key: string, n: number): Float64Array | null {
    const o = res.outputs.find((x) => x.key === key);
    if (!o) return null;
    if (o.kind === 'hline') return new Float64Array(n).fill(o.price ?? NaN);
    return o.values;
  }

  function dash(ctx: CanvasRenderingContext2D, style: string | undefined, w: number): void {
    if (style === 'dotted') ctx.setLineDash([w, w * 2]);
    else if (style === 'dashed') ctx.setLineDash([w * 4, w * 3]);
    else ctx.setLineDash([]);
  }

  /** Visible bar index range (padded by one each side so edges join up). */
  function visibleRange(host: ScriptPaneHost, bars: ChartBar[]): [number, number] | null {
    const v = host.visible();
    if (!v || !bars.length) return null;
    const a = Math.max(0, lowerBound(bars, v[0]) - 1);
    const b = Math.min(bars.length - 1, lowerBound(bars, v[1]) + 1);
    return a <= b ? [a, b] : null;
  }

  function drawBackground(ctx: CanvasRenderingContext2D, host: ScriptPaneHost, height: number): void {
    const res = host.result(), bars = host.bars();
    const range = res && visibleRange(host, bars);
    if (!res || !range) return;
    const styles = host.styles();
    const w = Math.max(1, host.barSpacing());
    for (const o of res.outputs) {
      if (o.kind !== 'bg' || !shown(o, styles)) continue;
      for (let i = range[0]; i <= range[1]; i++) {
        const c = colorAt(o, i, styles);
        if (!c) continue;
        const x = host.toX(bars[i].time);
        if (x == null) continue;
        ctx.fillStyle = c;
        ctx.fillRect(Math.round(x - w / 2), 0, Math.ceil(w), height);
      }
    }
  }

  function drawFills(ctx: CanvasRenderingContext2D, host: ScriptPaneHost): void {
    const res = host.result(), bars = host.bars(), s = host.series();
    const range = res && visibleRange(host, bars);
    if (!res || !range || !s) return;
    const styles = host.styles();
    for (const o of res.outputs) {
      if (o.kind !== 'fill' || !o.a || !o.b || !shown(o, styles)) continue;
      const A = sideValues(res, o.a, bars.length), B = sideValues(res, o.b, bars.length);
      if (!A || !B) continue;
      // One path per run of bars that share a colour, so there are no seams.
      let run: { color: string; top: [number, number][]; bot: [number, number][] } | null = null;
      const flush = () => {
        if (run && run.top.length > 1) {
          ctx.fillStyle = run.color;
          ctx.beginPath();
          run.top.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          for (let k = run.bot.length - 1; k >= 0; k--) ctx.lineTo(run.bot[k][0], run.bot[k][1]);
          ctx.closePath();
          ctx.fill();
        }
        run = null;
      };
      for (let i = range[0]; i <= range[1]; i++) {
        const a = A[i], b = B[i];
        const c = colorAt(o, i, styles);
        const x = host.toX(bars[i].time);
        const ya = isFinite(a) ? s.priceToCoordinate(a) : null, yb = isFinite(b) ? s.priceToCoordinate(b) : null;
        if (x == null || ya == null || yb == null || !c) { flush(); continue; }
        if (run && run.color !== c) {
          // Close this run at the current bar so the next one starts here.
          run.top.push([x, ya]);
          run.bot.push([x, yb]);
          flush();
        }
        if (!run) run = { color: c, top: [], bot: [] };
        run.top.push([x, ya]);
        run.bot.push([x, yb]);
      }
      flush();
    }
  }

  function drawHlines(ctx: CanvasRenderingContext2D, host: ScriptPaneHost, width: number): void {
    const res = host.result(), s = host.series();
    if (!res || !s) return;
    const styles = host.styles();
    for (const o of res.outputs) {
      if (o.kind !== 'hline' || !shown(o, styles) || !isFinite(o.price ?? NaN)) continue;
      const y = s.priceToCoordinate(o.price);
      if (y == null) continue;
      const ov = styles?.[o.key];
      const w = ov?.width || o.width || 1;
      ctx.strokeStyle = ov?.color || o.color || 'rgba(120,123,134,1)';
      ctx.lineWidth = w;
      dash(ctx, o.lineStyle, w);
      ctx.beginPath();
      const yy = Math.round(y) + (w % 2 ? 0.5 : 0);
      ctx.moveTo(0, yy);
      ctx.lineTo(width, yy);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /** Price range the fills and hlines need in view (for the pane's autoscale). */
  function autoscale(host: ScriptPaneHost): { priceRange: { minValue: number; maxValue: number } } | null {
    const res = host.result(), bars = host.bars();
    if (!res) return null;
    const styles = host.styles();
    let lo = Infinity, hi = -Infinity;
    const take = (v: number) => { if (isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } };
    const range = visibleRange(host, bars);
    for (const o of res.outputs) {
      if (!shown(o, styles)) continue;
      if (o.kind === 'hline') take(o.price ?? NaN);
      if (o.kind === 'fill' && o.a && o.b && range) {
        const A = sideValues(res, o.a, bars.length), B = sideValues(res, o.b, bars.length);
        if (!A || !B) continue;
        for (let i = range[0]; i <= range[1]; i++) {
          if (o.colors[i] == null) continue;
          take(A[i]);
          take(B[i]);
        }
      }
    }
    return isFinite(lo) ? { priceRange: { minValue: lo, maxValue: hi } } : null;
  }

  const MARKER_SIZE: Record<string, number> = { auto: 1, tiny: 0.6, small: 0.9, normal: 1.3, large: 1.8, huge: 2.6 };
  const SHAPE_MAP: Record<string, string> = {
    triangleup: 'arrowUp', arrowup: 'arrowUp', labelup: 'arrowUp',
    triangledown: 'arrowDown', arrowdown: 'arrowDown', labeldown: 'arrowDown',
    circle: 'circle', square: 'square', diamond: 'square', xcross: 'square', cross: 'square', flag: 'square',
  };

  /** lightweight-charts markers for a script's plotshape/plotchar/plotarrow output. */
  function markers(res: PineRunResult, bars: ChartBar[], styles: Record<string, any> | undefined): any[] {
    const out: any[] = [];
    for (const o of res.outputs) {
      if ((o.kind !== 'shape' && o.kind !== 'char' && o.kind !== 'arrow') || !shown(o, styles)) continue;
      for (let i = 0; i < bars.length; i++) {
        const v = o.values[i];
        if (!isFinite(v)) continue;
        const color = colorAt(o, i, styles);
        if (!color) continue;
        const time = bars[i].time;
        if (o.kind === 'arrow') {
          out.push({ time, position: v > 0 ? 'belowBar' : 'aboveBar', shape: v > 0 ? 'arrowUp' : 'arrowDown', color });
          continue;
        }
        const loc = o.location || 'abovebar';
        const m: any = {
          time, color,
          shape: o.kind === 'char' ? 'circle' : SHAPE_MAP[o.shape || 'xcross'] || 'circle',
          size: o.kind === 'char' ? 0.1 : MARKER_SIZE[o.size || 'auto'] || 1,
        };
        const text = o.kind === 'char' ? `${o.char || '★'}${o.text ? ` ${o.text}` : ''}` : o.text;
        if (text) m.text = text;
        if (loc === 'absolute') { m.position = 'atPriceMiddle'; m.price = v; }
        else m.position = loc === 'belowbar' || loc === 'bottom' ? 'belowBar' : 'aboveBar';
        out.push(m);
      }
    }
    return out.sort((a, b) => a.time - b.time);
  }

  /** The HTML for a script's table(s), as they stand after the last bar. */
  function tableHtml(t: PineTable): string {
    const esc = ChartWorkspace.esc;
    const size: Record<string, string> = { auto: '11px', tiny: '9px', small: '10px', normal: '12px', large: '15px', huge: '19px' };
    const style = [
      t.bg ? `background:${t.bg}` : '',
      t.frameWidth && t.frameColor ? `outline:${t.frameWidth}px solid ${t.frameColor}` : '',
    ].filter(Boolean).join(';');
    const border = t.borderWidth && t.borderColor ? `${t.borderWidth}px solid ${t.borderColor}` : '';
    const rows = t.cells.map((r) => {
      if (r.every((c) => !c)) return '';
      return `<tr>${r.map((c) => {
        if (!c) return '<td></td>';
        const css = [
          c.bg ? `background:${c.bg}` : '',
          c.textColor ? `color:${c.textColor}` : '',
          `font-size:${size[c.size] || '12px'}`,
          `text-align:${c.halign === 'left' ? 'left' : c.halign === 'right' ? 'right' : 'center'}`,
          border ? `border:${border}` : '',
        ].filter(Boolean).join(';');
        return `<td style="${esc(css)}"${c.tooltip ? ` title="${esc(c.tooltip)}"` : ''}>${esc(c.text).replace(/\n/g, '<br>')}</td>`;
      }).join('')}</tr>`;
    }).join('');
    return `<table class="cw-script-table" style="${esc(style)}">${rows}</table>`;
  }

  return { lowerBound, indexAt, shown, colorAt, drawBackground, drawFills, drawHlines, autoscale, markers, tableHtml };
})();

/** Paints a script's background colours, fills and hlines on its pane. */
class ScriptPanePrimitive {
  private requestUpdateFn: (() => void) | null = null;
  private readonly views: any[];

  constructor(private host: ScriptPaneHost) {
    this.views = [
      {
        zOrder: () => 'bottom',
        renderer: () => ({
          draw: (target: any) => target.useMediaCoordinateSpace(({ context, mediaSize }: any) => {
            ScriptRender.drawBackground(context, this.host, mediaSize.height);
            ScriptRender.drawFills(context, this.host);
          }),
        }),
      },
      {
        zOrder: () => 'normal',
        renderer: () => ({
          draw: (target: any) => target.useMediaCoordinateSpace(({ context, mediaSize }: any) => {
            ScriptRender.drawHlines(context, this.host, mediaSize.width);
          }),
        }),
      },
    ];
  }

  attached(p: { requestUpdate: () => void }): void { this.requestUpdateFn = p.requestUpdate; }
  detached(): void { this.requestUpdateFn = null; }
  update(): void { this.requestUpdateFn?.(); }
  updateAllViews(): void {}
  paneViews(): any[] { return this.views; }
}
