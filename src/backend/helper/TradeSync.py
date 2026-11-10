"""Chunked backfill of executed fills into ``trade_history``.

The same shape as :mod:`helper.TransferSync`, deliberately: one call does a
bounded slice of work, commits it together with the cursor that covers it, and
reports ``complete: false`` when there is more. The caller loops. It shares
that module's per-connection lock — so a trade sync and a transfer sync can
never race on the same API key — and its error classifier.

Three fetch strategies, chosen per exchange in the registry:

* ``window`` (Kraken, Coinbase): one endpoint returns fills for every pair, so
  history is walked forward in time windows. Kraken pages inside a window with
  ``ofs``; Coinbase lets ccxt follow the response cursor.
* ``per_symbol`` (Binance): fills are only returned per market, so each
  candidate market is its own resumable scope, paged by trade id.
* ``orders`` (Robinhood): no fills endpoint; filled orders stand in.

USD valuation is a second pass. A fill on a USD or stablecoin pair is priced
on insert (a quote unit is worth $1). Anything else — a BTC-quoted pair, a fee
paid in BNB — is saved first and priced afterwards from historical candles,
inside the same time budget, so a page of fills is never lost to a slow price
lookup and a lookup that has no answer is recorded as such rather than retried
forever.
"""

import json
import time
import traceback

import ccxt

from controllers.TradeDbContext import TradeDbContext
from controllers.TransferDbContext import TransferDbContext
from helper.CostBasis import DOLLAR_ASSETS, CASH_ASSETS
from helper.ExchangeClient import (fetch_trades_page, get_usd_price_at,
                                   normalize_filled_order, normalize_trade)
from helper.ExchangeRegistry import (SUPPORTED_EXCHANGES, get_connection_row,
                                     get_trade_history_config,
                                     get_user_exchange, supports_trade_history)
from helper.TransferSync import (BUDGET_SECONDS, MIN_BISECT_SECONDS, OVERLAP_SECONDS,
                                 _classify, _lock_for)

#: Scope name for exchanges whose history is one stream. Binance also uses it,
#: as the row that holds the list of markets still to walk this pass.
ALL = '*'

#: Quotes paired with each candidate asset when guessing Binance markets.
BINANCE_QUOTES = ('USDT', 'USDC', 'FDUSD', 'BTC', 'ETH', 'BNB')


class _Disabled(Exception):
    """A failure that will recur until a human fixes something (a key scope)."""


# ---------------------------------------------------------------------------
# Pricing
# ---------------------------------------------------------------------------

def _price_on_insert(row: dict) -> dict:
    """Fill in whatever valuation needs no API call; leave the rest NULL.

    ``usd_price_source`` stays NULL only when a lookup is still needed, which
    is what the pricing pass selects on.
    """
    quote = row['quote']
    fee_ccy = (row.get('fee_currency') or '').upper()
    third_party_fee = bool(row.get('fee_amount_num')) and fee_ccy and fee_ccy not in (
        row['base'], quote) and fee_ccy not in DOLLAR_ASSETS

    if quote in DOLLAR_ASSETS:
        row['quote_usd_price'] = 1.0
        if not third_party_fee:
            row['usd_price_source'] = 'peg'
    if fee_ccy in DOLLAR_ASSETS and row.get('fee_amount_num'):
        row['fee_usd_value'] = float(row['fee_amount_num'])
    return row


class _Pricer:
    """Hour-bucketed USD lookups with a per-call cache.

    A busy BTC-quoted market can have hundreds of fills in one hour; they all
    share one candle, so they cost one request.
    """

    def __init__(self, exchange):
        self.exchange = exchange
        self.cache: dict[tuple[str, int], tuple[float, str] | None] = {}

    def usd(self, asset: str, ts: int) -> tuple[float, str] | None:
        asset = asset.upper()
        if asset in DOLLAR_ASSETS:
            return 1.0, 'peg'
        key = (asset, int(ts) - int(ts) % 3600)
        if key not in self.cache:
            self.cache[key] = get_usd_price_at(self.exchange, asset, ts)
        return self.cache[key]


