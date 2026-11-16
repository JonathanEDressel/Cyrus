/**
 * RuleFlow — automations drawn as a left-to-right flow map.
 *
 * Columns read left to right: the coins that send money; a chip per rule
 * (what sets it off and how much it moves); any coin the money passes through
 * on the way; and where it ends up — a coin, or a withdrawal address. Every
 * rule is its own chip and its own line, coloured by what triggers it, and
 * paused rules are dashed. Clicking a chip lights up that rule's path and
 * shows it in plain English underneath, with Edit and Pause/Resume when the
 * page hosting the chart offers them.
 *
 * Used by the Automations page (Flow tab) and the Overview page's Flow widget.
 */
const RuleFlow = (() => {
  type TrigKind = 'price' | 'balance' | 'order' | 'alloc';

  interface FlowNode {
    key: string;                 // '<exchange>|A:BTC' or '<exchange>|W:cold_storage'
    label: string;
    kind: 'asset' | 'wallet';
    depth: number;
    out: any[];                  // rules leaving this node
    inRules: any[];              // rules arriving at this node
    col: number;
    x: number; y: number; w: number; h: number; cy: number;
  }
  interface FlowEdge { from: string; to: string; rule: any; }

  interface RenderOpts {
    exchangeName?: (id: any) => string;
    /** Opens the editor for a rule. Shows an Edit button in the details strip. */
    onEditRule?: (rule: any) => void;
    /** Older name for onEditRule. */
    onSelectRule?: (rule: any) => void;
    /** Pauses or resumes a rule. Shows a Pause/Resume button. */
    onToggleRule?: (rule: any) => void;
    /** Overrides the Edit button's label (e.g. "Open in Automations"). */
    editLabel?: string;
  }

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

  const KIND_LABEL: Record<TrigKind, string> = {
    price: 'Price target', balance: 'Balance builds up', order: 'Order fills', alloc: 'Allocation cap',
  };
  const KIND_SHORT: Record<TrigKind, string> = { price: 'PRICE', balance: 'BAL', order: 'FILL', alloc: 'CAP' };

  function esc(str: any): string {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  }
  function escAttr(str: any): string {
    return esc(str).replace(/"/g, '&quot;');
  }

  function sourceAsset(rule: any): string | null {
    if (rule.trigger_type === 'balance_threshold' || rule.trigger_type === 'price_threshold'
        || rule.trigger_type === 'allocation_threshold') {
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

  function kindOf(rule: any): TrigKind {
    switch (rule.trigger_type) {
      case 'price_threshold': return 'price';
      case 'balance_threshold': return 'balance';
      case 'allocation_threshold': return 'alloc';
      default: return 'order';
    }
  }

  function amountText(rule: any): string {
    if (rule.trigger_type === 'allocation_threshold') {
      return `the excess above ${rule.rebalance_target_percent ?? '?'}% of`;
    }
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
  function describeRule(rule: any, markPaused = true): string {
    const src = sourceAsset(rule) || rule.action_asset || 'funds';

    let trig: string;
    if (rule.trigger_type === 'price_threshold') {
      const quote = rule.trigger_price_quote_asset || 'USDT';
      trig = `When ${rule.trigger_asset || src} hits ${rule.trigger_threshold ?? '?'} ${quote}`;
    } else if (rule.trigger_type === 'balance_threshold') {
      const a = rule.trigger_asset || src;
      trig = `When your ${a} balance reaches ${rule.trigger_threshold ?? '?'} ${a}`;
    } else if (rule.trigger_type === 'allocation_threshold') {
      trig = `When ${src} grows past ${rule.trigger_allocation_percent ?? '?'}% of your portfolio`;
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
    if (markPaused && !rule.is_active) sentence += ' (paused)';
    return sentence;
  }

  /** "12,345.6" without trailing zeros, for chip labels. */
  function num(v: any): string {
    const n = Number(v);
    if (!isFinite(n)) return String(v ?? '?');
    return n.toLocaleString(undefined, { maximumFractionDigits: n >= 1 ? 2 : 8 });
  }

  /** The short text on a rule's chip: the condition, then how much it moves. */
  function chipText(rule: any): string {
    const kind = kindOf(rule);
    const asset = sourceAsset(rule) || '';
    let cond: string;
    if (kind === 'price') {
      const quote = (rule.trigger_price_quote_asset || 'USDT').toUpperCase();
      cond = /^(USD|USDC|USDT|GUSD)$/.test(quote)
        ? `≥ $${num(rule.trigger_threshold)}` : `≥ ${num(rule.trigger_threshold)} ${quote}`;
    } else if (kind === 'balance') {
      cond = `≥ ${num(rule.trigger_threshold)} ${asset}`;
    } else if (kind === 'alloc') {
      return `over ${rule.trigger_allocation_percent ?? '?'}% → ${rule.rebalance_target_percent ?? '?'}%`;
    } else {
      cond = rule.trigger_order_id ? `order ${String(rule.trigger_order_id).slice(0, 6)} fills` : 'order fills';
    }
    let amt = '';
    if (rule.action_type === 'withdraw_crypto') {
      amt = rule.use_filled_amount ? 'filled amt' : (rule.action_amount ? `${num(rule.action_amount)} ${asset}` : 'all');
    } else {
      const mode = (rule.action_amount_mode || 'all').toLowerCase();
      amt = mode === 'percent' ? `${rule.action_amount}%` : mode === 'fixed' ? `${num(rule.action_amount)} ${asset}` : 'all';
    }
    return kind === 'order' ? cond : `${cond} · ${amt}`;
  }

  function relTime(iso: string | null | undefined): string {
    if (!iso) return 'never';
    const t = new Date(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z').getTime();
    if (!isFinite(t)) return 'never';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400 * 2) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }

  function runsText(rule: any): string {
    const n = Number(rule.trigger_count || 0);
    if (rule.max_executions != null) return `${Number(rule.execution_count || 0)} of ${rule.max_executions} runs`;
    if (n === 0) return 'not run yet';
    return n === 1 ? '1 run' : `${n} runs`;
  }

  // ── Per-container state ─────────────────────────────────────────────────
  //
  // The container outlives its innerHTML (pages re-render it whenever rules
  // reload), so listeners are wired once and read the latest render from here.

  interface ChartState {
    rules: any[];
    opts: RenderOpts;
    ruleById: Map<number, any>;
    selected: number | null;
    width: number;
  }
  const states = new WeakMap<HTMLElement, ChartState>();
  const observers = new WeakMap<HTMLElement, ResizeObserver>();

  function availableWidth(container: HTMLElement): number {
    return container.offsetParent === null ? 0 : container.clientWidth;
  }

  // ── Layout ──────────────────────────────────────────────────────────────

  function layoutComponent(compKeys: string[], nodes: Map<string, FlowNode>, edges: FlowEdge[],
                           width: number): string {
    const inComp = new Set(compKeys);
    const compEdges = edges.filter(e => inComp.has(e.from) && inComp.has(e.to));
    const list = compKeys.map(k => nodes.get(k)!);

    // Rules can form a loop (sweep USDT into BTC, cap BTC back into USDT).
    // Columns need a one-way order, so find the rules that close a loop —
    // a depth-first walk from the coins nothing flows into — and draw those
    // as return lines underneath instead.
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
    [...list].sort((a, b) => a.inRules.length - b.inRules.length)
      .forEach(n => { if (!visitState.get(n.key)) visit(n.key); });
    const dag = compEdges.filter(e => !back.has(e));

    // Longest-path depth over the one-way rules.
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
    cols[last].sort((a, b) => b.inRules.length - a.inRules.length);
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
      n.h = Math.max(NODE_H, n.inRules.length > 1 ? n.inRules.length * 22 + 18 : NODE_H);
      blockH.set(n.key, Math.max(n.h, chipsH(n)));
    });

    // Horizontal: stretch to the container, within reason; scroll if it's narrow.
    // (A last-column coin that also sends — the start of a return line — needs
    // room for its chips.)
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
    interface ChipPos { rule: any; x: number; cy: number; }
    const chipOf = new Map<any, ChipPos>();
    list.forEach(n => {
      const outs = compEdges.filter(e => e.from === n.key)
        .sort((a, b) => nodes.get(a.to)!.cy - nodes.get(b.to)!.cy);
      const top = n.cy - chipsH(n) / 2 + CHIP_H / 2;
      outs.forEach((e, i) => chipOf.set(e.rule, { rule: e.rule, x: n.x + n.w + CHIP_GAP, cy: top + i * CHIP_STEP }));
    });

    // Entry points: each arriving rule gets its own spot down the node's left edge.
    const entryOf = new Map<any, number>();
    list.forEach(n => {
      const ins = compEdges.filter(e => e.to === n.key)
        .sort((a, b) => (chipOf.get(a.rule)?.cy ?? 0) - (chipOf.get(b.rule)?.cy ?? 0));
      ins.forEach((e, i) => {
        entryOf.set(e.rule, ins.length === 1 ? n.cy
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
      const chip = chipOf.get(e.rule)!;
      const ey = entryOf.get(e.rule) ?? dst.cy;
      const kind = kindOf(e.rule);
      const paused = !e.rule.is_active;
      const id = escAttr(e.rule.id);
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
      paths.push(`<path class="rf-edge rf-k-${kind}${paused ? ' rf-edge-paused' : ''}" data-rule="${id}" d="${d}"></path>`);
      ports.push(`<circle class="rf-port rf-k-${kind}" data-rule="${id}" cx="${dst.x}" cy="${ey.toFixed(1)}" r="3.5"></circle>`);
      const name = e.rule.rule_name || `Rule ${e.rule.id}`;
      chips.push(`<button type="button" class="rf-chip rf-k-${kind}${paused ? ' is-paused' : ''}" data-rule="${id}"`
        + ` style="left:${chip.x.toFixed(1)}px;top:${(chip.cy - CHIP_H / 2).toFixed(1)}px"`
        + ` aria-pressed="false" title="${escAttr(`${name}${paused ? ' (paused)' : ''}\n${describeRule(e.rule, false)}`)}">`
        + `<span class="rf-chip-kind">${paused ? 'PAUSED' : KIND_SHORT[kind]}</span>`
        + `<span class="rf-chip-text">${esc(chipText(e.rule))}</span></button>`);
    }

    const nodeHtml = list.map(n => {
      const inN = n.inRules.length, outN = n.out.length;
      const role = n.kind === 'wallet' ? 'wallet' : inN === 0 ? 'source' : outN === 0 ? 'terminal' : 'mid';
      const sub = role === 'wallet' ? 'withdrawal address'
        : role === 'source' ? `${outN} ${outN === 1 ? 'rule' : 'rules'}`
        : role === 'mid' ? `in ${inN} · out ${outN}`
        : `receives ${inN}`;
      const icon = n.kind === 'wallet' ? '<i class="fa-solid fa-wallet rf-node-icon" aria-hidden="true"></i>' : '';
      return `<div class="rf-node rf-node-${role}" data-key="${escAttr(n.key)}"`
        + ` style="left:${n.x.toFixed(1)}px;top:${n.y.toFixed(1)}px;width:${n.w}px;height:${n.h}px">`
        + `${icon}<span class="rf-node-text"><span class="rf-node-name" title="${escAttr(n.label)}">${esc(n.label)}</span>`
        + `<span class="rf-node-sub">${sub}</span></span></div>`;
    }).join('');

    return `<div class="rf-scroll"><div class="rf-graph" style="width:${W.toFixed(0)}px;height:${H.toFixed(0)}px">`
      + `<svg class="rf-svg" width="${W.toFixed(0)}" height="${H.toFixed(0)}" viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" aria-hidden="true">`
      + paths.join('') + ports.join('') + `</svg>${nodeHtml}${chips.join('')}</div></div>`;
  }

  // ── Selection and the details strip ─────────────────────────────────────

  function applySelection(container: HTMLElement): void {
    const st = states.get(container);
    if (!st) return;
    const rule = st.selected != null ? st.ruleById.get(st.selected) : null;
    if (!rule) st.selected = null;
    const sel = rule ? String(rule.id) : '';
    container.classList.toggle('rf-has-sel', !!rule);

    container.querySelectorAll<SVGPathElement>('.rf-edge').forEach(p => {
      const on = p.getAttribute('data-rule') === sel;
      p.classList.toggle('is-sel', on);
      if (on) p.parentNode?.appendChild(p); // draw it above the others
    });
    container.querySelectorAll<SVGCircleElement>('.rf-port').forEach(c =>
      c.classList.toggle('is-sel', c.getAttribute('data-rule') === sel));
    container.querySelectorAll<HTMLElement>('.rf-chip').forEach(b => {
      const on = b.getAttribute('data-rule') === sel;
      b.classList.toggle('is-sel', on);
      b.setAttribute('aria-pressed', String(on));
    });

    // Nodes on the selected rule's path stay bright.
    const related = new Set<string>();
    if (rule) {
      const ex = String(rule.trigger_exchange_id ?? rule.action_exchange_id ?? 'na');
      const src = sourceAsset(rule);
      const dst = destInfo(rule);
      if (src) related.add(`${ex}|A:${src}`);
      if (dst) related.add(`${ex}|${dst.key}`);
    }
    container.querySelectorAll<HTMLElement>('.rf-node').forEach(n =>
      n.classList.toggle('is-related', related.has(n.getAttribute('data-key') || '')));

    const detail = container.querySelector('.rf-detail') as HTMLElement | null;
    if (!detail) return;
    // Nothing selected: no strip at all.
    detail.classList.toggle('d-none', !rule);
    if (!rule) {
      detail.innerHTML = '';
      return;
    }
    const kind = kindOf(rule);
    const paused = !rule.is_active;
    const canEdit = !!(st.opts.onEditRule || st.opts.onSelectRule);
    const editLabel = st.opts.editLabel
      || (rule.trigger_type === 'allocation_threshold' ? 'Edit on Balancer' : 'Edit');
    const multiEx = container.querySelectorAll('.rf-exchange').length > 1;
    const exId = rule.trigger_exchange_id ?? rule.action_exchange_id;
    const exName = multiEx && st.opts.exchangeName ? st.opts.exchangeName(exId) : '';
    detail.innerHTML = `
      <span class="rf-detail-kind rf-k-${kind}">${esc(KIND_LABEL[kind])}</span>
      <div class="rf-detail-text">
        <strong>${esc(rule.rule_name || `Rule ${rule.id}`)}${exName ? ` <span class="rf-detail-ex">· ${esc(exName)}</span>` : ''}</strong>
        <span>${esc(describeRule(rule, false))}</span>
      </div>
      <span class="rf-detail-meta">${paused ? 'Paused' : 'Active'} · ${esc(runsText(rule))}${rule.last_triggered_at ? ` · last ${esc(relTime(rule.last_triggered_at))}` : ''}</span>
      <div class="rf-detail-actions">
        ${canEdit ? `<button type="button" class="btn-secondary" data-rf-action="edit">${esc(editLabel)}</button>` : ''}
        ${st.opts.onToggleRule ? `<button type="button" class="btn-secondary" data-rf-action="toggle">${paused ? 'Resume' : 'Pause'}</button>` : ''}
      </div>`;
  }

  function wire(container: HTMLElement): void {
    if (container.dataset.rfWired) return;
    container.dataset.rfWired = '1';

    container.addEventListener('click', (e) => {
      const st = states.get(container);
      if (!st) return;
      const target = e.target as HTMLElement;
      const chip = target.closest('.rf-chip') as HTMLElement | null;
      if (chip) {
        const id = Number(chip.getAttribute('data-rule'));
        st.selected = st.selected === id ? null : id;
        applySelection(container);
        return;
      }
      const action = target.closest('[data-rf-action]') as HTMLElement | null;
      const rule = st.selected != null ? st.ruleById.get(st.selected) : null;
      if (!action || !rule) return;
      if (action.dataset.rfAction === 'edit') (st.opts.onEditRule || st.opts.onSelectRule)?.(rule);
      if (action.dataset.rfAction === 'toggle') st.opts.onToggleRule?.(rule);
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
      p.classList.toggle('is-hover', !!id && p.getAttribute('data-rule') === id));
    container.addEventListener('mouseover', (e) => {
      const chip = (e.target as HTMLElement).closest('.rf-chip');
      hover(chip ? chip.getAttribute('data-rule') : null);
    });
    container.addEventListener('mouseleave', () => hover(null));

    // The layout depends on the container's width (and is 0 while a tab
    // hides it), so lay it out again when that changes.
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        const st = states.get(container);
        if (!st) return;
        const w = availableWidth(container);
        if (w > 0 && Math.abs(w - st.width) > 4) render(container, st.rules, st.opts);
      });
      ro.observe(container);
      observers.set(container, ro);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────

  function render(container: HTMLElement, rules: any[], opts: RenderOpts = {}): void {
    if (!container) return;
    container.classList.add('rf-chart');
    // The old circle chart's hover tooltip lived on <body>; drop it if present.
    document.getElementById('rf-tooltip')?.remove();

    const placeable = (rules || []).filter(r =>
      (r.trigger_exchange_id ?? r.action_exchange_id ?? null) != null
      && sourceAsset(r) && destInfo(r));

    const prev = states.get(container);
    const ruleById = new Map<number, any>();
    placeable.forEach(r => { if (r.id != null) ruleById.set(Number(r.id), r); });
    const width = availableWidth(container);
    states.set(container, {
      rules, opts, ruleById, width,
      selected: prev && prev.selected != null && ruleById.has(prev.selected) ? prev.selected : null,
    });
    wire(container);

    if (placeable.length === 0) {
      container.innerHTML = '<div class="rf-empty"><i class="fa-solid fa-diagram-project"></i><p>No automations to chart yet.</p></div>';
      return;
    }

    // Build the graph, namespaced by exchange so the same coin on two
    // exchanges stays two separate places.
    const nodes = new Map<string, FlowNode>();
    const ensure = (key: string, label: string, kind: 'asset' | 'wallet'): FlowNode => {
      let n = nodes.get(key);
      if (!n) {
        n = { key, label, kind, depth: 0, out: [], inRules: [], col: 0, x: 0, y: 0, w: 0, h: 0, cy: 0 };
        nodes.set(key, n);
      }
      return n;
    };
    const edges: FlowEdge[] = [];
    for (const r of placeable) {
      const ex = String(r.trigger_exchange_id ?? r.action_exchange_id ?? 'na');
      const dest = destInfo(r)!;
      const srcKey = `${ex}|A:${sourceAsset(r)}`;
      const destKey = `${ex}|${dest.key}`;
      if (srcKey === destKey) continue; // A → A
      const s = ensure(srcKey, sourceAsset(r)!, 'asset');
      const d = ensure(destKey, dest.label, dest.kind);
      s.out.push(r);
      d.inRules.push(r);
      edges.push({ from: srcKey, to: destKey, rule: r });
    }

    // Unrelated flows (no rule connects them) get their own block.
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

    const exOf = (key: string): string => key.slice(0, key.indexOf('|'));
    const byEx = new Map<string, string[][]>();
    components.forEach(c => {
      const ex = exOf(c[0]);
      if (!byEx.has(ex)) byEx.set(ex, []);
      byEx.get(ex)!.push(c);
    });
    const multiEx = byEx.size > 1;
    const nameOf = (ex: string): string => {
      if (ex === 'na') return 'Unassigned';
      return opts.exchangeName?.(isNaN(Number(ex)) ? ex : Number(ex)) || `Exchange ${ex}`;
    };

    // Lay out against the visible width; a hidden chart uses the minimum and
    // is laid out again by the ResizeObserver once it's shown.
    const sections: string[] = [];
    for (const [ex, comps] of byEx) {
      // Biggest flows first.
      comps.sort((a, b) => b.length - a.length);
      const inner = comps.map(c => `<div class="rf-component">${layoutComponent(c, nodes, edges, width)}</div>`).join('');
      const title = multiEx
        ? `<div class="rf-exchange-title"><i class="fa-solid fa-building-columns"></i> ${esc(nameOf(ex))}</div>` : '';
      sections.push(`<div class="rf-exchange">${title}${inner}</div>`);
    }

    container.innerHTML = sections.join('') + '<div class="rf-detail" aria-live="polite"></div>';
    applySelection(container);
  }

  return { render, describeRule };
})();
