"""Market data endpoints using Kraken public API via CCXT.

No API keys are required — all data comes from public endpoints.
"""

import threading
import time
from flask import Blueprint, request
from helper.Security import token_required, active_required, encrypt_api_key
from helper.ErrorHandler import handle_error, bad_request
from helper.Helper import success_response
from helper.ExchangeRegistry import SUPPORTED_EXCHANGES, CHART_SOURCES, source_name
from helper.PublicMarket import get_public, forget_user
from helper.StockMarket import AlpacaMarket, StockKeyError, get_alpaca_keys, verify_keys, FEED as STOCK_FEED
import ccxt

market_data_bp = Blueprint('market_data', __name__)

# How long cached asset fundamentals stay fresh. CoinGecko's free tier is rate
# limited and market caps don't move meaningfully inside ten minutes.
MARKET_INFO_TTL = 600

_pairs_cache: dict[str, tuple[float, list[dict]]] = {}
PAIRS_CACHE_TTL = 3600  # 1 hour


def _get_public(source: str, user_id: int | None = None):
    return get_public(source, user_id)


def _get_kraken() -> ccxt.kraken:
    return _get_public('kraken')


def _get_pairs_cached(source: str = 'kraken', user_id: int | None = None) -> list[dict]:
    """Return a source's active spot pairs, cached for 1 hour."""
    # Resolve the client first: for a keyed source this is what checks the
    # user has a key, so the cache never serves a user without one.
    exchange = _get_public(source, user_id)
    now = time.time()
    cached = _pairs_cache.get(source)
    if cached is not None and (now - cached[0]) < PAIRS_CACHE_TTL:
        return cached[1]

    exchange.load_markets(True)  # force reload
    # Every active spot pair, whatever it's priced in (XRP/CAD, ETH/EUR,
    # SOL/BTC...): /ohlcv and /ticker take any Kraken market. Within a coin,
    # the common quotes come first so "BTC" still leads with BTC/USD.
    quote_rank = {q: i for i, q in enumerate(('USD', 'USDT', 'USDC', 'EUR', 'CAD', 'GBP', 'AUD'))}
    pairs = []
    for symbol, market in exchange.markets.items():
        if not market.get('active', True) or market.get('spot') is False:
            continue
        base, quote = market.get('base', ''), market.get('quote', '')
        if not base or not quote:
            continue
        pair = {'symbol': symbol, 'base': base, 'quote': quote}
        if market.get('name'):
            pair['name'] = market['name']
        pairs.append(pair)
    pairs.sort(key=lambda p: (p['base'], quote_rank.get(p['quote'], len(quote_rank)), p['quote']))
    _pairs_cache[source] = (now, pairs)
    return pairs


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
        source = (request.args.get('source') or 'kraken').strip().lower()
        if source not in CHART_SOURCES:
            return bad_request(f"Unknown source: {source}")
        try:
            data = _get_pairs_cached(source, request.user_id)
        except ValueError as e:
            return bad_request(str(e))
        return success_response(data=data)
    except Exception as e:
        return handle_error(e)


# ---------------------------------------------------------------------------
# Charts page: candles by timeframe from any public chart source
# ---------------------------------------------------------------------------

CHART_TIMEFRAMES = {
    '1m': 60, '5m': 300, '15m': 900, '30m': 1_800,
    '1h': 3_600, '4h': 14_400, '1d': 86_400, '1w': 604_800,
}
CANDLE_CACHE_LATEST_TTL = 15     # the newest page moves; panes poll it
CANDLE_CACHE_HISTORY_TTL = 600   # closed bars never change
CANDLE_CACHE_MAX = 400
_candle_cache: dict[tuple, tuple[float, dict]] = {}
_candle_lock = threading.Lock()


@market_data_bp.route('/chart-sources', methods=['GET'])
@token_required
def chart_sources():
    try:
        has_stock_key = bool(get_alpaca_keys(request.user_id))
        data = [
            {
                'id': sid,
                'name': source_name(sid),
                'kind': meta.get('kind', 'crypto'),
                'requires_key': bool(meta.get('requires_key')),
                'configured': has_stock_key if meta.get('requires_key') else True,
                'can_page': meta['can_page'],
                'max_limit': meta['max_limit'],
                'timeframes': _source_timeframes(sid),
            }
            for sid, meta in CHART_SOURCES.items()
        ]
        return success_response(data=data)
    except Exception as e:
        return handle_error(e)


# Timeframes a pageable feed lacks are built from a smaller one it has
# (Coinbase has no 4h or 1w): timeframe -> (built from, bars per candle).
SYNTH_TIMEFRAMES = {'4h': ('1h', 4), '1w': ('1d', 7)}
# Weekly candles start on Monday 00:00 UTC, like the exchanges' own 1w bars
# (the Unix epoch fell on a Thursday; 1970-01-05 was a Monday).
WEEK_ANCHOR = 345_600


