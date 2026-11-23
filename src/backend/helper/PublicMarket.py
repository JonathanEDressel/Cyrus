"""Clients for the chart feeds (see ``CHART_SOURCES``).

Crypto sources are keyless ccxt clients, shared by the market-data endpoints
and the worker's price-alert check, so both reuse one instance per exchange:
its loaded markets and rate limiter carry over between requests.

Sources marked ``requires_key`` (Stocks) are built per user from the key they
saved on Profile, so those calls must pass a ``user_id``.
"""

import threading
import time

import ccxt

from helper.ExchangeRegistry import SUPPORTED_EXCHANGES, CHART_SOURCES
from helper.StockMarket import AlpacaMarket, StockKeyError, get_alpaca_keys

_public: dict[str, ccxt.Exchange] = {}
# Keyed sources: user_id -> (key_id, client). The key id is kept so a changed
# key is noticed even if forget_user wasn't called.
_keyed: dict[int, tuple[str, AlpacaMarket]] = {}
_lock = threading.Lock()


def get_public(source: str, user_id: int | None = None):
    """Return the cached client for a chart source.

    Keyless sources ignore ``user_id``. A ``requires_key`` source raises
    ``StockKeyError`` (a ValueError) when the user has no usable key.
    """
    if source not in CHART_SOURCES:
        raise ValueError(f"Unknown source: {source}")
    if CHART_SOURCES[source].get('requires_key'):
        keys = get_alpaca_keys(user_id)
        if not keys:
            raise StockKeyError()
        with _lock:
            cached = _keyed.get(user_id)
            if cached is None or cached[0] != keys[0]:
                cached = (keys[0], AlpacaMarket(*keys))
                _keyed[user_id] = cached
            return cached[1]
    with _lock:
        ex = _public.get(source)
        if ex is None:
            meta = SUPPORTED_EXCHANGES[source]
            config: dict = {'enableRateLimit': True}
            if meta.get('ccxt_options'):
                config['options'] = dict(meta['ccxt_options'])
            ex = getattr(ccxt, meta['ccxt_id'])(config)
            _public[source] = ex
        return ex


def forget_user(user_id: int) -> None:
    """Drop a user's keyed clients (after their key is saved or removed)."""
    with _lock:
        _keyed.pop(user_id, None)


def recent_range(source: str, symbol: str, since_s: int | None,
                 user_id: int | None = None) -> dict | None:
    """High, low and last price since ``since_s`` (epoch s), from 1m candles.

    Capped at the last hour so a long gap (Cyrus was closed) only looks at
    recent trading rather than firing on a move from long ago. Falls back to
    a ticker sample when the feed has no 1m candles.
    """
    ex = get_public(source, user_id)
    now = int(time.time())
    start = max(since_s or now - 120, now - 3600)
    try:
        if '1m' in (ex.timeframes or {}):
            raw = ex.fetch_ohlcv(symbol, timeframe='1m', since=start * 1000, limit=60)
            # Only bars that overlap the window; the first may start earlier.
            bars = [c for c in raw if c[0] / 1000 + 60 > start and c[4] is not None]
            if bars:
                return {
                    'high': max(c[2] for c in bars),
                    'low': min(c[3] for c in bars),
                    'last': bars[-1][4],
                }
    except ccxt.BaseError:
        pass
    ticker = ex.fetch_ticker(symbol)
    last = ticker.get('last')
    if last is None:
        return None
    return {'high': last, 'low': last, 'last': last}
