/**
 * OrderFlow — open orders drawn as the same left-to-right flow map as the
 * Automations chart (FlowMap, services/flowmap.ts).
 *
 * Each order is a line from the coin it spends to the coin it brings in:
 *   BUY  BASE/QUOTE  →  QUOTE ──▶ BASE   (spending quote to receive base)
 *   SELL BASE/QUOTE  →  BASE  ──▶ QUOTE  (spending base to receive quote)
 * with a chip for the order (side, amount and limit price), green for buys and
 * red for sells, as in the orders table. A coin that only receives shows
 * roughly how much is coming in. Clicking a chip shows the order in plain
 * English underneath.
 *
 * Used by the Open Orders page (Flow tab) and the Overview's Flow widget.
 */
const OrderFlow = (() => {
  interface RenderOpts {
    /** Shows a button in the details strip (e.g. "Open in Open Orders"). */
    onOpen?: (order: any) => void;
    openLabel?: string;
  }

  const STABLE = /^(USD|USDT|USDC|DAI|BUSD|TUSD|USDP|FDUSD|USDD|GUSD|PYUSD|FIDD)$/;
  const esc = FlowMap.esc;

  /** Split a CCXT symbol like "BTC/USD" (or "BTC/USD:USD") into [base, quote]. */
  function splitPair(pair: string): [string, string] {
    const idx = pair.indexOf('/');
    if (idx === -1) return [pair.toUpperCase(), ''];
    return [pair.slice(0, idx).toUpperCase(), pair.slice(idx + 1).split(':')[0].toUpperCase()];
  }

  /** "12,345.6" without trailing zeros. */
  function num(v: any): string {
    const n = Number(v);
    if (!isFinite(n)) return String(v ?? '?');
    return n.toLocaleString(undefined, { maximumFractionDigits: n >= 1 ? 2 : 8 });
  }

  /** An amount of a coin; dollars for stablecoins. */
  function money(amount: number, asset: string): string {
    return STABLE.test(asset)
      ? `$${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : `${num(amount)} ${asset}`;
  }

  const priceOf = (o: any): number => { const p = Number(o.price); return p > 0 ? p : 0; };

  /** What the order brings in when it fills: the quote coin for a sell, the base for a buy. */
  function received(o: any): number | null {
    const vol = Number(o.volume);
    if (!(vol > 0)) return null;
    if (o.side === 'sell') return priceOf(o) ? vol * priceOf(o) : null; // market: unknown
    return vol;
  }

  function chipText(o: any, base: string, quote: string): string {
    const amt = `${num(o.volume)} ${base}`;
    if (!priceOf(o)) return `${amt} · market`;
    return STABLE.test(quote) ? `${amt} @ $${num(priceOf(o))}` : `${amt} @ ${num(priceOf(o))} ${quote}`;
  }

  function describe(o: any, base: string, quote: string): string {
    const buy = o.side === 'buy';
    const head = buy ? `Buy ${num(o.volume)} ${base} with ${quote}` : `Sell ${num(o.volume)} ${base} for ${quote}`;
    const p = priceOf(o);
    if (!p) return `${head} at the market price.`;
    const total = Number(o.volume) * p;
    return `${head} at ${num(p)} ${quote} each${total > 0 ? `, ${money(total, quote)} in all` : ''}.`;
  }

  function relTime(ms: any): string {
    const t = Number(ms);
    if (!(t > 0)) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400 * 2) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }

  function metaText(o: any): string {
    const parts: string[] = [];
    const status = String(o.status || 'open');
    parts.push(status.charAt(0).toUpperCase() + status.slice(1));
    const vol = Number(o.volume), filled = Number(o.filled);
    if (vol > 0 && filled > 0) parts.push(`${Math.min(100, Math.round((filled / vol) * 100))}% filled`);
    if (o.type) parts.push(String(o.type));
    const when = relTime(o.opentm);
    if (when) parts.push(`placed ${when}`);
    return parts.join(' · ');
  }

  function render(container: HTMLElement, orders: any[], opts: RenderOpts = {}): void {
    if (!container) return;
    // The old circle chart's hover tooltip lived on <body>; drop it if present.
    document.getElementById('of-tooltip')?.remove();

    const groupNames = new Map<string, string>();
    const items: FlowItem[] = [];
    (orders || []).forEach((o, i) => {
      const [base, quote] = splitPair(o.pair || '');
      if (!base || !quote || (o.side !== 'buy' && o.side !== 'sell')) return;
      const group = String(o.connectionId ?? o.exchangeName ?? 'exchange');
      groupNames.set(group, o.exchangeName || 'Exchange');
      const [from, to] = o.side === 'buy' ? [quote, base] : [base, quote];
      const side = o.side === 'buy' ? 'BUY' : 'SELL';
      items.push({
        id: `${group}:${o.id || `i${i}`}`,
        group,
        src: { key: 'A:' + from, label: from, kind: 'asset' },
        dst: { key: 'A:' + to, label: to, kind: 'asset' },
        tone: o.side,
        chipTag: side,
        chipText: chipText(o, base, quote),
        title: `${side} ${o.pair}${o.id ? ` · ${o.id}` : ''}\n${describe(o, base, quote)}`,
        data: o,
      });
    });

    FlowMap.render(container, items, {
      emptyText: 'No open orders to chart.',
      noun: ['order', 'orders'],
      groupName: (g) => groupNames.get(g) || 'Exchange',
      // A coin that only receives shows roughly how much is on its way.
      placeSub: (role, inItems) => {
        if (role !== 'terminal' || !inItems.length) return null;
        const label = inItems[0].dst.label;
        const amounts = inItems.map(it => received(it.data));
        const known = amounts.filter((a): a is number => a != null);
        if (!known.length) return null;
        const approx = known.length < amounts.length ? '≥ ' : '≈ ';
        return approx + money(known.reduce((s, a) => s + a, 0), label);
      },
      detailHtml: (item, ctx) => {
        const o = item.data;
        const [base, quote] = splitPair(o.pair || '');
        return `
          <span class="rf-detail-kind rf-k-${item.tone}">${o.side === 'buy' ? 'Buy order' : 'Sell order'}</span>
          <div class="rf-detail-text">
            <strong>${esc(o.pair)}${ctx.multiGroup ? ` <span class="rf-detail-ex">· ${esc(ctx.groupName)}</span>` : ''}</strong>
            <span>${esc(describe(o, base, quote))}</span>
          </div>
          <span class="rf-detail-meta">${esc(metaText(o))}</span>
          ${opts.onOpen ? `<div class="rf-detail-actions"><button type="button" class="btn-secondary" data-rf-action="open">${esc(opts.openLabel || 'Open')}</button></div>` : ''}`;
      },
      onAction: (action, item) => { if (action === 'open') opts.onOpen?.(item.data); },
    });
  }

  return { render };
})();
