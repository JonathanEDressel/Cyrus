/**
 * PortfolioChart — a custom-SVG doughnut of holdings by USD value.
 *
 * Slices are sized by USD value; holdings under 3% of the total are grouped into
 * an "Other" slice (its breakdown is shown on hover). Each slice has a leader
 * line pointing to a label (asset + %), and the centre shows the total value.
 * No charting dependency — hand-drawn SVG to match the rest of the app.
 */
const PortfolioChart = (() => {
  const W = 420, H = 300;
  const CX = 210, CY = 150, R = 98, IR = 60;
  const PALETTE = ['#06b6d4', '#8b5cf6', '#22c55e', '#f59e0b', '#3b82f6',
                   '#ec4899', '#14b8a6', '#eab308', '#a78bfa', '#f97316'];
  const OTHER_COLOR = '#64748b';
  const OTHER_THRESHOLD = 0.03;

  interface Position { asset: string; amount: number; usd_value: number; }
  interface Slice { label: string; value: number; color: string; isOther: boolean; items: Position[]; }

  function esc(s: any): string {
    const d = document.createElement('div');
    d.textContent = String(s ?? '');
    return d.innerHTML;
  }

  function fmtUsd(n: number): string {
    if (n >= 1000) return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (n >= 1) return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }

  function pt(angleDeg: number, radius: number): [number, number] {
    const a = (angleDeg - 90) * Math.PI / 180;
    return [CX + radius * Math.cos(a), CY + radius * Math.sin(a)];
  }

  function slicePath(start: number, end: number): string {
    const [ox1, oy1] = pt(start, R);
    const [ox2, oy2] = pt(end, R);
    const [ix2, iy2] = pt(end, IR);
    const [ix1, iy1] = pt(start, IR);
    const large = (end - start) > 180 ? 1 : 0;
    return `M${ox1.toFixed(1)},${oy1.toFixed(1)} A${R},${R} 0 ${large} 1 ${ox2.toFixed(1)},${oy2.toFixed(1)}`
      + ` L${ix2.toFixed(1)},${iy2.toFixed(1)} A${IR},${IR} 0 ${large} 0 ${ix1.toFixed(1)},${iy1.toFixed(1)} Z`;
  }

  /** Collapse positions into slices, grouping sub-threshold holdings into "Other". */
  function buildSlices(positions: Position[], total: number): Slice[] {
    const big = positions.filter(p => p.usd_value / total >= OTHER_THRESHOLD);
    const small = positions.filter(p => p.usd_value / total < OTHER_THRESHOLD);

    const slices: Slice[] = big.map((p, i) => ({
      label: p.asset, value: p.usd_value, color: PALETTE[i % PALETTE.length],
      isOther: false, items: [p],
    }));

    if (small.length === 1) {
      const p = small[0];
      slices.push({ label: p.asset, value: p.usd_value, color: PALETTE[slices.length % PALETTE.length], isOther: false, items: [p] });
    } else if (small.length > 1) {
      const sum = small.reduce((s, p) => s + p.usd_value, 0);
      slices.push({ label: 'Other', value: sum, color: OTHER_COLOR, isOther: true, items: small });
    }
    return slices;
  }

  function tooltipHtml(slice: Slice, total: number): string {
    const pct = (slice.value / total * 100).toFixed(1);
    if (slice.isOther) {
      const rows = slice.items
        .sort((a, b) => b.usd_value - a.usd_value)
        .map(p => `<div class="pf-tip-row"><span>${esc(p.asset)}</span><span>${fmtUsd(p.usd_value)}</span></div>`)
        .join('');
      return `<div class="pf-tip-title">Other — ${fmtUsd(slice.value)} (${pct}%)</div>${rows}`;
    }
    const p = slice.items[0];
    return `<div class="pf-tip-title">${esc(slice.label)} — ${pct}%</div>`
      + `<div class="pf-tip-row"><span>Value</span><span>${fmtUsd(slice.value)}</span></div>`
      + `<div class="pf-tip-row"><span>Amount</span><span>${p.amount.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 })} ${esc(slice.label)}</span></div>`;
  }

  function attachTooltip(container: HTMLElement, slices: Slice[], total: number): void {
    let tip = document.getElementById('pf-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'pf-tooltip';
      tip.className = 'pf-tooltip d-none';
      document.body.appendChild(tip);
    }
    const tipEl = tip;
    const svg = container.querySelector('svg');
    if (!svg) return;

    svg.addEventListener('mousemove', (e) => {
      const el = (e.target as HTMLElement).closest('[data-slice]') as HTMLElement | null;
      if (!el) { tipEl.classList.add('d-none'); svg.querySelectorAll('.pf-slice').forEach(s => s.classList.remove('pf-dim')); return; }
      const idx = parseInt(el.getAttribute('data-slice') || '0', 10);
      svg.querySelectorAll<SVGElement>('.pf-slice').forEach((s, i) => s.classList.toggle('pf-dim', i !== idx));
      tipEl.innerHTML = tooltipHtml(slices[idx], total);
      tipEl.style.left = `${(e as MouseEvent).clientX + 14}px`;
      tipEl.style.top = `${(e as MouseEvent).clientY + 14}px`;
      tipEl.classList.remove('d-none');
    });
    svg.addEventListener('mouseleave', () => {
      tipEl.classList.add('d-none');
      svg.querySelectorAll('.pf-slice').forEach(s => s.classList.remove('pf-dim'));
    });
  }

  function render(container: HTMLElement, positions: Position[], total: number): void {
    if (!container) return;
    container.classList.add('pf-chart');

    if (!positions || positions.length === 0 || total <= 0) {
      container.innerHTML = '<div class="pf-empty"><i class="fa-solid fa-chart-pie"></i><p>No holdings to show yet.</p></div>';
      return;
    }

    const slices = buildSlices(positions, total);

    // Assign evenly-spaced label rows per side to avoid overlap.
    const sides: Record<'l' | 'r', Array<{ i: number; midY: number }>> = { l: [], r: [] };
    let acc = 0;
    const sliceAngles = slices.map((s) => {
      const start = acc / total * 360;
      acc += s.value;
      const end = acc / total * 360;
      const mid = (start + end) / 2;
      const [mx] = pt(mid, R);
      (mx >= CX ? sides.r : sides.l).push({ i: slices.indexOf(s), midY: pt(mid, R)[1] });
      return { start, end, mid };
    });
    const labelY: number[] = new Array(slices.length).fill(0);
    (['l', 'r'] as const).forEach((side) => {
      const arr = sides[side].sort((a, b) => a.midY - b.midY);
      const pad = 22, span = H - pad * 2;
      arr.forEach((entry, k) => {
        labelY[entry.i] = arr.length === 1 ? entry.midY : pad + (k * span) / (arr.length - 1);
      });
    });

    const arcs: string[] = [];
    const leaders: string[] = [];
    slices.forEach((s, i) => {
      const { start, end, mid } = sliceAngles[i];
      arcs.push(`<path class="pf-slice" data-slice="${i}" d="${slicePath(start, end)}" fill="${s.color}"></path>`);

      const [p1x, p1y] = pt(mid, R + 2);
      const [p2x, p2y] = pt(mid, R + 14);
      const right = p2x >= CX;
      const lx = right ? W - 10 : 10;
      const elbowX = right ? lx - 4 : lx + 4;
      const ly = labelY[i];
      const pct = (s.value / total * 100).toFixed(0);
      leaders.push(
        `<polyline class="pf-leader" points="${p1x.toFixed(1)},${p1y.toFixed(1)} ${p2x.toFixed(1)},${p2y.toFixed(1)} ${elbowX},${ly} ${lx},${ly}" fill="none"></polyline>`
        + `<circle cx="${p1x.toFixed(1)}" cy="${p1y.toFixed(1)}" r="2.2" fill="${s.color}"></circle>`
        + `<text class="pf-label" x="${right ? lx : lx}" y="${ly - 4}" text-anchor="${right ? 'end' : 'start'}">`
        + `<tspan class="pf-label-asset" fill="${s.color}">${esc(s.label)}</tspan> <tspan class="pf-label-pct">${pct}%</tspan></text>`
      );
    });

    container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="pf-svg" preserveAspectRatio="xMidYMid meet">
      ${arcs.join('')}
      ${leaders.join('')}
      <text class="pf-center-value" x="${CX}" y="${CY - 2}" text-anchor="middle">${fmtUsd(total)}</text>
      <text class="pf-center-label" x="${CX}" y="${CY + 16}" text-anchor="middle">Total Value</text>
    </svg>`;

    attachTooltip(container, slices, total);
  }

  return { render };
})();
