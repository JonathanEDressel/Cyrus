/**
 * AllocationChart — the editable bar chart behind the Balancer page.
 *
 * One column per holding (x axis), y axis is percent of portfolio. The solid
 * bar is what the position is worth right now; the draggable handle above it is
 * the maximum percent the user is willing to let it reach, and the dashed line
 * below the handle is where a rebalance lands it.
 *
 * Hand-drawn SVG, no charting dependency — same approach as PortfolioChart.
 *
 * Drag behaviour: while a handle is being dragged the chart mutates its own
 * geometry in place and reports every move through ``onCapChange`` (so the table
 * inputs track the drag). Re-rendering mid-drag would destroy the node under the
 * pointer, so the page only re-renders on ``onCapCommit`` (pointer release).
 */
const AllocationChart = (() => {
  const PAD_L = 44;
  const PAD_R = 14;
  const PAD_T = 16;
  const PLOT_H = 240;
  const LABEL_H = 52;
  const H = PAD_T + PLOT_H + LABEL_H;
  const COL_W = 74;
  const BAR_W = 34;
  const HANDLE_H = 12;
  const MIN_CAP = 0.5;

  interface Bar {
    asset: string;
    weight: number;              // current % of portfolio
    cap: number | null;          // configured maximum %, null = uncapped
    target: number | null;       // rebalance-down-to %
    enabled: boolean;
    held: boolean;
    convertTo?: string | null;
  }

  interface Options {
    axisMax?: number;                                    // default 100
    onCapChange?: (asset: string, pct: number) => void;  // live, during drag
    onCapCommit?: (asset: string, pct: number) => void;  // on release
  }

  function esc(s: any): string {
    const d = document.createElement('div');
    d.textContent = String(s ?? '');
    return d.innerHTML;
  }

  function escAttr(s: any): string {
    return esc(s).replace(/"/g, '&quot;');
  }

  function fmtPct(n: number): string {
    return `${Number(n.toFixed(1))}%`;
  }

  /** Round to the nearest half percent — fine enough to aim, coarse enough to hit. */
  function snap(pct: number): number {
    return Math.round(pct * 2) / 2;
  }

  /** A "nice" axis maximum that keeps small positions readable. */
  function fitAxisMax(bars: Bar[]): number {
    let peak = 0;
    for (const b of bars) {
      peak = Math.max(peak, b.weight, b.cap ?? 0);
    }
    const padded = Math.ceil((peak * 1.3) / 10) * 10;
    return Math.max(20, Math.min(100, padded || 20));
  }

  function render(container: HTMLElement, bars: Bar[], opts: Options = {}): void {
    if (!container) return;
    container.classList.add('ac-chart');

    if (!bars || bars.length === 0) {
      container.innerHTML = '<div class="ac-empty"><i class="fa-solid fa-chart-simple"></i>'
        + '<p>No priced holdings on this connection yet.</p></div>';
      return;
    }

    const axisMax = opts.axisMax && opts.axisMax > 0 ? opts.axisMax : 100;
    const W = PAD_L + bars.length * COL_W + PAD_R;
    const y = (pct: number) => PAD_T + PLOT_H * (1 - Math.min(pct, axisMax) / axisMax);
    const colX = (i: number) => PAD_L + i * COL_W;

    // Gridlines: label every other line so dense axes stay legible.
    const step = axisMax <= 25 ? 5 : 10;
    const grid: string[] = [];
    for (let pct = 0; pct <= axisMax + 0.001; pct += step) {
      const gy = y(pct).toFixed(1);
      grid.push(`<line class="ac-grid" x1="${PAD_L - 6}" y1="${gy}" x2="${W - PAD_R}" y2="${gy}"></line>`);
      grid.push(`<text class="ac-axis-label" x="${PAD_L - 10}" y="${gy}" text-anchor="end" dominant-baseline="middle">${pct}%</text>`);
    }

    const cols: string[] = [];
    bars.forEach((b, i) => {
      const x = colX(i);
      const barX = x + (COL_W - BAR_W) / 2;
      const barTop = y(b.weight);
      const barH = Math.max(1, PAD_T + PLOT_H - barTop);
      const capped = b.cap != null;
      const over = capped && b.weight >= (b.cap as number);
      const barClass = ['ac-bar'];
      if (over && b.enabled) barClass.push('ac-bar-over');
      if (!b.held) barClass.push('ac-bar-empty');

      cols.push(
        `<g class="ac-col" data-asset="${escAttr(b.asset)}">`
        + `<rect class="ac-track" x="${x + 4}" y="${PAD_T}" width="${COL_W - 8}" height="${PLOT_H}" rx="4"></rect>`
        + `<rect class="${barClass.join(' ')}" data-bar="${escAttr(b.asset)}" x="${barX}" y="${barTop.toFixed(1)}" width="${BAR_W}" height="${barH.toFixed(1)}" rx="3"></rect>`
      );

      if (capped) {
        const cap = b.cap as number;
        const capY = y(cap);
        const targetY = b.target != null ? y(b.target) : null;
        const groupClass = b.enabled ? 'ac-cap' : 'ac-cap ac-cap-paused';

        if (targetY != null) {
          cols.push(
            `<line class="ac-target-line" data-target="${escAttr(b.asset)}" x1="${x + 6}" y1="${targetY.toFixed(1)}" x2="${x + COL_W - 6}" y2="${targetY.toFixed(1)}"></line>`
          );
        }

        cols.push(
          `<g class="${groupClass}" data-cap="${escAttr(b.asset)}">`
          + `<line class="ac-cap-line" x1="${x + 4}" y1="${capY.toFixed(1)}" x2="${x + COL_W - 4}" y2="${capY.toFixed(1)}"></line>`
          + `<rect class="ac-handle" data-handle="${escAttr(b.asset)}" tabindex="0" role="slider"`
          + ` aria-label="Maximum allocation for ${escAttr(b.asset)}"`
          + ` aria-valuemin="0" aria-valuemax="100" aria-valuenow="${cap}"`
          + ` x="${x + 8}" y="${(capY - HANDLE_H / 2).toFixed(1)}" width="${COL_W - 16}" height="${HANDLE_H}" rx="4"></rect>`
          + `<text class="ac-cap-label" data-caplabel="${escAttr(b.asset)}" x="${x + COL_W / 2}" y="${(capY - HANDLE_H).toFixed(1)}" text-anchor="middle">${fmtPct(cap)}</text>`
          + `</g>`
        );
      }

      // x-axis labels: ticker, current weight, and the destination asset.
      const labelY = PAD_T + PLOT_H + 18;
      cols.push(
        `<text class="ac-asset-label${b.held ? '' : ' ac-asset-label-empty'}" x="${x + COL_W / 2}" y="${labelY}" text-anchor="middle">${esc(b.asset)}</text>`
        + `<text class="ac-weight-label" x="${x + COL_W / 2}" y="${labelY + 15}" text-anchor="middle">${fmtPct(b.weight)}</text>`
        + (b.convertTo
          ? `<text class="ac-dest-label" x="${x + COL_W / 2}" y="${labelY + 29}" text-anchor="middle">→ ${esc(b.convertTo)}</text>`
          : '')
        + `</g>`
      );
    });

    container.innerHTML = `<svg class="ac-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
        aria-label="Portfolio allocation caps by holding">
      <line class="ac-axis" x1="${PAD_L - 6}" y1="${PAD_T + PLOT_H}" x2="${W - PAD_R}" y2="${PAD_T + PLOT_H}"></line>
      ${grid.join('')}
      ${cols.join('')}
    </svg>`;

    attachDrag(container, bars, axisMax, opts);
  }

  /** Move one cap's line/handle/label without re-rendering the whole chart. */
  function applyCapVisual(container: HTMLElement, asset: string, pct: number,
                          axisMax: number, weight: number): void {
    const y = (p: number) => PAD_T + PLOT_H * (1 - Math.min(p, axisMax) / axisMax);
    const capY = y(pct);
    const line = container.querySelector<SVGLineElement>(`[data-cap="${CSS.escape(asset)}"] .ac-cap-line`);
    const handle = container.querySelector<SVGRectElement>(`[data-handle="${CSS.escape(asset)}"]`);
    const label = container.querySelector<SVGTextElement>(`[data-caplabel="${CSS.escape(asset)}"]`);
    const bar = container.querySelector<SVGRectElement>(`[data-bar="${CSS.escape(asset)}"]`);

    if (line) {
      line.setAttribute('y1', capY.toFixed(1));
      line.setAttribute('y2', capY.toFixed(1));
    }
    if (handle) {
      handle.setAttribute('y', (capY - HANDLE_H / 2).toFixed(1));
      handle.setAttribute('aria-valuenow', String(pct));
    }
    if (label) {
      label.setAttribute('y', (capY - HANDLE_H).toFixed(1));
      label.textContent = fmtPct(pct);
    }
    if (bar) bar.classList.toggle('ac-bar-over', weight >= pct);
  }

  function attachDrag(container: HTMLElement, bars: Bar[], axisMax: number, opts: Options): void {
    const svg = container.querySelector('svg');
    if (!svg) return;

    const byAsset = new Map(bars.map(b => [b.asset, b]));

    /** Pointer y → percent, using the rendered (not viewBox) geometry. */
    function pctFromClientY(clientY: number): number {
      const rect = svg!.getBoundingClientRect();
      const scale = rect.height / H;
      const plotTop = rect.top + PAD_T * scale;
      const plotBottom = plotTop + PLOT_H * scale;
      const frac = (plotBottom - clientY) / (plotBottom - plotTop);
      return Math.max(MIN_CAP, Math.min(axisMax, snap(frac * axisMax)));
    }

    svg.addEventListener('pointerdown', (e: Event) => {
      const target = e.target as Element;
      const handle = target.closest('[data-handle]') as SVGRectElement | null;
      if (!handle) return;
      const asset = handle.getAttribute('data-handle') || '';
      const bar = byAsset.get(asset);
      if (!bar) return;

      const pe = e as PointerEvent;
      pe.preventDefault();
      handle.classList.add('ac-handle-active');
      container.classList.add('ac-dragging');

      let latest = bar.cap ?? 0;

      const move = (ev: PointerEvent) => {
        latest = pctFromClientY(ev.clientY);
        applyCapVisual(container, asset, latest, axisMax, bar.weight);
        opts.onCapChange?.(asset, latest);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        handle.classList.remove('ac-handle-active');
        container.classList.remove('ac-dragging');
        opts.onCapCommit?.(asset, latest);
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });

    // Keyboard equivalent — a handle you can only reach with a mouse is a handle
    // half the users can't reach.
    svg.addEventListener('keydown', (e: Event) => {
      const ke = e as KeyboardEvent;
      const handle = (ke.target as Element)?.closest('[data-handle]') as SVGRectElement | null;
      if (!handle) return;
      const asset = handle.getAttribute('data-handle') || '';
      const bar = byAsset.get(asset);
      if (!bar || bar.cap == null) return;

      const stepSize = ke.shiftKey ? 5 : 1;
      let next: number | null = null;
      if (ke.key === 'ArrowUp' || ke.key === 'ArrowRight') next = bar.cap + stepSize;
      else if (ke.key === 'ArrowDown' || ke.key === 'ArrowLeft') next = bar.cap - stepSize;
      else if (ke.key === 'Home') next = axisMax;
      else if (ke.key === 'End') next = MIN_CAP;
      if (next == null) return;

      ke.preventDefault();
      const pct = Math.max(MIN_CAP, Math.min(axisMax, snap(next)));
      bar.cap = pct;
      applyCapVisual(container, asset, pct, axisMax, bar.weight);
      opts.onCapChange?.(asset, pct);
    });
  }

  return { render, fitAxisMax };
})();
