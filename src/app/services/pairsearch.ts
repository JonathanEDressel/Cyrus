/**
 * Trading-pair search shared by the Live Data widget and the Charts page.
 * "xrp cad", "XRP/CAD" and "xrpcad" all find XRP/CAD; a single word like
 * "btc" matches the coin or the currency it's priced in. Entries with a
 * `name` (stocks) also match on it, so "apple" finds AAPL.
 *
 * Exact matches on the symbol or base come first, then symbols that start
 * with the query; otherwise the list keeps its order.
 */
class PairSearch {
  static filter<T extends { symbol: string; base: string; quote?: string; name?: string }>(
    pairs: T[], query: string, exclude?: Set<string>,
  ): T[] {
    const q = query.toLowerCase().trim();
    const words = q.split(/[\s/\-]+/).filter(Boolean);
    const squashed = q.replace(/[\s/\-]+/g, '');
    const matches = (p: T): boolean => {
      const sym = String(p.symbol).toLowerCase();
      if (q.length >= 2 && p.name && p.name.toLowerCase().includes(q)) return true;
      if (words.length > 1) {
        const [b, qt] = [String(p.base).toLowerCase(), String(p.quote || '').toLowerCase()];
        return b.startsWith(words[0]) && qt.startsWith(words[1]);
      }
      return sym.includes(q) || sym.replace('/', '').includes(squashed);
    };
    const found = pairs.filter((p) => !exclude?.has(p.symbol) && (!q || matches(p)));
    if (!q) return found;

    const rank = (p: T): number => {
      const sym = String(p.symbol).toLowerCase();
      const base = String(p.base).toLowerCase();
      if (sym === q || base === q || sym.replace('/', '') === squashed) return 0;
      if (sym.startsWith(q) || base.startsWith(q)) return 1;
      return 2;
    };
    // Array.prototype.sort is stable, so ties keep the server's order.
    return found
      .map((p, i) => ({ p, r: rank(p), i }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.p);
  }
}