def _price_pending(exchange, conn_id: int, deadline: float) -> bool:
    """Price stored fills that still need a lookup. True when none are left."""
    pricer = _Pricer(exchange)
    while time.time() < deadline:
        rows = TradeDbContext.get_unpriced(conn_id, limit=100)
        if not rows:
            return True
        for row in rows:
            if time.time() >= deadline:
                return False
            ts = int(row['occurred_at'] or 0)
            quote_price, source = row.get('quote_usd_price'), 'peg'
            if quote_price is None:
                found = pricer.usd(row['quote'], ts)
                quote_price, source = (found if found else (None, 'unavailable'))

            fee_usd = None
            fee = float(row.get('fee_amount_num') or 0.0)
            fee_ccy = (row.get('fee_currency') or '').upper()
            if fee > 0 and fee_ccy and fee_ccy not in (row['base'], row['quote']):
                found = pricer.usd(fee_ccy, ts)
                if found:
                    fee_usd = fee * found[0]
                elif source == 'peg':
                    source = 'unavailable'
            TradeDbContext.set_pricing(row['id'], quote_price, fee_usd, source)
    return TradeDbContext.count_unpriced(conn_id) == 0


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

def _load_cursor(state: dict) -> dict:
    try:
        value = json.loads(state.get('cursor') or 'null')
    except (TypeError, ValueError):
        value = None
    return value if isinstance(value, dict) else {}


def _window_start(state: dict, config: dict, now: int) -> int:
    """Where a fresh pass starts: the watermark, rewound once the backfill is done.

    ``start`` on Kraken is exclusive and fills can land slightly out of order,
    so an incremental pass re-reads the last day; the dedupe key absorbs it.
    """
    epoch = int(state.get('history_epoch') or config.get('history_epoch') or 0)
    base = int(state.get('synced_through') or epoch)
    if state.get('backfill_complete'):
        base -= OVERLAP_SECONDS
    return max(min(base, now), epoch)


def _normalize_all(raw: list[dict], lo: int | None = None, hi: int | None = None) -> list[dict]:
    rows = []
    for item in raw:
        ts = item.get('timestamp')
        # Re-filtered client-side for the same reason fetch_transfer_window
        # does: exchanges round window edges differently.
        if ts is not None and lo is not None and not (lo * 1000 <= ts <= hi * 1000):
            continue
        row = normalize_trade(item)
        if row is not None:
            rows.append(_price_on_insert(row))
    return rows


def _sync_window(exchange, user_id: int, conn_id: int, exchange_name: str,
                 config: dict, deadline: float) -> dict:
    state = TradeDbContext.ensure_sync_state(conn_id, ALL, config['history_epoch'])
    now = int(time.time())
    cursor = _load_cursor(state)

    base_width = int(config['window_seconds'])
    start = int(cursor.get('start') or _window_start(state, config, now))
    width = int(cursor.get('width') or base_width)
    ofs = int(cursor.get('ofs') or 0)
    page_cap = int(config['page_cap'])
    pacing = config.get('page_pacing_ms', 1000) / 1000.0
    new_rows = 0

    while start < now:
        if time.time() >= deadline:
            TradeDbContext.set_cursor(conn_id, ALL, {'start': start, 'width': width, 'ofs': ofs})
            return {'complete': False, 'new_rows': new_rows}

        end = min(start + width, now)
        if config.get('paging') == 'ofs':
            raw = fetch_trades_page(exchange, None, start * 1000, None,
                                    {'until': end * 1000, 'ofs': ofs})
            rows = _normalize_all(raw, start, end)
            if len(raw) >= page_cap:
                # More in this window. Saved with the offset that follows it,
                # so an interruption resumes mid-window rather than restarting.
                ofs += len(raw)
                new_rows += TradeDbContext.save_page(
                    conn_id, user_id, exchange_name, rows, ALL,
                    cursor={'start': start, 'width': width, 'ofs': ofs})
                time.sleep(pacing)
                continue
        else:
            raw = fetch_trades_page(exchange, None, start * 1000, None, {
                'until': end * 1000,
                'paginate': True,
                'paginationCalls': int(config.get('pagination_calls') or 10),
            })
            # Bisect rather than trust a window that came back full: the
            # pagination cap may have cut it short.
            if len(raw) >= page_cap and (end - start) // 2 >= MIN_BISECT_SECONDS:
                width = (end - start) // 2
                continue
            rows = _normalize_all(raw, start, end)

        new_rows += TradeDbContext.save_page(
            conn_id, user_id, exchange_name, rows, ALL, synced_through=end,
            cursor={'start': end, 'width': base_width, 'ofs': 0})
        start, width, ofs = end, base_width, 0
        if start < now:
            time.sleep(pacing)

    TradeDbContext.finish_pass(conn_id, ALL, now)
    return {'complete': True, 'new_rows': new_rows}