def _synth_base(source: str, timeframe: str, have) -> str | None:
    """The timeframe to build `timeframe` from, when the source must build it."""
    if timeframe in have or timeframe not in SYNTH_TIMEFRAMES or not CHART_SOURCES[source]['can_page']:
        return None
    base = SYNTH_TIMEFRAMES[timeframe][0]
    return base if base in have else None


def _source_timeframes(source: str) -> list[str]:
    """The chart timeframes this source serves, including ones built from smaller bars."""
    if CHART_SOURCES[source].get('requires_key'):
        have = AlpacaMarket.TIMEFRAMES  # known without a key
    else:
        have = _get_public(source).timeframes or {}
    return [tf for tf in CHART_TIMEFRAMES if tf in have or _synth_base(source, tf, have)]


def _bucket(t: int, timeframe: str) -> int:
    sec = CHART_TIMEFRAMES[timeframe]
    off = WEEK_ANCHOR if timeframe == '1w' else 0
    return (t - off) // sec * sec + off


def _synth_candles(exchange, source: str, symbol: str, timeframe: str,
                   before: int | None, limit: int) -> dict:
    """Build `limit` candles of `timeframe` ending before `before` from smaller bars."""
    base_tf, _ = SYNTH_TIMEFRAMES[timeframe]
    base_sec = CHART_TIMEFRAMES[base_tf]
    tf_sec = CHART_TIMEFRAMES[timeframe]
    page = CHART_SOURCES[source]['max_limit']
    end_s = before if before is not None else int(time.time()) + 1
    start_s = _bucket(end_s - 1, timeframe) - (limit - 1) * tf_sec

    raw: list = []
    since_s = start_s
    # Enough requests to cover the window, plus a little slack for gaps.
    for _ in range(-(-((end_s - start_s) // base_sec) // page) + 2):
        if since_s >= end_s:
            break
        rows = exchange.fetch_ohlcv(symbol, timeframe=base_tf, since=since_s * 1000, limit=page)
        rows = [r for r in rows if r[0] / 1000 >= since_s]
        if not rows:
            # Nothing traded in this stretch (or before listing): skip ahead.
            since_s += page * base_sec
            continue
        raw.extend(rows)
        since_s = int(rows[-1][0] / 1000) + base_sec

    buckets: dict[int, dict] = {}
    for c in sorted(raw, key=lambda c: c[0]):
        t = int(c[0] / 1000)
        if t < start_s or t >= end_s or c[4] is None:
            continue
        b = _bucket(t, timeframe)
        bar = buckets.get(b)
        if bar is None:
            buckets[b] = {'time': b, 'open': c[1], 'high': c[2], 'low': c[3],
                          'close': c[4], 'volume': c[5] or 0}
        else:
            bar['high'] = max(bar['high'], c[2])
            bar['low'] = min(bar['low'], c[3])
            bar['close'] = c[4]
            bar['volume'] += c[5] or 0
    candles = [buckets[k] for k in sorted(buckets)]
    return {'candles': candles, 'has_more': bool(candles)}


def _fetch_candles(source: str, symbol: str, timeframe: str, before: int | None, limit: int,
                   user_id: int | None = None) -> dict:
    """One page of candles ending before `before` (epoch s), or the latest page."""
    meta = CHART_SOURCES[source]
    tf_sec = CHART_TIMEFRAMES[timeframe]
    exchange = _get_public(source, user_id)
    have = exchange.timeframes or {}
    synth = _synth_base(source, timeframe, have)
    if timeframe not in have and not synth:
        raise ValueError(f"{source_name(source)} has no {timeframe} candles")
    exchange.load_markets()
    if symbol not in exchange.markets:
        raise ValueError(f"{symbol} isn't traded on {source_name(source)}")
    if synth:
        return _synth_candles(exchange, source, symbol, timeframe, before, limit)

    if before is None:
        raw = exchange.fetch_ohlcv(symbol, timeframe=timeframe, limit=limit)
    elif meta.get('page_by_end'):
        # Ask for the bars that end before `before`: market-hours feeds have
        # gaps, so a since-based window would come back short.
        raw = exchange.fetch_ohlcv(symbol, timeframe=timeframe, limit=limit,
                                   params={'until': before * 1000})
    elif not meta['can_page']:
        # This feed only ever serves its latest window; there's nothing older.
        return {'candles': [], 'has_more': False}
    else:
        since = (before - limit * tf_sec) * 1000
        raw = exchange.fetch_ohlcv(symbol, timeframe=timeframe, since=since, limit=limit)

    candles = []
    seen = set()
    for c in raw:
        t = int(c[0] / 1000)
        if (before is not None and t >= before) or t in seen or c[4] is None:
            continue
        seen.add(t)
        candles.append({
            'time': t, 'open': c[1], 'high': c[2], 'low': c[3],
            'close': c[4], 'volume': c[5] or 0,
        })
    candles.sort(key=lambda c: c['time'])
    has_more = bool(meta['can_page'] and candles)
    return {'candles': candles, 'has_more': has_more}


@market_data_bp.route('/candles', methods=['GET'])
@token_required
def candles():
    try:
        symbol = (request.args.get('symbol') or '').strip()
        timeframe = (request.args.get('timeframe') or '1h').strip()
        source = (request.args.get('source') or 'coinbase').strip().lower()
        before_arg = (request.args.get('before') or '').strip()
        limit_arg = (request.args.get('limit') or '').strip()

        if not symbol:
            return bad_request("symbol query parameter is required")
        if timeframe not in CHART_TIMEFRAMES:
            return bad_request(f"Invalid timeframe: {timeframe}. Use {', '.join(CHART_TIMEFRAMES)}")
        if source not in CHART_SOURCES:
            return bad_request(f"Unknown source: {source}")
        try:
            before = int(before_arg) if before_arg else None
            limit = int(limit_arg) if limit_arg else CHART_SOURCES[source]['max_limit']
        except ValueError:
            return bad_request("before and limit must be integers")
        limit = max(1, min(limit, CHART_SOURCES[source]['max_limit']))

        if CHART_SOURCES[source].get('requires_key'):
            # Checks the user has a key before anything cached is served.
            try:
                _get_public(source, request.user_id)
            except ValueError as e:
                return bad_request(str(e))

        key = (source, symbol, timeframe, before, limit)
        ttl = CANDLE_CACHE_LATEST_TTL if before is None else CANDLE_CACHE_HISTORY_TTL
        now = time.time()
        with _candle_lock:
            hit = _candle_cache.get(key)
        if hit is not None and now - hit[0] < ttl:
            return success_response(data=hit[1])

        try:
            data = _fetch_candles(source, symbol, timeframe, before, limit, request.user_id)
        except (ValueError, ccxt.BadSymbol) as e:
            return bad_request(str(e))

        with _candle_lock:
            if len(_candle_cache) >= CANDLE_CACHE_MAX:
                # Drop the oldest entries rather than tracking LRU order.
                for k, _ in sorted(_candle_cache.items(), key=lambda kv: kv[1][0])[:CANDLE_CACHE_MAX // 4]:
                    _candle_cache.pop(k, None)
            _candle_cache[key] = (now, data)
        return success_response(data=data)
    except Exception as e:
        return handle_error(e)


# ---------------------------------------------------------------------------
# Stocks source: the user's Alpaca market-data key (Profile → Exchanges).
# Write-only like the Anthropic key: it goes in encrypted and only ever comes
# back as `configured`.
# ---------------------------------------------------------------------------

@market_data_bp.route('/stocks/status', methods=['GET'])
@token_required
def stocks_status():
    try:
        return success_response(data={
            'configured': bool(get_alpaca_keys(request.user_id)),
            'feed': STOCK_FEED,
        })
    except Exception as e:
        return handle_error(e)


@market_data_bp.route('/stocks/key', methods=['PUT'])
@token_required
def save_stocks_key():
    """Check a key pair with Alpaca, then store both halves encrypted."""
    try:
        from controllers.UserDbContext import UserDbContext

        data = request.get_json(silent=True) or {}
        key_id = (data.get('key_id') or '').strip()
        secret = (data.get('secret') or '').strip()
        if not key_id or not secret:
            return bad_request("Both the API key ID and the secret key are required")

        try:
            verify_keys(key_id, secret)
        except ValueError as e:
            return bad_request(str(e))

        UserDbContext.update_alpaca_keys(request.user_id, encrypt_api_key(key_id), encrypt_api_key(secret))
        forget_user(request.user_id)
        return success_response(data={'configured': True, 'feed': STOCK_FEED},
                                message="Alpaca key saved and verified")
    except Exception as e:
        return handle_error(e)


@market_data_bp.route('/stocks/key', methods=['DELETE'])
@token_required
def delete_stocks_key():
    try:
        from controllers.UserDbContext import UserDbContext

        UserDbContext.update_alpaca_keys(request.user_id, None, None)
        forget_user(request.user_id)
        return success_response(data={'configured': False, 'feed': STOCK_FEED},
                                message="Alpaca key removed")
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


@market_data_bp.route('/fundamentals/<symbol>', methods=['GET'])
@token_required
@active_required
def fundamentals(symbol):
    """Just the CoinGecko fundamentals (market cap, rank...) for one coin.

    The light version of /asset/<symbol>, for the Live Data stats strip: no
    exchange history, and served from the asset_market_info cache when fresh.
    """
    try:
        from helper import coingecko

        symbol = (symbol or '').strip().upper()
        if not symbol:
            return bad_request("symbol is required")
        if coingecko.is_fiat(symbol):
            return success_response(data={'symbol': symbol, 'is_cash': True, 'info': None, 'live': True})
        info, live, stale_seconds = _load_fundamentals([symbol])
        return success_response(data={
            'symbol': symbol, 'is_cash': False, 'info': info.get(symbol),
            'live': live, 'stale_seconds': stale_seconds,
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
