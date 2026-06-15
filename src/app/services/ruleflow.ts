/**
 * RuleFlow — renders automations as an asset-centric flow chart.
 *
 * Circles are assets (or withdrawal wallets); arrows are orders/rules that
 * convert one asset into another (or withdraw to a wallet). Assets that share
 * a destination collapse into a single circle. Layout is top-down: pure
 * sources on top, flowing down to terminal destinations. Hovering a circle
 * shows a plain-English description of the order(s) that start there.
 *
 * Used by both the Automations page (Flow tab) and the Overview page.
 */
const RuleFlow = (() => {
  const NS = 'http://www.w3.org/2000/svg';

  interface FlowNode {
    key: string;                 // 'A:FIDD' (asset) or 'W:mywallet' (wallet)
    label: string;               // 'FIDD' / 'mywallet'
    kind: 'asset' | 'wallet';
    depth: number;
    out: any[];                  // rules originating from this node
    inFrom: Set<string>;         // labels of assets feeding into this node
  }
  interface FlowEdge { from: string; to: string; rule: any; }

  function esc(str: any): string {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  }
  function escAttr(str: any): string {
    return esc(str).replace(/"/g, '&quot;');
  }

  function sourceAsset(rule: any): string | null {
    if (rule.trigger_type === 'balance_threshold' || rule.trigger_type === 'price_threshold') {
      return (rule.trigger_asset || rule.action_asset || '').toUpperCase() || null;
    }
    return (rule.action_asset || '').toUpperCase() || null; // order_filled
  }

  function destInfo(rule: any): { key: string; label: string; kind: 'asset' | 'wallet' } | null {
    if (rule.action_type === 'convert_crypto') {
      const a = (rule.convert_to_asset || '').toUpperCase();
      return a ? { key: 'A:' + a, label: a, kind: 'asset' } : null;
    }
    if (rule.action_type === 'withdraw_crypto') {
      const w = rule.action_address_key || 'wallet';
      return { key: 'W:' + w, label: w, kind: 'wallet' };
    }
    return null;
  }

  function amountText(rule: any): string {
    if (rule.action_type === 'withdraw_crypto') {
      if (rule.trigger_type === 'balance_threshold') return 'the full balance of';
      if (rule.use_filled_amount) return 'the filled amount of';
      return rule.action_amount ? `${rule.action_amount}` : 'the full balance of';
    }
    const mode = (rule.action_amount_mode || 'all').toLowerCase();
    if (mode === 'percent') return `${rule.action_amount}% of`;
    if (mode === 'fixed') return `${rule.action_amount}`;
    return 'all';
  }

  /** A plain-English sentence describing what a single rule does. */
  function describeRule(rule: any): string {
    const src = sourceAsset(rule) || rule.action_asset || 'funds';

    let trig: string;
    if (rule.trigger_type === 'price_threshold') {
      const quote = rule.trigger_price_quote_asset || 'USDT';
      trig = `When ${rule.trigger_asset || src} hits ${rule.trigger_threshold ?? '?'} ${quote}`;
    } else if (rule.trigger_type === 'balance_threshold') {
      const a = rule.trigger_asset || src;
      trig = `When your ${a} balance reaches ${rule.trigger_threshold ?? '?'} ${a}`;
    } else {
      const oid = rule.trigger_order_id ? `order ${String(rule.trigger_order_id).slice(0, 8)}…` : 'an order';
      trig = `When ${oid} fills`;
    }

    let act: string;
    if (rule.action_type === 'convert_crypto') {
      act = `convert ${amountText(rule)} ${src} into ${rule.convert_to_asset || '?'}`;
    } else {
      act = `withdraw ${amountText(rule)} ${rule.action_asset || src} to ${rule.action_address_key || 'your wallet'}`;
    }

    let sentence = `${trig}, ${act}.`;
    if (!rule.is_active) sentence += ' (paused)';
    return sentence;
  }

  function drawArrows(rowsEl: HTMLElement, edges: FlowEdge[]): void {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'rf-svg');
    svg.innerHTML = `<defs>
      <marker id="rf-ah" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
        <path d="M0,0 L9,3.5 L0,7 Z" class="rf-arrowhead"/>
      </marker>
      <marker id="rf-ah-p" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
        <path d="M0,0 L9,3.5 L0,7 Z" class="rf-arrowhead-paused"/>
      </marker>
      <marker id="rf-ah-hl" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
        <path d="M0,0 L9,3.5 L0,7 Z" class="rf-arrowhead-hl"/>
      </marker>
    </defs>`;
    rowsEl.appendChild(svg);

    const base = rowsEl.getBoundingClientRect();
    // If the chart isn't visible/laid out yet, every node measures as 0×0 and we
    // would draw garbage at the origin. Bail; we re-render once it's shown.
    if (base.width === 0 || rowsEl.offsetParent === null) return;

    // Pin the SVG's user space to a 1:1 pixel grid so path coordinates (computed
    // from getBoundingClientRect) line up exactly with the nodes.
    svg.setAttribute('width', String(base.width));
    svg.setAttribute('height', String(base.height));
    svg.setAttribute('viewBox', `0 0 ${base.width} ${base.height}`);

    const width = base.width;
    const PAD = 14; // clearance around a node's column

    interface Box { left: number; right: number; cx: number; top: number; bottom: number; cy: number; }

    // One measurement pass: map each node by key, and keep all boxes for
    // obstacle tests. Keyed lookups avoid fragile attribute-selector escaping.
    const boxByKey = new Map<string, Box>();
    const boxes: Box[] = [];
    Array.from(rowsEl.querySelectorAll<HTMLElement>('.rf-node')).forEach(el => {
      const r = el.getBoundingClientRect();
      const b: Box = {
        left: r.left - base.left,
        right: r.right - base.left,
        cx: r.left - base.left + r.width / 2,
        top: r.top - base.top,
        bottom: r.bottom - base.top,
        cy: r.top - base.top + r.height / 2,
      };
      boxByKey.set(el.getAttribute('data-key') || '', b);
      boxes.push(b);
    });

    // Find a vertical lane x (near `desired`) that avoids every blocked column.
    const clearLane = (desired: number, blocked: Array<[number, number]>): number => {
      const hits = (x: number) => blocked.some(([a, b]) => x >= a && x <= b);
      if (desired >= 10 && desired <= width - 10 && !hits(desired)) return desired;
      for (let off = 8; off <= width; off += 8) {
        for (const cand of [desired + off, desired - off]) {
          if (cand >= 10 && cand <= width - 10 && !hits(cand)) return cand;
        }
      }
      return desired;
    };

    // Turn a polyline into a path with rounded corners (quadratic at each bend).
    const roundedPath = (pts: Array<{ x: number; y: number }>, radius: number): string => {
      const p = pts.filter((pt, i) =>
        i === 0 || Math.abs(pt.x - pts[i - 1].x) > 0.5 || Math.abs(pt.y - pts[i - 1].y) > 0.5);
      if (p.length < 2) return '';
      let d = `M${p[0].x},${p[0].y}`;
      for (let i = 1; i < p.length - 1; i++) {
        const a = p[i - 1], c = p[i], b = p[i + 1];
        const d1 = Math.hypot(c.x - a.x, c.y - a.y);
        const d2 = Math.hypot(b.x - c.x, b.y - c.y);
        const r = Math.min(radius, d1 / 2, d2 / 2);
        const ax = c.x - ((c.x - a.x) / d1) * r, ay = c.y - ((c.y - a.y) / d1) * r;
        const bx = c.x + ((b.x - c.x) / d2) * r, by = c.y + ((b.y - c.y) / d2) * r;
        d += ` L${ax.toFixed(1)},${ay.toFixed(1)} Q${c.x},${c.y} ${bx.toFixed(1)},${by.toFixed(1)}`;
      }
      const last = p[p.length - 1];
      d += ` L${last.x},${last.y}`;
      return d;
    };

    // Collapse duplicate source→dest pairs into one arrow.
    const pairs = new Map<string, any[]>();
    for (const e of edges) {
      const k = `${e.from}>${e.to}`;
      if (!pairs.has(k)) pairs.set(k, []);
      pairs.get(k)!.push(e.rule);
    }

    for (const [k, rs] of pairs) {
      const sep = k.indexOf('>');
      const fromKey = k.slice(0, sep);
      const toKey = k.slice(sep + 1);
      const f = boxByKey.get(fromKey);
      const t = boxByKey.get(toKey);
      if (!f || !t) continue;

      const x1 = f.cx, y1 = f.bottom; // leave from source bottom-center
      const x2 = t.cx, y2 = t.top;    // arrive at dest top-center
      const paused = rs.every(r => !r.is_active);

      // Obstacles: nodes whose center lies strictly between the two rows.
      const yLo = Math.min(y1, y2), yHi = Math.max(y1, y2);
      const blocked = boxes
        .filter(b => b.cy > yLo + 1 && b.cy < yHi - 1)
        .map(b => [b.left - PAD, b.right + PAD] as [number, number]);

      let d: string;
      if (blocked.length === 0) {
        // Clear shot: gentle curve straight between the two nodes.
        const midY = (y1 + y2) / 2;
        d = `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`;
      } else {
        // Obstacles in between: drop a short vertical stub out of each node so the
        // line stays visibly attached, then run straight down a node-free lane.
        const stub = Math.min(18, (y2 - y1) / 2);
        const yA = y1 + stub;
        const yB = y2 - stub;
        const laneX = clearLane((x1 + x2) / 2, blocked);
        d = roundedPath([
          { x: x1, y: y1 }, { x: x1, y: yA }, { x: laneX, y: yA },
          { x: laneX, y: yB }, { x: x2, y: yB }, { x: x2, y: y2 },
        ], 14);
      }

      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', paused ? 'rf-arrow rf-arrow-paused' : 'rf-arrow');
      path.setAttribute('marker-end', `url(#${paused ? 'rf-ah-p' : 'rf-ah'})`);
      path.setAttribute('data-from', fromKey);
      path.setAttribute('data-to', toKey);
      svg.appendChild(path);
    }
  }

  function attachTooltip(container: HTMLElement): void {
    let tip = document.getElementById('rf-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'rf-tooltip';
      tip.className = 'rf-tooltip d-none';
      document.body.appendChild(tip);
    }
    const tipEl = tip;

    // The container persists across re-renders (only its innerHTML changes), so
    // wire the delegated listeners exactly once to avoid stacking them.
    if (container.dataset.rfTooltipWired) return;
    container.dataset.rfTooltipWired = '1';

    let hlKey = '';
    const setHighlight = (key: string): void => {
      if (key === hlKey) return;
      hlKey = key;
      container.querySelectorAll<SVGPathElement>('.rf-arrow').forEach(p => {
        const on = !!key && (p.getAttribute('data-from') === key || p.getAttribute('data-to') === key);
        p.classList.toggle('rf-arrow-hl', on);
        p.classList.toggle('rf-arrow-dim', !!key && !on); // fade the unrelated ones
        if (on) {
          p.setAttribute('marker-end', 'url(#rf-ah-hl)');
          p.parentNode?.appendChild(p); // raise above sibling arrows
        } else {
          p.setAttribute('marker-end', p.classList.contains('rf-arrow-paused') ? 'url(#rf-ah-p)' : 'url(#rf-ah)');
        }
      });
    };

    container.addEventListener('mousemove', (e) => {
      const node = (e.target as HTMLElement).closest('.rf-node') as HTMLElement | null;
      if (!node) { tipEl.classList.add('d-none'); setHighlight(''); return; }
      const desc = node.getAttribute('data-desc') || '';
      tipEl.innerHTML = desc.split('\n').map(line => `<div class="rf-tooltip-line">${esc(line)}</div>`).join('');
      tipEl.style.left = `${(e as MouseEvent).clientX + 14}px`;
      tipEl.style.top = `${(e as MouseEvent).clientY + 14}px`;
      tipEl.classList.remove('d-none');
      setHighlight(node.getAttribute('data-key') || '');
    });
    container.addEventListener('mouseleave', () => { tipEl.classList.add('d-none'); setHighlight(''); });
  }

  function render(container: HTMLElement, rules: any[], opts?: { exchangeName?: (id: any) => string }): void {
    if (!container) return;
    container.classList.add('rf-chart');

    // Skip rules with no exchange — they don't belong to any flow.
    const placeable = (rules || []).filter(r =>
      (r.trigger_exchange_id ?? r.action_exchange_id ?? null) != null
      && sourceAsset(r) && destInfo(r));
    if (placeable.length === 0) {
      container.innerHTML = '<div class="rf-empty"><i class="fa-solid fa-diagram-project"></i><p>No automations to chart yet.</p></div>';
      return;
    }

    // Build the asset graph.
    const nodes = new Map<string, FlowNode>();
    const ensure = (key: string, label: string, kind: 'asset' | 'wallet'): FlowNode => {
      let n = nodes.get(key);
      if (!n) { n = { key, label, kind, depth: 0, out: [], inFrom: new Set() }; nodes.set(key, n); }
      return n;
    };
    const edges: FlowEdge[] = [];
    for (const r of placeable) {
      const ex = (r.trigger_exchange_id ?? r.action_exchange_id ?? 'na');
      const srcLabel = sourceAsset(r)!;
      const dest = destInfo(r)!;
      // Namespace keys by exchange so the same symbol on two exchanges stays as
      // two separate nodes in two separate flows.
      const srcKey = `${ex}|A:${srcLabel}`;
      const destKey = `${ex}|${dest.key}`;
      if (srcKey === destKey) continue; // skip A→A self loops
      const sNode = ensure(srcKey, srcLabel, 'asset');
      const dNode = ensure(destKey, dest.label, dest.kind);
      sNode.out.push(r);
      dNode.inFrom.add(srcLabel);
      edges.push({ from: srcKey, to: destKey, rule: r });
    }

    // Split into connected components (undirected) so unrelated charts render
    // as separate, non-overlapping blocks.
    const adj = new Map<string, Set<string>>();
    nodes.forEach((_, k) => adj.set(k, new Set<string>()));
    for (const e of edges) { adj.get(e.from)!.add(e.to); adj.get(e.to)!.add(e.from); }

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

    const nodeHtml = (n: FlowNode): string => {
      const kindClass = n.kind === 'wallet' ? 'rf-node-wallet'
        : n.depth === 0 ? 'rf-node-source'
        : n.out.length === 0 ? 'rf-node-terminal'
        : 'rf-node-mid';
      const paused = n.out.length > 0 && n.out.every(r => !r.is_active);

      let desc: string;
      if (n.out.length > 0) {
        desc = n.out.map(describeRule).join('\n');
      } else {
        const from = [...n.inFrom].join(', ');
        desc = n.kind === 'wallet'
          ? `Withdrawal destination${from ? ` — receives from ${from}` : ''}.`
          : `Final destination${from ? ` — receives from ${from}` : ''}.`;
      }

      const icon = n.kind === 'wallet' ? 'fa-wallet' : 'fa-coins';
      return `<div class="rf-node ${kindClass}${paused ? ' rf-paused' : ''}" data-key="${escAttr(n.key)}" data-desc="${escAttr(desc)}">
          <i class="fa-solid ${icon} rf-node-icon"></i>
          <span class="rf-node-label">${esc(n.label)}</span>
        </div>`;
    };

    // Group components by exchange (keys are namespaced by exchange id) so each
    // exchange's flows render in their own labelled section.
    const exOf = (key: string): string => key.slice(0, key.indexOf('|'));
    const groupsByEx = new Map<string, string[][]>();
    for (const comp of components) {
      const ex = exOf(comp[0]);
      if (!groupsByEx.has(ex)) groupsByEx.set(ex, []);
      groupsByEx.get(ex)!.push(comp);
    }
    const multiEx = groupsByEx.size > 1;

    const nameOf = (ex: string): string => {
      if (ex === 'na') return 'Unassigned';
      const resolved = opts?.exchangeName?.(isNaN(Number(ex)) ? ex : Number(ex));
      return resolved || `Exchange ${ex}`;
    };

    const jobs: Array<{ ci: number; edges: FlowEdge[] }> = [];
    let ci = 0;

    const renderComponent = (compKeys: string[]): string => {
      const inComp = new Set(compKeys);
      const compEdges = edges.filter(e => inComp.has(e.from) && inComp.has(e.to));

      // Longest-path depth within this component (capped, cycle-safe).
      compKeys.forEach(k => { nodes.get(k)!.depth = 0; });
      const M = compKeys.length;
      for (let i = 0; i < M; i++) {
        let changed = false;
        for (const e of compEdges) {
          const f = nodes.get(e.from)!, t = nodes.get(e.to)!;
          if (t.depth < f.depth + 1) { t.depth = Math.min(f.depth + 1, M); changed = true; }
        }
        if (!changed) break;
      }

      // Withdrawal wallets are always endpoints → force them onto the bottom row.
      let maxAssetDepth = 0;
      for (const k of compKeys) {
        const n = nodes.get(k)!;
        if (n.kind !== 'wallet') maxAssetDepth = Math.max(maxAssetDepth, n.depth);
      }
      if (compKeys.some(k => nodes.get(k)!.kind === 'wallet')) {
        const walletRow = maxAssetDepth + 1;
        for (const k of compKeys) {
          const n = nodes.get(k)!;
          if (n.kind === 'wallet') n.depth = walletRow;
        }
      }

      const maxDepth = Math.max(...compKeys.map(k => nodes.get(k)!.depth));
      const rows: FlowNode[][] = Array.from({ length: maxDepth + 1 }, () => []);
      compKeys.forEach(k => rows[nodes.get(k)!.depth].push(nodes.get(k)!));
      const rowsHtml = rows.map(row =>
        `<div class="rf-row">${row.map(nodeHtml).join('')}</div>`
      ).join('');

      const myCi = ci++;
      jobs.push({ ci: myCi, edges: compEdges });
      return `<div class="rf-component" data-ci="${myCi}"><div class="rf-rows">${rowsHtml}</div></div>`;
    };

    const sections: string[] = [];
    for (const [ex, comps] of groupsByEx) {
      const inner = comps.map(renderComponent).join('');
      const title = multiEx
        ? `<div class="rf-exchange-title"><i class="fa-solid fa-building-columns"></i> ${esc(nameOf(ex))}</div>`
        : '';
      sections.push(`<div class="rf-exchange">${title}<div class="rf-components">${inner}</div></div>`);
    }

    container.innerHTML = sections.join('');

    requestAnimationFrame(() => {
      jobs.forEach(({ ci: jci, edges: jEdges }) => {
        const rowsEl = container.querySelector(`.rf-component[data-ci="${jci}"] .rf-rows`) as HTMLElement | null;
        if (rowsEl) drawArrows(rowsEl, jEdges);
      });
    });
    attachTooltip(container);
  }

  return { render, describeRule };
})();