def _binance_symbols(exchange, conn_id: int) -> list[str]:
    """Spot markets worth asking Binance about for this account.

    Binance answers fills only per market and there are thousands, so this is a
    deliberate guess: every asset the account holds now, has moved in or out,
    or has traded before, crossed with the common quotes, kept only where the
    market exists. A coin bought and fully sold without ever being held at a
    sync or transferred can still be missed — the page says so.
    """
    exchange.load_markets()
    assets: set[str] = set()
    try:
        balance = exchange.fetch_balance() or {}
        for asset, amount in (balance.get('total') or {}).items():
            if amount:
                assets.add(str(asset).upper())
    except Exception:
        pass
    assets.update(TransferDbContext.get_assets_for_connection(conn_id))
    assets.update(TradeDbContext.get_seen_bases(conn_id))

    symbols = set()
    for asset in assets:
        if asset in CASH_ASSETS and asset not in BINANCE_QUOTES:
            continue
        for quote in BINANCE_QUOTES:
            if asset == quote:
                continue
            for symbol in (f"{asset}/{quote}", f"{quote}/{asset}"):
                market = (exchange.markets or {}).get(symbol)
                if market and market.get('spot'):
                    symbols.add(symbol)
    return sorted(symbols)


def _sync_per_symbol(exchange, user_id: int, conn_id: int, exchange_name: str,
                     config: dict, deadline: float) -> dict:
    meta = TradeDbContext.ensure_sync_state(conn_id, ALL, config['history_epoch'])
    now = int(time.time())
    cursor = _load_cursor(meta)

    # The market list is rebuilt at the start of every pass (one balance call)
    # so a coin bought since the last pass is picked up; within a pass the
    # remaining queue is persisted, so an interrupted pass resumes.
    queue = cursor.get('queue')
    if not queue:
        queue = _binance_symbols(exchange, conn_id)
        cursor = {'queue': queue, 'built_at': now, 'symbols': len(queue)}
        TradeDbContext.set_cursor(conn_id, ALL, cursor)

    page_cap = int(config['page_cap'])
    pacing = config.get('page_pacing_ms', 300) / 1000.0
    new_rows = 0

    while queue:
        if time.time() >= deadline:
            TradeDbContext.set_cursor(conn_id, ALL, {**cursor, 'queue': queue})
            return {'complete': False, 'new_rows': new_rows}

        symbol = queue[0]
        state = TradeDbContext.ensure_sync_state(conn_id, symbol, config['history_epoch'])
        if state.get('disabled'):
            queue.pop(0)
            continue
        from_id = int(_load_cursor(state).get('from_id') or 0)
        try:
            raw = fetch_trades_page(exchange, symbol, None, page_cap, {'fromId': from_id})
        except ccxt.BadSymbol as e:
            TradeDbContext.set_disabled(conn_id, symbol, f"Market not available: {e}")
            queue.pop(0)
            continue

        rows = _normalize_all(raw)
        ids = [int(r['id']) for r in raw if str(r.get('id') or '').isdigit()]
        next_id = (max(ids) + 1) if ids else from_id
        new_rows += TradeDbContext.save_page(conn_id, user_id, exchange_name, rows,
                                             symbol, synced_through=now,
                                             cursor={'from_id': next_id})
        if len(raw) < page_cap:
            TradeDbContext.finish_pass(conn_id, symbol, now, cursor={'from_id': next_id})
            queue.pop(0)
        time.sleep(pacing)

    # Every market walked: close the pass. The next one rebuilds the list, and
    # each market resumes from its own last trade id, so it stays cheap.
    TradeDbContext.finish_pass(conn_id, ALL, now,
                               cursor={'queue': None, 'built_at': cursor.get('built_at'),
                                       'symbols': cursor.get('symbols')})
    return {'complete': True, 'new_rows': new_rows}


