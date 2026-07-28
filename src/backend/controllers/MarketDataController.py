"""Market data endpoints using Kraken public API via CCXT.

No API keys are required — all data comes from public endpoints.
"""

import time
from flask import Blueprint, request
from helper.Security import token_required, active_required
from helper.ErrorHandler import handle_error, bad_request
from helper.Helper import success_response
import ccxt

market_data_bp = Blueprint('market_data', __name__)

# How long cached asset fundamentals stay fresh. CoinGecko's free tier is rate
# limited and market caps don't move meaningfully inside ten minutes.
MARKET_INFO_TTL = 600

# Singleton public Kraken instance (no credentials needed)
_kraken: ccxt.kraken | None = None
_pairs_cache: list[dict] | None = None
_pairs_cache_ts: float = 0
PAIRS_CACHE_TTL = 3600  # 1 hour


def _get_kraken() -> ccxt.kraken:
    global _kraken
    if _kraken is None:
        _kraken = ccxt.kraken({'enableRateLimit': True})
    return _kraken


def _get_pairs_cached() -> list[dict]:
    """Return available trading pairs, cached for 1 hour."""
    global _pairs_cache, _pairs_cache_ts
    now = time.time()
    if _pairs_cache is not None and (now - _pairs_cache_ts) < PAIRS_CACHE_TTL:
        return _pairs_cache

    exchange = _get_kraken()
    exchange.load_markets(True)  # force reload
    pairs = []
    for symbol, market in exchange.markets.items():
        if not market.get('active', True):
            continue
        quote = market.get('quote', '')
        if quote in ('USD', 'USDT'):
            pairs.append({
                'symbol': symbol,
                'base': market.get('base', ''),
                'quote': quote,
            })
    pairs.sort(key=lambda p: p['base'])
    _pairs_cache = pairs
    _pairs_cache_ts = now
    return _pairs_cache


# Timeframe presets: maps UI range key → (ccxt timeframe, seconds lookback)
TIMEFRAME_MAP = {
    '1H':  ('1m',   3_600),
    '12H': ('5m',   43_200),
    '1D':  ('15m',  86_400),
    '1W':  ('1h',   7 * 86_400),
    '1M':  ('4h',   30 * 86_400),
    '3M':  ('1d',   90 * 86_400),
    '1Y':  ('1d',   365 * 86_400),
    '5Y':  ('1d',   5 * 365 * 86_400),
    'ALL': ('1w',   None),
}


def _ytd_since() -> int:
    """Millisecond timestamp of Jan 1 (UTC) of the current year."""
    import datetime
    year = datetime.datetime.now(datetime.timezone.utc).year
    jan1 = datetime.datetime(year, 1, 1, tzinfo=datetime.timezone.utc)
    return int(jan1.timestamp() * 1000)


@market_data_bp.route('/pairs', methods=['GET'])
@token_required
def pairs():
    try:
        data = _get_pairs_cached()
        return success_response(data=data)
    except Exception as e:
        return handle_error(e)


@market_data_bp.route('/ohlcv', methods=['GET'])
@token_required
def ohlcv():
    try:
        symbol = request.args.get('symbol', '').strip()
        range_key = request.args.get('range', '1D').strip().upper()

        if not symbol:
            return bad_request("symbol query parameter is required")

        exchange = _get_kraken()
        exchange.load_markets()

        if symbol not in exchange.markets:
            return bad_request(f"Unknown symbol: {symbol}")

        if range_key == 'YTD':
            timeframe = '1d'
            since = _ytd_since()
        elif range_key in TIMEFRAME_MAP:
            timeframe, lookback = TIMEFRAME_MAP[range_key]
            since = int((time.time() - lookback) * 1000) if lookback is not None else None
        else:
            return bad_request(f"Invalid range: {range_key}. Use 1D, 1W, 1M, 3M, YTD, 1Y, 5Y, or ALL")

        candles = exchange.fetch_ohlcv(symbol, timeframe=timeframe, since=since, limit=1000)
        # Each candle: [timestamp, open, high, low, close, volume]
        data = [
            {
                'time': int(c[0] / 1000),  # seconds for lightweight-charts
                'open': c[1],
                'high': c[2],
                'low': c[3],
                'close': c[4],
                'volume': c[5],
            }
            for c in candles
        ]
        return success_response(data=data)
    except Exception as e:
        return handle_error(e)


# ---------------------------------------------------------------------------
# Holdings detail
#
# Exchange APIs describe a market (price, spread, volume); they say nothing
# about the asset behind it (market cap, supply, all-time high). These endpoints
# join the two: balances and prices come from the user's exchange, fundamentals
# from CoinGecko, cached per symbol in asset_market_info.
# ---------------------------------------------------------------------------

