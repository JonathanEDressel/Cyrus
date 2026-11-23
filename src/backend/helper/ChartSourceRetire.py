"""Move saved charts and alerts off chart sources that were dropped.

The Charts page used to offer OKX, Crypto.com, Gate and Gemini as candle
feeds. They were cut down to Coinbase, Kraken and KuCoin (plus Stocks): Kraken
can't scroll back, Coinbase can, and KuCoin covers the small coins. Anything
saved against a retired source is re-pointed at the first kept source that
lists the same pair (falling back to the coin's USD/USDT/USDC pair).

It needs the kept exchanges' market lists, so it runs from the worker rather
than as a startup migration: if those can't be loaded (offline), nothing is
changed and it tries again next cycle. It runs every cycle because an open
Charts page could re-save a chart with its old state; when there's nothing
to move it costs one small query per table.
"""

import json

from helper.Helper import execute_query_all, execute_non_query
from helper.PublicMarket import get_public

RETIRED_SOURCES = ('okx', 'cryptocom', 'gate', 'gemini')
# Where moved items go, in order of preference.
TARGETS = ('coinbase', 'kraken', 'kucoin')
_IN = ','.join('?' * len(RETIRED_SOURCES))


def _load_targets() -> dict[str, dict] | None:
    markets = {}
    for t in TARGETS:
        try:
            ex = get_public(t)
            ex.load_markets()
            markets[t] = ex.markets or {}
        except Exception as e:
            print(f"[CHARTS] Couldn't load {t} markets to move retired sources ({e}); will retry")
            return None
    return markets


def _pick(symbol: str, markets: dict[str, dict]) -> tuple[str, str]:
    """(source, symbol) to use for a pair from a retired source."""
    base = symbol.split('/')[0].upper()
    candidates = [symbol] + [f"{base}/{q}" for q in ('USD', 'USDT', 'USDC') if f"{base}/{q}" != symbol]
    for cand in candidates:
        for t in TARGETS:
            if cand in markets[t]:
                return t, cand
    # Listed nowhere we keep: the pane will say so and the user can pick again.
    return TARGETS[0], symbol


def retire_chart_sources() -> int:
    """Re-point saved charts and alerts on retired sources; returns how many moved."""
    alerts = execute_query_all(
        f'SELECT id, source, symbol FROM price_alerts WHERE source IN ({_IN})', RETIRED_SOURCES)
    scripts = execute_query_all(
        f'SELECT id, source, symbol FROM script_alerts WHERE source IN ({_IN})', RETIRED_SOURCES)
    # A source id appears in the JSON as "source":"okx"; narrow with LIKE, then parse.
    like = ' OR '.join(['state LIKE ?'] * len(RETIRED_SOURCES))
    charts = execute_query_all(
        f'SELECT id, state FROM saved_charts WHERE {like}', tuple(f'%"{s}"%' for s in RETIRED_SOURCES))
    if not (alerts or scripts or charts):
        return 0

    markets = _load_targets()
    if markets is None:
        return 0

    moved = 0
    for table, rows in (('price_alerts', alerts), ('script_alerts', scripts)):
        for r in rows:
            source, symbol = _pick(r['symbol'], markets)
            execute_non_query(f'UPDATE {table} SET source = ?, symbol = ? WHERE id = ?',
                              (source, symbol, r['id']))
            moved += 1

    for r in charts:
        try:
            state = json.loads(r['state'])
        except (ValueError, TypeError):
            continue
        changed = False
        for pane in (state.get('panes') or []) if isinstance(state, dict) else []:
            if isinstance(pane, dict) and pane.get('source') in RETIRED_SOURCES:
                pane['source'], pane['symbol'] = _pick(str(pane.get('symbol') or ''), markets)
                changed = True
        if changed:
            execute_non_query('UPDATE saved_charts SET state = ? WHERE id = ?',
                              (json.dumps(state, separators=(',', ':')), r['id']))
            moved += 1

    if moved:
        print(f"[CHARTS] Moved {moved} saved chart(s)/alert(s) off retired chart sources")
    return moved
