/**
 * FlowMap — the left-to-right flow map shared by the Automations chart
 * (RuleFlow) and the Open Orders chart (OrderFlow).
 *
 * It knows nothing about rules or orders. Each chart turns its records into
 * FlowItems: one line from a place (a coin, or a withdrawal address) to
 * another, with a chip saying what moves it. Columns read left to right: the
 * places money leaves from, a chip per item, anything it passes through, and
 * where it ends up. Clicking a chip lights up that item's path and shows the
 * chart's details strip for it underneath.
 *
 * Zoom: the − / % / + buttons above the map, or Ctrl/⌘ + scroll (a trackpad
 * pinch). Each chart keeps its own level on this machine, keyed by the
 * container's id (localStorage `cyrus_flow_zoom_<id>`).
 *
 * Panning: the map sits in a viewport (capped to the screen on full pages)
 * that can be dragged in any direction with the mouse. A drag that starts on
 * a chip pans instead of selecting it; a plain click still selects.
 *
 * Styles: styles/ruleflow.css (rf-* classes). An item's `tone` picks its
 * colour through an `rf-k-<tone>` class there.
 */
interface FlowPlace {
  key: string;                   // unique within the group, e.g. 'A:BTC' or 'W:cold_storage'
  label: string;
  kind: 'asset' | 'wallet';
}

interface FlowItem {
  id: string;
  group: string;                 // items are laid out per group (an exchange)
  src: FlowPlace;
  dst: FlowPlace;
  tone: string;                  // colour: rf-k-<tone>
  dashed?: boolean;              // drawn dashed with a muted chip (e.g. a paused rule)
  chipTag: string;               // the short coloured word on the chip
  chipText: string;
  title: string;                 // the chip's native tooltip
  data: any;                     // the record it came from
}

interface FlowMapConfig {
  emptyText: string;
  /** Singular and plural for "2 rules" under a place that sends. */
  noun: [string, string];
  groupName?: (group: string) => string;
  /** Overrides the small line under a place's name; null keeps the default. */
  placeSub?: (role: 'source' | 'mid' | 'terminal' | 'wallet', inItems: FlowItem[], outItems: FlowItem[]) => string | null;
  /** The details strip's HTML for the selected item. */
  detailHtml: (item: FlowItem, ctx: { multiGroup: boolean; groupName: string }) => string;
  /** A [data-rf-action] button in the details strip was clicked. */
  onAction?: (action: string, item: FlowItem) => void;
}