def _sync_orders(exchange, user_id: int, conn_id: int, exchange_name: str,
                 config: dict, deadline: float) -> dict:
    state = TradeDbContext.ensure_sync_state(conn_id, ALL, config['history_epoch'])
    now = int(time.time())
    since = _window_start(state, config, now)
    orders = exchange.fetch_closed_orders(None, since * 1000) or []
    rows = []
    for order in orders:
        rows.extend(_price_on_insert(r) for r in normalize_filled_order(order))
    new_rows = TradeDbContext.save_page(conn_id, user_id, exchange_name, rows, ALL,
                                        synced_through=now)
    TradeDbContext.finish_pass(conn_id, ALL, now)
    return {'complete': True, 'new_rows': new_rows}


_STRATEGIES = {
    'window': _sync_window,
    'per_symbol': _sync_per_symbol,
    'orders': _sync_orders,
}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def sync_connection(user_id: int, conn_id: int,
                    budget_seconds: int = BUDGET_SECONDS) -> dict:
    """Run one bounded slice of trade sync for a connection.

    Returns ``{'complete', 'new_rows', 'already_running', 'error', ...}``;
    ``complete: False`` means "call again", not failure.
    """
    row = get_connection_row(user_id, conn_id)
    if not row:
        return {'complete': True, 'new_rows': 0, 'error': 'Connection not found'}

    exchange_name = row['exchange_name']
    config = get_trade_history_config(exchange_name)
    if not supports_trade_history(exchange_name) or not config:
        return {'complete': True, 'new_rows': 0, 'unsupported': True}
    if not row.get('is_validated'):
        return {'complete': True, 'new_rows': 0,
                'error': 'API keys have not been validated.'}

    meta = TradeDbContext.ensure_sync_state(conn_id, ALL, config['history_epoch'])
    if meta.get('disabled'):
        return {'complete': True, 'new_rows': 0, 'skipped': 'disabled'}

    lock = _lock_for(conn_id)
    if not lock.acquire(blocking=False):
        return {'complete': False, 'new_rows': 0, 'already_running': True}

    deadline = time.time() + budget_seconds
    try:
        try:
            exchange = get_user_exchange(user_id, conn_id)
        except Exception as e:
            # Usually keys that can't be decrypted (SECRET_KEY changed) — a
            # retry won't fix that, so say what to do instead of looping.
            print(f"[TRADES] conn {conn_id}: could not build client: {e!r}")
            display = SUPPORTED_EXCHANGES.get(exchange_name, {}).get('name', exchange_name)
            display = display.replace(' (Beta)', '')
            return {'complete': False, 'new_rows': 0,
                    'error': (f"Could not load the {display} API keys "
                              f"({type(e).__name__}). Re-enter and re-validate them "
                              f"in your profile.")}

        try:
            if not callable(getattr(exchange, 'fetch_my_trades', None)) \
                    and config['strategy'] != 'orders':
                raise _Disabled(f"{exchange_name} does not expose trade history.")
            result = _STRATEGIES[config['strategy']](
                exchange, user_id, conn_id, exchange_name, config, deadline)
        except _Disabled as e:
            TradeDbContext.set_disabled(conn_id, ALL, str(e))
            return {'complete': True, 'new_rows': 0, 'skipped': 'unsupported'}
        except Exception as e:
            permanent, message = _classify(e, exchange_name, 'trade')
            if permanent:
                TradeDbContext.set_disabled(conn_id, ALL, message)
            else:
                TradeDbContext.mark_sync_error(conn_id, ALL, message)
                traceback.print_exc()
            print(f"[TRADES] conn {conn_id}: {message}")
            return {'complete': permanent, 'new_rows': 0, 'error': message}

        # Pricing failures are never fatal: an unpriced fill is stored and
        # flagged, and the engine leaves its value blank rather than guessing.
        priced = True
        try:
            priced = _price_pending(exchange, conn_id, max(deadline, time.time() + 2))
        except Exception as e:
            print(f"[TRADES] conn {conn_id} pricing: {e}")
        return {'complete': result['complete'] and priced,
                'new_rows': result['new_rows']}
    finally:
        lock.release()
