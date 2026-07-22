"""Market data endpoints using Kraken public API via CCXT.

No API keys are required — all data comes from public endpoints.
"""

import time
from flask import Blueprint, request
from helper.Security import token_required
from helper.ErrorHandler import handle_error, bad_request
from helper.Helper import success_response
import ccxt

market_data_bp = Blueprint('market_data', __name__)

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