const FlowMap = (() => {
  interface FlowNode {
    key: string;                 // '<group>|<place key>'
    label: string;
    kind: 'asset' | 'wallet';
    depth: number;
    out: FlowItem[];
    inItems: FlowItem[];
    col: number;
    x: number; y: number; w: number; h: number; cy: number;
  }
  interface FlowEdge { from: string; to: string; item: FlowItem; }

  // Geometry, in CSS px.
  const NODE_W = 150;
  const NODE_H = 48;
  const TERM_W = 170;
  const CHIP_W = 172;
  const CHIP_H = 28;
  const CHIP_STEP = 34;
  const CHIP_GAP = 18;     // node → its chips
  const MIN_EDGE = 46;     // shortest run from a chip to the next column
  const MAX_STEP = 560;    // widest column spacing before the map stops stretching
  const ROW_GAP = 22;
  const PAD_X = 12;
  const PAD_Y = 14;

  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 2;
  const ZOOM_STEP = 0.1;

  function esc(str: any): string {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  }
  function escAttr(str: any): string {
    return esc(str).replace(/"/g, '&quot;');
  }

  const srcKey = (it: FlowItem) => `${it.group}|${it.src.key}`;
  const dstKey = (it: FlowItem) => `${it.group}|${it.dst.key}`;

  // ── Per-container state ─────────────────────────────────────────────────
  //
  // The container outlives its innerHTML (pages re-render it whenever their
  // data reloads), so listeners are wired once and read the latest render here.

  interface ChartState {
    items: FlowItem[];
    config: FlowMapConfig;
    byId: Map<string, FlowItem>;
    selected: string | null;
    width: number;
    multiGroup: boolean;
    zoom: number;
  }
  const states = new WeakMap<HTMLElement, ChartState>();

  // ── Zoom ────────────────────────────────────────────────────────────────

  const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
  const zoomKey = (container: HTMLElement) => container.id ? `cyrus_flow_zoom_${container.id}` : '';

  function loadZoom(container: HTMLElement): number {
    const key = zoomKey(container);
    try {
      const z = key ? Number(localStorage.getItem(key)) : NaN;
      return z > 0 ? clampZoom(z) : 1;
    } catch {
      return 1;
    }
  }

  function saveZoom(container: HTMLElement, z: number): void {
    const key = zoomKey(container);
    if (!key) return;
    try {
      if (z === 1) localStorage.removeItem(key);
      else localStorage.setItem(key, String(z));
    } catch {
      // Storage unavailable: the zoom still applies, it just isn't remembered.
    }
  }

  function setZoom(container: HTMLElement, z: number): void {
    const st = states.get(container);
    if (!st) return;
    z = clampZoom(z);
    if (z === st.zoom) return;
    // Keep the viewport centred on the same spot.
    const before = container.querySelector<HTMLElement>('.rf-viewport');
    const rx = before && before.scrollWidth > before.clientWidth
      ? (before.scrollLeft + before.clientWidth / 2) / before.scrollWidth : 0;
    const ry = before && before.scrollHeight > before.clientHeight
      ? (before.scrollTop + before.clientHeight / 2) / before.scrollHeight : 0;
    st.zoom = z;
    saveZoom(container, z);
    render(container, st.items, st.config);
    const vp = container.querySelector<HTMLElement>('.rf-viewport');
    if (vp) {
      vp.scrollLeft = rx ? rx * vp.scrollWidth - vp.clientWidth / 2 : 0;
      vp.scrollTop = ry ? ry * vp.scrollHeight - vp.clientHeight / 2 : 0;
    }
  }

  function toolbarHtml(zoom: number): string {
    const mod = (window as any).cyrus?.platform === 'darwin' ? '⌘' : 'Ctrl';
    const pct = Math.round(zoom * 100);
    return `<div class="rf-toolbar"><div class="rf-zoom" role="group" aria-label="Zoom">`
      + `<button type="button" data-rf-zoom="out" title="Zoom out (${mod} + scroll)" aria-label="Zoom out"${zoom <= ZOOM_MIN ? ' disabled' : ''}><i class="fa-solid fa-minus" aria-hidden="true"></i></button>`
      + `<button type="button" class="rf-zoom-level" data-rf-zoom="reset" title="Reset to 100%" aria-label="Zoom ${pct}%, reset to 100%">${pct}%</button>`
      + `<button type="button" data-rf-zoom="in" title="Zoom in (${mod} + scroll)" aria-label="Zoom in"${zoom >= ZOOM_MAX ? ' disabled' : ''}><i class="fa-solid fa-plus" aria-hidden="true"></i></button>`
      + `</div></div>`;
  }

  /** The viewport always keeps room for its vertical scrollbar; measured once. */
  let gutter: number | null = null;

  function availableWidth(container: HTMLElement): number {
    return container.offsetParent === null ? 0 : Math.max(0, container.clientWidth - (gutter ?? 0));
  }

  /** What a vertical drag should scroll when the viewport itself can't. */
  function verticalScroller(from: HTMLElement): HTMLElement {
    for (let el = from.parentElement; el; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el;
    }
    return (document.scrollingElement as HTMLElement) || document.documentElement;
  }

  // ── Layout ──────────────────────────────────────────────────────────────

  function layoutComponent(compKeys: string[], nodes: Map<string, FlowNode>, edges: FlowEdge[],
                           width: number, config: FlowMapConfig, zoom: number): string {
    const inComp = new Set(compKeys);
    const compEdges = edges.filter(e => inComp.has(e.from) && inComp.has(e.to));
    const list = compKeys.map(k => nodes.get(k)!);

    // Lines can form a loop (USDT into BTC, BTC back into USDT). Columns need
    // a one-way order, so find the lines that close a loop — a depth-first
    // walk from the places nothing flows into — and draw those as return
    // lines underneath instead.
    const back = new Set<FlowEdge>();
    const visitState = new Map<string, number>(); // 1 = on the current path, 2 = done
    const visit = (k: string): void => {
      visitState.set(k, 1);
      for (const e of compEdges) {
        if (e.from !== k) continue;
        const st = visitState.get(e.to) || 0;
        if (st === 1) back.add(e);
        else if (st === 0) visit(e.to);
      }
      visitState.set(k, 2);
    };
    [...list].sort((a, b) => a.inItems.length - b.inItems.length)
      .forEach(n => { if (!visitState.get(n.key)) visit(n.key); });
    const dag = compEdges.filter(e => !back.has(e));

    // Longest-path depth over the one-way lines.
    list.forEach(n => { n.depth = 0; });
    for (let i = 0; i < list.length; i++) {
      let changed = false;
      for (const e of dag) {
        const f = nodes.get(e.from)!, t = nodes.get(e.to)!;
        if (t.depth < f.depth + 1) { t.depth = f.depth + 1; changed = true; }
      }
      if (!changed) break;
    }
    // Everything with nowhere further to go lines up in the last column.
    const last = Math.max(1, ...list.map(n => n.depth));
    const endsHere = (n: FlowNode) => !dag.some(e => e.from === n.key);
    list.forEach(n => { n.col = endsHere(n) ? last : Math.min(n.depth, last - 1); });

    const cols: FlowNode[][] = Array.from({ length: last + 1 }, () => []);
    list.forEach(n => cols[n.col].push(n));

    // Order each column to keep lines from crossing: a couple of barycentre
    // sweeps, each node sorted by the average position of what it connects to.
    const pos = new Map<string, number>();
    const refresh = () => cols.forEach(c => c.forEach((n, i) => pos.set(n.key, c.length > 1 ? i / (c.length - 1) : 0.5)));
    const targetsOf = (n: FlowNode) => dag.filter(e => e.from === n.key).map(e => e.to);
    const sourcesOf = (n: FlowNode) => dag.filter(e => e.to === n.key).map(e => e.from);
    const mean = (keys: string[], fallback: number) =>
      keys.length ? keys.reduce((s, k) => s + (pos.get(k) ?? 0.5), 0) / keys.length : fallback;
    cols[last].sort((a, b) => b.inItems.length - a.inItems.length);
    refresh();
    for (let pass = 0; pass < 2; pass++) {
      for (let c = last - 1; c >= 0; c--) {
        cols[c].sort((a, b) => mean(targetsOf(a), pos.get(a.key)!) - mean(targetsOf(b), pos.get(b.key)!));
        refresh();
      }
      for (let c = 1; c <= last; c++) {
        cols[c].sort((a, b) => mean(sourcesOf(a), pos.get(a.key)!) - mean(sourcesOf(b), pos.get(b.key)!));
        refresh();
      }
    }

    // Sizes: a node is as tall as its incoming entry points need; its block
    // also has room for its stack of chips.
    const chipsH = (n: FlowNode) => (n.out.length ? n.out.length * CHIP_STEP - (CHIP_STEP - CHIP_H) : 0);
    const blockH = new Map<string, number>();
    list.forEach(n => {
      n.w = n.col === last && n.out.length === 0 ? TERM_W : NODE_W;
      n.h = Math.max(NODE_H, n.inItems.length > 1 ? n.inItems.length * 22 + 18 : NODE_H);
      blockH.set(n.key, Math.max(n.h, chipsH(n)));
    });

    // Horizontal: stretch to the container, within reason; scroll if it's narrow.
    // (A last-column place that also sends — the start of a return line —
    // needs room for its chips.)
    const tailW = cols[last].some(n => n.out.length) ? NODE_W + CHIP_GAP + CHIP_W + 24 : TERM_W;
    const minStep = NODE_W + CHIP_GAP + CHIP_W + MIN_EDGE;
    const needed = PAD_X * 2 + last * minStep + tailW;
    const step = Math.min(MAX_STEP, Math.max(minStep, (Math.max(width, needed) - PAD_X * 2 - tailW) / last));
    const used = PAD_X * 2 + last * step + tailW;
    // Fill the container; when the columns hit MAX_STEP, centre the map in it.
    const W = Math.max(width, used);
    const offsetX = (W - used) / 2;

    // Vertical: stack each column's blocks and centre the columns on each other.
    const colHeight = cols.map(c => c.reduce((s, n) => s + blockH.get(n.key)!, 0) + Math.max(0, c.length - 1) * ROW_GAP);
    const innerH = Math.max(...colHeight);
    // Return lines run in lanes under the map.
    const laneTop = innerH + PAD_Y * 2 + 6;
    const H = innerH + PAD_Y * 2 + (back.size ? 16 + back.size * 10 : 0);
    cols.forEach((c, ci) => {
      let y = PAD_Y + (innerH - colHeight[ci]) / 2;
      c.forEach(n => {
        const bh = blockH.get(n.key)!;
        n.x = offsetX + PAD_X + ci * step;
        n.cy = y + bh / 2;
        n.y = n.cy - n.h / 2;
        y += bh + ROW_GAP;
      });
    });

    // Chips: stacked beside their source, ordered by where each one is headed.
    interface ChipPos { x: number; cy: number; }
    const chipOf = new Map<FlowItem, ChipPos>();
    list.forEach(n => {
      const outs = compEdges.filter(e => e.from === n.key)
        .sort((a, b) => nodes.get(a.to)!.cy - nodes.get(b.to)!.cy);
      const top = n.cy - chipsH(n) / 2 + CHIP_H / 2;
      outs.forEach((e, i) => chipOf.set(e.item, { x: n.x + n.w + CHIP_GAP, cy: top + i * CHIP_STEP }));
    });

    // Entry points: each arriving line gets its own spot down the node's left edge.
    const entryOf = new Map<FlowItem, number>();
    list.forEach(n => {
      const ins = compEdges.filter(e => e.to === n.key)
        .sort((a, b) => (chipOf.get(a.item)?.cy ?? 0) - (chipOf.get(b.item)?.cy ?? 0));
      ins.forEach((e, i) => {
        entryOf.set(e.item, ins.length === 1 ? n.cy
          : n.y + 14 + (i * (n.h - 28)) / (ins.length - 1));
      });
    });

    /** Continue a path through these corners, rounding each one. */
    const roundedTail = (pts: Array<[number, number]>, radius: number): string => {
      let d = '';
      for (let i = 1; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i - 1], [cx, cy] = pts[i], [bx, by] = pts[i + 1];
        const d1 = Math.hypot(cx - ax, cy - ay), d2 = Math.hypot(bx - cx, by - cy);
        const r = Math.min(radius, d1 / 2, d2 / 2);
        const sx = cx - ((cx - ax) / d1) * r, sy = cy - ((cy - ay) / d1) * r;
        const ex = cx + ((bx - cx) / d2) * r, ey = cy + ((by - cy) / d2) * r;
        d += ` L${sx.toFixed(1)},${sy.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`;
      }
      const [lx, ly] = pts[pts.length - 1];
      return d + ` L${lx.toFixed(1)},${ly.toFixed(1)}`;
    };

    const curve = (x1: number, y1: number, x2: number, y2: number): string => {
      const dx = Math.max(8, Math.abs(x2 - x1) * 0.5);
      return `C${(x1 + dx).toFixed(1)},${y1.toFixed(1)} ${(x2 - dx).toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
    };

    // A line that skips a column (BTC straight to USDC, past ETH) must not run
    // through what's in that column: find it a gap there, and spread lines
    // sharing a gap a few px apart.
    const colLeft = (c: number) => offsetX + PAD_X + c * step;
    const obstacles: Array<Array<[number, number]>> = cols.map(c => c.map(n => {
      const bh = blockH.get(n.key)!;
      return [n.cy - bh / 2 - 8, n.cy + bh / 2 + 8] as [number, number];
    }));
    const usedY: number[][] = cols.map(() => []);
    const routeY = (c: number, want: number): number => {
      let y = want;
      for (let guard = 0; guard < 8; guard++) {
        const hit = obstacles[c].find(([a, b]) => y > a && y < b);
        if (!hit) break;
        y = (y - hit[0] < hit[1] - y) ? hit[0] : hit[1];
      }
      const away = y <= want ? -6 : 6;
      for (let guard = 0; guard < 20 && usedY[c].some(u => Math.abs(u - y) < 5); guard++) y += away;
      usedY[c].push(y);
      return y;
    };

    const paths: string[] = [];
    const ports: string[] = [];
    const chips: string[] = [];
    let lane = 0;
    for (const e of compEdges) {
      const src = nodes.get(e.from)!;
      const dst = nodes.get(e.to)!;
      const chip = chipOf.get(e.item)!;
      const ey = entryOf.get(e.item) ?? dst.cy;
      const it = e.item;
      const tone = escAttr(it.tone);
      const id = escAttr(it.id);
      const sx = src.x + src.w;
      const cx2 = chip.x + CHIP_W;
      let d = `M${sx},${src.cy.toFixed(1)} ${curve(sx, src.cy, chip.x, chip.cy)} L${cx2.toFixed(1)},${chip.cy.toFixed(1)}`;
      if (back.has(e)) {
        // A return line: out to the right, down under the map, back along a
        // lane of its own, and up into the destination from its left.
        const ly = laneTop + lane++ * 10;
        const xr = cx2 + 16 + lane * 4;
        const xl = dst.x - 14 - lane * 4;
        d += roundedTail([[cx2, chip.cy], [xr, chip.cy], [xr, ly], [xl, ly], [xl, ey], [dst.x, ey]], 10);
      }
      // Waypoints: across each skipped column at a clear height, then in.
      const pts: Array<[number, number]> = [[cx2, chip.cy]];
      for (let c = src.col + 1; c < dst.col; c++) {
        const x0 = colLeft(c) - 12;
        const x1 = colLeft(c) + NODE_W + CHIP_GAP + CHIP_W + 12;
        const frac = ((x0 + x1) / 2 - cx2) / Math.max(1, dst.x - cx2);
        const y = routeY(c, chip.cy + (ey - chip.cy) * frac);
        pts.push([x0, y], [x1, y]);
      }
      pts.push([dst.x, ey]);
      for (let i = 1; i < pts.length && !back.has(e); i++) {
        const [px, py] = pts[i - 1];
        const [qx, qy] = pts[i];
        d += Math.abs(py - qy) < 0.5 && i % 2 === 0
          ? ` L${qx.toFixed(1)},${qy.toFixed(1)}`   // straight across a skipped column
          : ` ${curve(px, py, qx, qy)}`;
      }
      paths.push(`<path class="rf-edge rf-k-${tone}${it.dashed ? ' rf-edge-paused' : ''}" data-item="${id}" d="${d}"></path>`);
      ports.push(`<circle class="rf-port rf-k-${tone}" data-item="${id}" cx="${dst.x}" cy="${ey.toFixed(1)}" r="3.5"></circle>`);
      chips.push(`<button type="button" class="rf-chip rf-k-${tone}${it.dashed ? ' is-paused' : ''}" data-item="${id}"`
        + ` style="left:${chip.x.toFixed(1)}px;top:${(chip.cy - CHIP_H / 2).toFixed(1)}px"`
        + ` aria-pressed="false" title="${escAttr(it.title)}">`
        + `<span class="rf-chip-kind">${esc(it.chipTag)}</span>`
        + `<span class="rf-chip-text">${esc(it.chipText)}</span></button>`);
    }

    const [one, many] = config.noun;
    const nodeHtml = list.map(n => {
      const inN = n.inItems.length, outN = n.out.length;
      const role = n.kind === 'wallet' ? 'wallet' : inN === 0 ? 'source' : outN === 0 ? 'terminal' : 'mid';
      const custom = config.placeSub ? config.placeSub(role, n.inItems, n.out) : null;
      const sub = custom != null ? custom
        : role === 'wallet' ? 'withdrawal address'
        : role === 'source' ? `${outN} ${outN === 1 ? one : many}`
        : role === 'mid' ? `in ${inN} · out ${outN}`
        : `receives ${inN}`;
      const icon = n.kind === 'wallet' ? '<i class="fa-solid fa-wallet rf-node-icon" aria-hidden="true"></i>' : '';
      return `<div class="rf-node rf-node-${role}" data-key="${escAttr(n.key)}"`
        + ` style="left:${n.x.toFixed(1)}px;top:${n.y.toFixed(1)}px;width:${n.w}px;height:${n.h}px">`
        + `${icon}<span class="rf-node-text"><span class="rf-node-name" title="${escAttr(n.label)}">${esc(n.label)}</span>`
        + `<span class="rf-node-sub" title="${escAttr(sub)}">${esc(sub)}</span></span></div>`;
    }).join('');

    // CSS zoom (not a transform) so the scroll area grows and shrinks with it.
    return `<div class="rf-graph" style="width:${W.toFixed(0)}px;height:${H.toFixed(0)}px;zoom:${zoom}">`
      + `<svg class="rf-svg" width="${W.toFixed(0)}" height="${H.toFixed(0)}" viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" aria-hidden="true">`
      + paths.join('') + ports.join('') + `</svg>${nodeHtml}${chips.join('')}</div>`;
  }

  // ── Selection and the details strip ─────────────────────────────────────

  function applySelection(container: HTMLElement): void {
    const st = states.get(container);
    if (!st) return;
    const item = st.selected != null ? st.byId.get(st.selected) : null;
    if (!item) st.selected = null;
    const sel = item ? item.id : '';
    container.classList.toggle('rf-has-sel', !!item);

    container.querySelectorAll<SVGPathElement>('.rf-edge').forEach(p => {
      const on = !!item && p.getAttribute('data-item') === sel;
      p.classList.toggle('is-sel', on);
      if (on) p.parentNode?.appendChild(p); // draw it above the others
    });
    container.querySelectorAll<SVGCircleElement>('.rf-port').forEach(c =>
      c.classList.toggle('is-sel', !!item && c.getAttribute('data-item') === sel));
    container.querySelectorAll<HTMLElement>('.rf-chip').forEach(b => {
      const on = !!item && b.getAttribute('data-item') === sel;
      b.classList.toggle('is-sel', on);
      b.setAttribute('aria-pressed', String(on));
    });

    // Places on the selected item's path stay bright.
    const related = item ? new Set([srcKey(item), dstKey(item)]) : new Set<string>();
    container.querySelectorAll<HTMLElement>('.rf-node').forEach(n =>
      n.classList.toggle('is-related', related.has(n.getAttribute('data-key') || '')));

    const detail = container.querySelector('.rf-detail') as HTMLElement | null;
    if (!detail) return;
    // Nothing selected: no strip at all.
    detail.classList.toggle('d-none', !item);
    detail.innerHTML = item
      ? st.config.detailHtml(item, {
          multiGroup: st.multiGroup,
          groupName: st.config.groupName ? st.config.groupName(item.group) : item.group,
        })
      : '';
  }

  function wire(container: HTMLElement): void {
    if (container.dataset.rfWired) return;
    container.dataset.rfWired = '1';

    let justDragged = false;
    container.addEventListener('click', (e) => {
      if (justDragged) {
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);

    container.addEventListener('click', (e) => {
      const st = states.get(container);
      if (!st) return;
      const target = e.target as HTMLElement;
      const zoomBtn = target.closest('[data-rf-zoom]') as HTMLElement | null;
      if (zoomBtn) {
        const how = zoomBtn.dataset.rfZoom;
        // Buttons step to whole tens (93% -> 100%, not 103%).
        const steps = st.zoom / ZOOM_STEP;
        if (how === 'in') setZoom(container, (Math.floor(steps + 1e-6) + 1) * ZOOM_STEP);
        else if (how === 'out') setZoom(container, (Math.ceil(steps - 1e-6) - 1) * ZOOM_STEP);
        else setZoom(container, 1);
        // The toolbar was re-rendered; keep focus on the same button.
        container.querySelector<HTMLElement>(`[data-rf-zoom="${how}"]:not(:disabled)`)?.focus();
        return;
      }
      const chip = target.closest('.rf-chip') as HTMLElement | null;
      if (chip) {
        const id = chip.getAttribute('data-item');
        st.selected = st.selected === id ? null : id;
        applySelection(container);
        return;
      }
      const action = target.closest('[data-rf-action]') as HTMLElement | null;
      const item = st.selected != null ? st.byId.get(st.selected) : null;
      if (action && item) st.config.onAction?.(action.dataset.rfAction || '', item);
    });

    container.addEventListener('keydown', (e) => {
      const st = states.get(container);
      if (e.key === 'Escape' && st && st.selected != null) {
        st.selected = null;
        applySelection(container);
      }
    });

    // Hovering a chip previews its line.
    const hover = (id: string | null) => container.querySelectorAll('.rf-edge').forEach(p =>
      p.classList.toggle('is-hover', id != null && p.getAttribute('data-item') === id));
    container.addEventListener('mouseover', (e) => {
      const chip = (e.target as HTMLElement).closest('.rf-chip');
      hover(chip ? chip.getAttribute('data-item') : null);
    });
    container.addEventListener('mouseleave', () => hover(null));

    // Drag to pan. It only becomes a drag after a few px, so clicks still work.
    let drag: {
      id: number; x: number; y: number; vp: HTMLElement; left: number; top: number;
      yEl: HTMLElement; yTop: number; moved: boolean;
    } | null = null;
    container.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.pointerType === 'touch') return; // touch pans natively
      const vp = (e.target as HTMLElement).closest('.rf-viewport') as HTMLElement | null;
      if (!vp) return;
      const yEl = verticalScroller(vp);
      drag = {
        id: e.pointerId, x: e.clientX, y: e.clientY, vp, left: vp.scrollLeft, top: vp.scrollTop,
        yEl, yTop: yEl.scrollTop, moved: false,
      };
    });
    container.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < 4) return;
        drag.moved = true;
        container.classList.add('rf-dragging');
        try { drag.vp.setPointerCapture(drag.id); } catch { /* already released */ }
      }
      drag.vp.scrollLeft = drag.left - dx;
      // Vertically, the viewport if it scrolls, else the page (or widget) around it.
      if (drag.vp.scrollHeight > drag.vp.clientHeight) drag.vp.scrollTop = drag.top - dy;
      else drag.yEl.scrollTop = drag.yTop - dy;
    });
    const endDrag = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (drag.moved) {
        justDragged = true;
        setTimeout(() => { justDragged = false; }, 0); // the click follows pointerup at once
      }
      container.classList.remove('rf-dragging');
      drag = null;
    };
    container.addEventListener('pointerup', endDrag);
    container.addEventListener('pointercancel', endDrag);

    // Ctrl/⌘ + scroll, or a trackpad pinch (which arrives as Ctrl + wheel),
    // zooms the map instead of the whole window. One layout per frame.
    let pendingZoom: number | null = null;
    container.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const st = states.get(container);
      if (!st || !container.querySelector('.rf-graph')) return;
      e.preventDefault();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const first = pendingZoom == null;
      pendingZoom = clampZoom((pendingZoom ?? st.zoom) * Math.exp(-delta * 0.0015));
      if (first) {
        requestAnimationFrame(() => {
          const z = pendingZoom;
          pendingZoom = null;
          if (z != null) setZoom(container, z);
        });
      }
    }, { passive: false });

    // The layout depends on the container's width (and is 0 while a tab
    // hides it), so lay it out again when that changes.
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => {
        const st = states.get(container);
        if (!st) return;
        const w = availableWidth(container);
        if (w > 0 && Math.abs(w - st.width) > 4) render(container, st.items, st.config);
      }).observe(container);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────

  function render(container: HTMLElement, items: FlowItem[], config: FlowMapConfig): void {
    if (!container) return;
    container.classList.add('rf-chart');

    // Drop lines that go nowhere (A → A); ids must be unique for selection.
    const seenIds = new Set<string>();
    const placeable = items.filter(it => {
      if (srcKey(it) === dstKey(it) || seenIds.has(it.id)) return false;
      seenIds.add(it.id);
      return true;
    });

    // Data refreshes re-render the chart; keep the viewport where it was.
    const oldVp = container.querySelector<HTMLElement>('.rf-viewport');
    const keepLeft = oldVp ? oldVp.scrollLeft : 0;
    const keepTop = oldVp ? oldVp.scrollTop : 0;

    const prev = states.get(container);
    const byId = new Map<string, FlowItem>();
    placeable.forEach(it => byId.set(it.id, it));
    const groups = new Set(placeable.map(it => it.group));
    const width = availableWidth(container);
    const zoom = prev ? prev.zoom : loadZoom(container);
    states.set(container, {
      items, config, byId, width, zoom,
      multiGroup: groups.size > 1,
      selected: prev && prev.selected != null && byId.has(prev.selected) ? prev.selected : null,
    });
    wire(container);

    if (placeable.length === 0) {
      container.innerHTML = `<div class="rf-empty"><i class="fa-solid fa-diagram-project"></i><p>${esc(config.emptyText)}</p></div>`;
      return;
    }

    // Build the graph, namespaced by group so the same coin on two exchanges
    // stays two separate places.
    const nodes = new Map<string, FlowNode>();
    const ensure = (key: string, place: FlowPlace): FlowNode => {
      let n = nodes.get(key);
      if (!n) {
        n = { key, label: place.label, kind: place.kind, depth: 0, out: [], inItems: [], col: 0, x: 0, y: 0, w: 0, h: 0, cy: 0 };
        nodes.set(key, n);
      }
      return n;
    };
    const edges: FlowEdge[] = [];
    for (const it of placeable) {
      const from = srcKey(it), to = dstKey(it);
      ensure(from, it.src).out.push(it);
      ensure(to, it.dst).inItems.push(it);
      edges.push({ from, to, item: it });
    }

    // Unrelated flows (nothing connects them) get their own block.
    const adj = new Map<string, Set<string>>();
    nodes.forEach((_, k) => adj.set(k, new Set()));
    edges.forEach(e => { adj.get(e.from)!.add(e.to); adj.get(e.to)!.add(e.from); });
    const components: string[][] = [];
    const seen = new Set<string>();
    for (const start of nodes.keys()) {
      if (seen.has(start)) continue;
      const stack = [start];
      const comp: string[] = [];
      while (stack.length) {
        const k = stack.pop()!;
        if (seen.has(k)) continue;
        seen.add(k);
        comp.push(k);
        adj.get(k)!.forEach(nb => { if (!seen.has(nb)) stack.push(nb); });
      }
      components.push(comp);
    }

    const groupOf = (key: string): string => key.slice(0, key.indexOf('|'));
    const byGroup = new Map<string, string[][]>();
    components.forEach(c => {
      const g = groupOf(c[0]);
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(c);
    });

    // Lay out against the visible width; a hidden chart uses the minimum and
    // is laid out again by the ResizeObserver once it's shown.
    const sections: string[] = [];
    for (const [g, comps] of byGroup) {
      // Biggest flows first.
      comps.sort((a, b) => b.length - a.length);
      // Lay out for the width the zoomed map has to fill.
      const inner = comps.map(c => `<div class="rf-component">${layoutComponent(c, nodes, edges, width / zoom, config, zoom)}</div>`).join('');
      const title = groups.size > 1
        ? `<div class="rf-exchange-title"><i class="fa-solid fa-building-columns"></i> ${esc(config.groupName ? config.groupName(g) : g)}</div>` : '';
      sections.push(`<div class="rf-exchange">${title}${inner}</div>`);
    }

    container.innerHTML = toolbarHtml(zoom)
      + `<div class="rf-viewport"><div class="rf-canvas">${sections.join('')}</div></div>`
      + '<div class="rf-detail" aria-live="polite"></div>';
    const vp = container.querySelector<HTMLElement>('.rf-viewport')!;

    // First chart drawn: measure the scrollbar room and lay out again without it.
    if (gutter === null && width > 0) {
      gutter = Math.max(0, vp.offsetWidth - vp.clientWidth);
      if (gutter > 0) {
        render(container, items, config);
        return;
      }
    }

    vp.scrollLeft = keepLeft;
    vp.scrollTop = keepTop;
    applySelection(container);
  }

  return { render, esc };
})();