def _load_fundamentals(symbols: list[str]) -> tuple[dict, bool, int]:
    """Fundamentals for *symbols*, keyed by ticker.

    Returns ``(by_symbol, live, stale_seconds)``. ``live`` is False when the
    provider couldn't be reached and the values came out of the cache instead;
    ``stale_seconds`` is the age of the oldest served entry.
    """
    from controllers.MarketInfoDbContext import MarketInfoDbContext
    from helper import coingecko

    by_symbol: dict[str, dict] = {}
    needed: dict[str, str] = {}       # coin_id -> symbol
    unresolved: list[str] = []

    for symbol in symbols:
        if coingecko.is_fiat(symbol):
            continue
        cached = MarketInfoDbContext.get_snapshot(symbol, MARKET_INFO_TTL)
        if cached:
            by_symbol[symbol] = cached
            continue
        coin_id = MarketInfoDbContext.get_coin_id(symbol) or coingecko.SYMBOL_TO_ID.get(symbol)
        if coin_id:
            needed[coin_id] = symbol
        elif not MarketInfoDbContext.is_unresolvable(symbol):
            unresolved.append(symbol)

    live = True
    stale_seconds = 0

    # Identify tickers we've never seen. One search each, then remembered — a
    # miss is remembered too, so an unlisted token isn't searched every load.
    for symbol in unresolved:
        try:
            coin_id = coingecko.lookup_coin_id(symbol)
        except coingecko.CoinGeckoError:
            live = False
            continue
        MarketInfoDbContext.set_coin_id(symbol, coin_id)
        if coin_id:
            needed[coin_id] = symbol

    if needed:
        try:
            fetched = coingecko.fetch_markets(list(needed.keys()))
            for coin_id, payload in fetched.items():
                symbol = needed.get(coin_id)
                if not symbol:
                    continue
                MarketInfoDbContext.set_snapshot(symbol, coin_id, payload)
                by_symbol[symbol] = payload
        except coingecko.CoinGeckoError as e:
            print(f"[MARKET] CoinGecko unavailable ({e}) — serving cached fundamentals")
            live = False

    # Anything still missing: fall back to whatever's cached, however old.
    for symbol in symbols:
        if symbol in by_symbol or coingecko.is_fiat(symbol):
            continue
        payload, age = MarketInfoDbContext.get_snapshot_any_age(symbol)
        if payload:
            by_symbol[symbol] = payload
            stale_seconds = max(stale_seconds, age)

    return by_symbol, live, stale_seconds


def _user_portfolios(user_id: int, conn_arg: str) -> tuple[list, list]:
    """Return ``(rows, errors)`` where rows are per-connection positions."""
    from controllers.ExchangeConnectionDbContext import ExchangeConnectionDbContext
    from helper.ExchangeRegistry import get_user_exchange
    from helper.ExchangeClient import get_portfolio

    if conn_arg and conn_arg.lower() != 'all':
        try:
            conn_id = int(conn_arg)
        except ValueError:
            return [], ["Invalid connection id"]
        connection = ExchangeConnectionDbContext.get_connection(conn_id, user_id)
        connections = [connection] if connection and connection.get('is_validated') else []
    else:
        connections = ExchangeConnectionDbContext.get_validated_connections_by_user(user_id)

    rows, errors = [], []
    for connection in connections:
        try:
            exchange = get_user_exchange(user_id, connection['id'])
            portfolio = get_portfolio(exchange)
        except Exception as e:
            errors.append(f"{connection.get('label') or connection['exchange_name']}: {e}")
            continue
        label = connection.get('label')
        if not label or label == 'Default':
            label = connection['exchange_name'].title()
        for position in portfolio.get('positions', []):
            rows.append({
                'asset': str(position['asset']).upper(),
                'amount': float(position['amount']),
                'usd_value': float(position['usd_value']),
                'connection_id': connection['id'],
                'exchange_label': label,
            })
    return rows, errors


@market_data_bp.route('/holdings', methods=['GET'])
@token_required
@active_required
def holdings():
    """Every held asset with its fundamentals, for the Holdings page.

    ``conn_id`` selects one connection; the default aggregates every validated
    one, summing an asset held in more than one place.
    """
    try:
        from helper import coingecko

        rows, errors = _user_portfolios(request.user_id, request.args.get('conn_id', 'all'))

        merged: dict[str, dict] = {}
        for row in rows:
            entry = merged.setdefault(row['asset'], {
                'asset': row['asset'],
                'amount': 0.0,
                'usd_value': 0.0,
                'venues': [],
            })
            entry['amount'] += row['amount']
            entry['usd_value'] += row['usd_value']
            entry['venues'].append({
                'exchange_label': row['exchange_label'],
                'connection_id': row['connection_id'],
                'amount': row['amount'],
                'usd_value': row['usd_value'],
            })

        total_usd = sum(e['usd_value'] for e in merged.values())
        info, live, stale_seconds = _load_fundamentals(list(merged.keys()))

        positions = []
        for entry in merged.values():
            fundamentals = info.get(entry['asset'])
            unit_price = entry['usd_value'] / entry['amount'] if entry['amount'] else 0.0
            change_24h = (fundamentals or {}).get('change_24h_pct')

            positions.append({
                **entry,
                'is_cash': coingecko.is_fiat(entry['asset']),
                'unit_price': unit_price,
                'weight_percent': (entry['usd_value'] / total_usd * 100.0) if total_usd else 0.0,
                # What the last day actually did to this position, in dollars —
                # a percentage on its own doesn't say whether it mattered.
                'value_change_24h_usd': (
                    entry['usd_value'] - entry['usd_value'] / (1 + change_24h / 100.0)
                    if change_24h not in (None, -100) else None
                ),
                'info': fundamentals,
            })

        positions.sort(key=lambda p: p['usd_value'], reverse=True)

        return success_response(data={
            'total_usd': total_usd,
            'positions': positions,
            'market_data_live': live,
            'market_data_stale_seconds': stale_seconds,
            'errors': errors,
        })

    except Exception as e:
        return handle_error(e)


