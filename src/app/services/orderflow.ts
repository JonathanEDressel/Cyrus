/**
 * OrderFlow — renders open orders as an asset-centric flow chart.
 *
 * Each node is a currency/asset circle. Arrows represent orders:
 *   BUY  BASE/QUOTE  →  QUOTE ──▶ BASE   (spending quote to receive base)
 *   SELL BASE/QUOTE  →  BASE  ──▶ QUOTE  (spending base to receive quote)
 *
 * Orders are grouped by exchange. The SVG arrow drawing mirrors RuleFlow's
 * approach so the two charts look visually consistent.
 *
 * Used by the Open Orders page (Flow tab).
 */
const OrderFlow = (() => {
  const NS = 'http://www.w3.org/2000/svg';

  interface OFNode {
    key: string;
    label: string;
    depth: number;
    outOrders: any[];
    inFrom: Set<string>;
    inOrders: any[];   // orders flowing INTO this node
  }
  interface OFEdge { from: string; to: string; order: any; }

  function esc(str: any): string {
    const d = document.createElement('div');
    d.textContent = String(str ?? '');
    return d.innerHTML;
  }
  function escAttr(str: any): string {
    return esc(str).replace(/"/g, '&quot;');
  }

  /** Split a CCXT symbol like "BTC/USD" into [base, quote]. */
  function splitPair(pair: string): [string, string] {
    const idx = pair.indexOf('/');
    if (idx === -1) return [pair, ''];
    return [pair.slice(0, idx).toUpperCase(), pair.slice(idx + 1).toUpperCase()];
  }

  /** Return source and dest asset labels for an order. */
  function orderAssets(order: any): { src: string; dst: string } | null {
    const [base, quote] = splitPair(order.pair || '');
    if (!base || !quote) return null;
    return order.side === 'buy'
      ? { src: quote, dst: base }
      : { src: base,  dst: quote };
  }

  /** One-line description of an order for the tooltip. */
  function describeOrder(o: any): string {
    const side = (o.side || '').toUpperCase();
    const price = o.price && Number(o.price) > 0 ? `@ ${o.price}` : 'market';
    const vol = o.volume ? `${o.volume}` : '';
    const id = o.id ? String(o.id).slice(0, 12) + (String(o.id).length > 12 ? '…' : '') : '';
    const status = o.status ? ` [${o.status}]` : '';
    return `${side} ${o.pair || ''} ${vol} ${price}${status} — ${id}`;
  }

  // ── SVG arrow drawing (mirrors RuleFlow) ─────────────────────────────────

  function drawArrows(rowsEl: HTMLElement, edges: OFEdge[]): void {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'rf-svg');
    svg.innerHTML = '';
    rowsEl.appendChild(svg);

    const base = rowsEl.getBoundingClientRect();
    if (base.width === 0 || rowsEl.offsetParent === null) return;

    svg.setAttribute('width', String(base.width));
    svg.setAttribute('height', String(base.height));
    svg.setAttribute('viewBox', `0 0 ${base.width} ${base.height}`);

    const PAD = 14;
    interface Box { left: number; right: number; cx: number; top: number; bottom: number; cy: number; }
    const boxByKey = new Map<string, Box>();
    const boxes: Box[] = [];
    Array.from(rowsEl.querySelectorAll<HTMLElement>('.rf-node')).forEach(el => {
      const r = el.getBoundingClientRect();
      const b: Box = {
        left: r.left - base.left, right: r.right - base.left,
        cx: r.left - base.left + r.width / 2,
        top: r.top - base.top, bottom: r.bottom - base.top,
        cy: r.top - base.top + r.height / 2,
      };
      boxByKey.set(el.getAttribute('data-key') || '', b);
      boxes.push(b);
    });

    const clearLane = (desired: number, blocked: Array<[number, number]>): number => {
      const hits = (x: number) => blocked.some(([a, b]) => x >= a && x <= b);
      if (desired >= 10 && !hits(desired)) return desired;
      for (let off = 8; off <= base.width; off += 8) {
        for (const cand of [desired + off, desired - off]) {
          if (cand >= 10 && cand <= base.width - 10 && !hits(cand)) return cand;
        }
      }
      return desired;
    };

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
      d += ` L${pts[pts.length - 1].x},${pts[pts.length - 1].y}`;
      return d;
    };

    // Collapse duplicate src→dst pairs into one arrow.
    const pairs = new Map<string, any[]>();
    for (const e of edges) {
      const k = `${e.from}>${e.to}`;
      if (!pairs.has(k)) pairs.set(k, []);
      pairs.get(k)!.push(e.order);
    }

    for (const [k, orders] of pairs) {
      const sep = k.indexOf('>');
      const fromKey = k.slice(0, sep), toKey = k.slice(sep + 1);
      const f = boxByKey.get(fromKey), t = boxByKey.get(toKey);
      if (!f || !t) continue;

      const x1 = f.cx, y1 = f.bottom;
      const x2 = t.cx, y2 = t.top;
      const isPartial = orders.some(o => o.filled && Number(o.filled) > 0 && o.status !== 'open');
      const yLo = Math.min(y1, y2), yHi = Math.max(y1, y2);
      const blocked = boxes
        .filter(b => b.cy > yLo + 1 && b.cy < yHi - 1)
        .map(b => [b.left - PAD, b.right + PAD] as [number, number]);

      let d: string;
      if (blocked.length === 0) {
        const midY = (y1 + y2) / 2;
        d = `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`;
      } else {
        const stub = Math.min(18, (y2 - y1) / 2);
        const laneX = clearLane((x1 + x2) / 2, blocked);
        d = roundedPath([
          { x: x1, y: y1 }, { x: x1, y: y1 + stub }, { x: laneX, y: y1 + stub },
          { x: laneX, y: y2 - stub }, { x: x2, y: y2 - stub }, { x: x2, y: y2 },
        ], 14);
      }

      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', isPartial ? 'rf-arrow rf-arrow-paused' : 'rf-arrow');
      path.setAttribute('data-from', fromKey);
      path.setAttribute('data-to', toKey);
      svg.appendChild(path);
    }
  }

  function attachTooltip(container: HTMLElement): void {
    let tip = document.getElementById('of-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'of-tooltip';
      tip.className = 'rf-tooltip d-none';
      document.body.appendChild(tip);
    }
    const tipEl = tip;

    if (container.dataset.ofTooltipWired) return;
    container.dataset.ofTooltipWired = '1';

    let hlKey = '';
    const setHighlight = (key: string): void => {
      if (key === hlKey) return;
      hlKey = key;
      container.querySelectorAll<SVGPathElement>('.rf-arrow').forEach(p => {
        const on = !!key && (p.getAttribute('data-from') === key || p.getAttribute('data-to') === key);
        p.classList.toggle('rf-arrow-hl', on);
        p.classList.toggle('rf-arrow-dim', !!key && !on);
        if (on) {
          p.parentNode?.appendChild(p);
        }
      });
    };

    container.addEventListener('mousemove', (e) => {
      const node = (e.target as HTMLElement).closest('.rf-node') as HTMLElement | null;
      if (!node) { tipEl.classList.add('d-none'); setHighlight(''); return; }
      const desc = node.getAttribute('data-desc') || '';
      tipEl.innerHTML = desc.split('\n').map(l => `<div class="rf-tooltip-line">${esc(l)}</div>`).join('');
      tipEl.style.left = `${(e as MouseEvent).clientX + 14}px`;
      tipEl.style.top = `${(e as MouseEvent).clientY + 14}px`;
      tipEl.classList.remove('d-none');
      setHighlight(node.getAttribute('data-key') || '');
    });
    container.addEventListener('mouseleave', () => { tipEl.classList.add('d-none'); setHighlight(''); });
  }

  // ── Public render ──────────────────────────────────────────────────────────

  function render(container: HTMLElement, orders: any[]): void {
    if (!container) return;
    container.classList.add('rf-chart');

    const placeable = (orders || []).filter(o => orderAssets(o) !== null);
    if (placeable.length === 0) {
      container.innerHTML = '<div class="rf-empty"><i class="fa-solid fa-diagram-project"></i><p>No orders to chart yet.</p></div>';
      return;
    }

    // Group by exchange name.
    const byExchange = new Map<string, any[]>();
    for (const o of placeable) {
      const ex = o.exchangeName || 'Exchange';
      if (!byExchange.has(ex)) byExchange.set(ex, []);
      byExchange.get(ex)!.push(o);
    }
    const multiEx = byExchange.size > 1;

    const STABLECOINS = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDP', 'FDUSD', 'USDD', 'USD', 'FIDD']);

    /**
     * Expected amount received at the destination node for a single order.
     * SELL BASE/QUOTE → dst=QUOTE: volume × price
     * BUY  BASE/QUOTE → dst=BASE:  volume (base amount being bought)
     */
    function computeReceived(order: any): number | null {
      const price  = Number(order.price);
      const volume = Number(order.volume);
      if (!(volume > 0)) return null;
      if (order.side === 'sell') {
        return price > 0 ? volume * price : null;  // market orders have no price
      }
      // buy: we receive `volume` of the base asset
      return volume;
    }

    const nodeHtml = (n: OFNode): string => {
      const kindClass = n.depth === 0 ? 'rf-node-source'
        : n.outOrders.length === 0 ? 'rf-node-terminal'
        : 'rf-node-mid';

      let desc: string;
      if (n.outOrders.length > 0) {
        desc = n.outOrders.map(describeOrder).join('\n');
      } else {
        const from = [...n.inFrom].join(', ');
        desc = `Destination asset${from ? ` — received from ${from}` : ''}.`;
      }

      // Badge: only on nodes that have inbound orders (destination nodes)
      let badge = '';
      if (n.inOrders.length > 0) {
        const amounts = n.inOrders.map(computeReceived).filter((a): a is number => a !== null);
        if (amounts.length > 0) {
          const total = amounts.reduce((s, a) => s + a, 0);
          const approx = amounts.length < n.inOrders.length ? '~' : '';
          const isStable = STABLECOINS.has(n.label.toUpperCase());
          const formatted = isStable
            ? `${approx}$${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : `${approx}${total.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${esc(n.label)}`;
          badge = `<span class="rf-node-amount">${formatted}</span>`;
        }
      }

      return `<div class="rf-node ${kindClass}" data-key="${escAttr(n.key)}" data-desc="${escAttr(desc)}">
          <i class="fa-solid fa-coins rf-node-icon"></i>
          <span class="rf-node-label">${esc(n.label)}</span>
          ${badge}
        </div>`;
    };

    let globalCi = 0;
    const allJobs: Array<{ ci: number; edges: OFEdge[] }> = [];

    const renderExchange = (exOrders: any[]): string => {
      const nodes = new Map<string, OFNode>();
      const edges: OFEdge[] = [];

      const ensure = (key: string, label: string): OFNode => {
        let n = nodes.get(key);
        if (!n) { n = { key, label, depth: 0, outOrders: [], inFrom: new Set(), inOrders: [] }; nodes.set(key, n); }
        return n;
      };

      for (const o of exOrders) {
        const assets = orderAssets(o)!;
        const srcKey = `A:${assets.src}`;
        const dstKey = `A:${assets.dst}`;
        if (srcKey === dstKey) continue;
        const sNode = ensure(srcKey, assets.src);
        const dNode = ensure(dstKey, assets.dst);
        sNode.outOrders.push(o);
        dNode.inFrom.add(assets.src);
        dNode.inOrders.push(o);
        edges.push({ from: srcKey, to: dstKey, order: o });
      }

      // Build connected components.
      const adj = new Map<string, Set<string>>();
      nodes.forEach((_, k) => adj.set(k, new Set<string>()));
      for (const e of edges) { adj.get(e.from)!.add(e.to); adj.get(e.to)!.add(e.from); }

      const components: string[][] = [];
      const seen = new Set<string>();
      for (const start of nodes.keys()) {
        if (seen.has(start)) continue;
        const stack = [start], comp: string[] = [];
        while (stack.length) {
          const k = stack.pop()!;
          if (seen.has(k)) continue;
          seen.add(k); comp.push(k);
          adj.get(k)!.forEach(nb => { if (!seen.has(nb)) stack.push(nb); });
        }
        components.push(comp);
      }

      const renderComponent = (compKeys: string[]): string => {
        const inComp = new Set(compKeys);
        const compEdges = edges.filter(e => inComp.has(e.from) && inComp.has(e.to));

        // Assign depths via longest-path.
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

        const maxDepth = Math.max(...compKeys.map(k => nodes.get(k)!.depth));
        const rows: OFNode[][] = Array.from({ length: maxDepth + 1 }, () => []);
        compKeys.forEach(k => rows[nodes.get(k)!.depth].push(nodes.get(k)!));
        const rowsHtml = rows.map(row =>
          `<div class="rf-row">${row.map(nodeHtml).join('')}</div>`
        ).join('');

        const myCi = globalCi++;
        allJobs.push({ ci: myCi, edges: compEdges });
        return `<div class="rf-component" data-ci="${myCi}"><div class="rf-rows">${rowsHtml}</div></div>`;
      };

      return components.map(renderComponent).join('');
    };

    const sections: string[] = [];
    for (const [exName, exOrders] of byExchange) {
      const title = multiEx
        ? `<div class="rf-exchange-title"><i class="fa-solid fa-building-columns"></i> ${esc(exName)}</div>`
        : '';
      sections.push(`<div class="rf-exchange">${title}<div class="rf-components">${renderExchange(exOrders)}</div></div>`);
    }

    container.innerHTML = sections.join('');

    requestAnimationFrame(() => {
      allJobs.forEach(({ ci, edges }) => {
        const rowsEl = container.querySelector(`.rf-component[data-ci="${ci}"] .rf-rows`) as HTMLElement | null;
        if (rowsEl) drawArrows(rowsEl, edges);
      });
    });
    attachTooltip(container);
  }

  return { render };
})();