def _exchange_history(symbol: str) -> dict:
    """Long-range highs and lows from public Kraken candles.

    This is the exchange's own record, not the asset's — Kraken's history starts
    when Kraken listed the pair — so it's reported separately from CoinGecko's
    all-time high rather than blended into it.
    """
    out: dict = {
        'available': False, 'pair': None,
        'high': None, 'high_date': None, 'low': None, 'low_date': None,
        'high_52w': None, 'low_52w': None, 'since': None,
        'min_order_amount': None, 'min_order_cost': None,
        'maker_fee': None, 'taker_fee': None,
    }

    exchange = _get_kraken()
    exchange.load_markets()
    pair = next((f"{symbol}/{quote}" for quote in ('USD', 'USDT', 'USDC')
                 if f"{symbol}/{quote}" in exchange.markets), None)
    if not pair:
        return out

    market = exchange.markets[pair]
    limits = market.get('limits', {})
    out.update({
        'pair': pair,
        'min_order_amount': (limits.get('amount') or {}).get('min'),
        'min_order_cost': (limits.get('cost') or {}).get('min'),
        'maker_fee': market.get('maker'),
        'taker_fee': market.get('taker'),
    })

    try:
        candles = exchange.fetch_ohlcv(pair, timeframe='1w', limit=1000)
    except Exception as e:
        print(f"[MARKET] No candle history for {pair}: {e}")
        return out
    if not candles:
        return out

    def iso(ms) -> str:
        import datetime
        return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).date().isoformat()

    peak = max(candles, key=lambda c: c[2] or 0)
    trough = min(candles, key=lambda c: c[3] if c[3] else float('inf'))
    recent = candles[-52:]

    out.update({
        'available': True,
        'high': peak[2],
        'high_date': iso(peak[0]),
        'low': trough[3],
        'low_date': iso(trough[0]),
        'high_52w': max((c[2] for c in recent if c[2]), default=None),
        'low_52w': min((c[3] for c in recent if c[3]), default=None),
        'since': iso(candles[0][0]),
    })
    return out


@market_data_bp.route('/asset/<symbol>', methods=['GET'])
@token_required
@active_required
def asset_detail(symbol):
    """Fundamentals plus exchange-side history for one asset."""
    try:
        from helper import coingecko

        symbol = (symbol or '').strip().upper()
        if not symbol:
            return bad_request("symbol is required")
        if coingecko.is_fiat(symbol):
            return success_response(data={
                'symbol': symbol, 'is_cash': True,
                'info': None, 'exchange': None, 'market_data_live': True,
            })

        info, live, stale_seconds = _load_fundamentals([symbol])
        fundamentals = info.get(symbol)
        if not fundamentals and not live:
            return success_response(data={
                'symbol': symbol, 'is_cash': False, 'info': None,
                'exchange': _exchange_history(symbol),
                'market_data_live': False, 'market_data_stale_seconds': stale_seconds,
            })
        if not fundamentals:
            # Reached the provider, but it doesn't list this ticker.
            return success_response(data={
                'symbol': symbol, 'is_cash': False, 'info': None,
                'exchange': _exchange_history(symbol),
                'market_data_live': True, 'market_data_stale_seconds': 0,
                'unlisted': True,
            })

        return success_response(data={
            'symbol': symbol,
            'is_cash': False,
            'info': fundamentals,
            'exchange': _exchange_history(symbol),
            'market_data_live': live,
            'market_data_stale_seconds': stale_seconds,
        })

    except Exception as e:
        return handle_error(e)


@market_data_bp.route('/ticker', methods=['GET'])
@token_required
def ticker():
    try:
        symbol = request.args.get('symbol', '').strip()
        if not symbol:
            return bad_request("symbol query parameter is required")

        exchange = _get_kraken()
        exchange.load_markets()

        if symbol not in exchange.markets:
            return bad_request(f"Unknown symbol: {symbol}")

        t = exchange.fetch_ticker(symbol)
        data = {
            'symbol': symbol,
            'last': t.get('last'),
            'high': t.get('high'),
            'low': t.get('low'),
            'change': t.get('change'),
            'percentage': t.get('percentage'),
            'volume': t.get('baseVolume'),
        }
        return success_response(data=data)
    except Exception as e:
        return handle_error(e)
