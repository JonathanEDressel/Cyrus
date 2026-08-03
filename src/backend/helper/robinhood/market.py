"""Robinhood market-data and trading-pair endpoint wrappers.

Robinhood uses ``BTC-USD`` dash-separated symbols.  All public functions
accept either ``BTC/USD`` (CCXT style) or ``BTC-USD`` and normalise before
making API calls.  Returned market dicts use CCXT-style ``BTC/USD`` keys so
the rest of the app can treat them uniformly.
"""

import time

from helper.robinhood.client import RobinhoodClient
from helper.robinhood.errors import RobinhoodError


def _to_rh_symbol(symbol: str) -> str:
    return symbol.replace("/", "-").upper()


def _to_ccxt_symbol(symbol: str) -> str:
    return symbol.replace("-", "/")


# ---------------------------------------------------------------------------
# Trading pairs
# ---------------------------------------------------------------------------

def get_trading_pairs(client: RobinhoodClient, *symbols: str) -> list[dict]:
    """Return raw trading-pair metadata from Robinhood.

    If ``symbols`` are provided they must be in Robinhood format (``BTC-USD``).
    Returns all pairs when no symbols are given.
    """
    if symbols:
        qs = "&".join(f"symbol={s}" for s in symbols)
        resp = client.get(f"/api/v1/crypto/trading/trading_pairs/?{qs}")
        return resp.get("results", [])
    return client.get_all_pages("/api/v1/crypto/trading/trading_pairs/")


def _num(value) -> float | None:
    """Parse a Robinhood numeric string, returning None when absent/unusable."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _build_markets(pairs: list[dict]) -> dict:
    """Turn raw trading-pair payloads into CCXT-shaped market dicts.

    Lifts base/quote/precision/limits out of the payload rather than leaving them
    buried in ``info``. Two things depend on that: without ``base``/``quote`` the
    ``/assets`` endpoint returns nothing for Robinhood (it reads those keys), and
    without ``precision`` a limit order can't be snapped to the pair's own
    increments — which is how SHIB ends up with BTC's decimal places.
    """
    markets: dict = {}
    for pair in pairs:
        rh_sym = pair.get("symbol", "")
        if not rh_sym:
            continue
        ccxt_sym = _to_ccxt_symbol(rh_sym)
        parts = ccxt_sym.split("/")
        base = str(pair.get("asset_code") or (parts[0] if parts else "")).upper()
        quote = str(pair.get("quote_code") or (parts[1] if len(parts) > 1 else "")).upper()

        markets[ccxt_sym] = {
            "id": rh_sym,
            "symbol": ccxt_sym,
            "base": base,
            "quote": quote,
            "type": "spot",
            "spot": True,
            # Robinhood's own tradability flag. A paused pair must not show up in
            # a pair picker as though an order could rest on it.
            "active": str(pair.get("status") or "tradable").lower() == "tradable",
            "precision": {
                "amount": _num(pair.get("asset_increment")),
                "price": _num(pair.get("quote_increment")),
            },
            "limits": {
                "amount": {"min": _num(pair.get("min_order_size")) or 0.0,
                           "max": _num(pair.get("max_order_size"))},
                # Robinhood publishes no notional minimum. Left falsy so the
                # min-cost check is skipped rather than run against a fake zero.
                "cost": {"min": 0.0, "max": None},
                "price": {"min": None, "max": None},
            },
            "info": pair,
        }
    return markets


# Trading-pair metadata is identical for every account, so it's cached
# process-wide rather than per adapter instance. ``get_user_exchange()`` builds a
# fresh RobinhoodAdapter per request, and without this a ladder would re-fetch
# the whole *paginated* pair list on every single order it places — spending a
# large slice of the 100 req/min budget on data that never changes.
_MARKETS_CACHE: dict | None = None
_MARKETS_CACHE_AT: float = 0.0
MARKETS_CACHE_TTL = 3600


def load_markets(client: RobinhoodClient, force: bool = False) -> dict:
    """Return a markets dict keyed by CCXT-style symbol (e.g. ``'BTC/USD'``).

    The structure mirrors what CCXT returns so ``ExchangeClient.convert()``,
    ``get_market_price()`` and ``create_limit_order()`` can all use
    ``exchange.markets`` without a Robinhood branch. Cached process-wide; pass
    ``force=True`` to refetch.
    """
    global _MARKETS_CACHE, _MARKETS_CACHE_AT
    now = time.time()
    if (not force and _MARKETS_CACHE is not None
            and (now - _MARKETS_CACHE_AT) < MARKETS_CACHE_TTL):
        return _MARKETS_CACHE

    markets = _build_markets(get_trading_pairs(client))
    _MARKETS_CACHE, _MARKETS_CACHE_AT = markets, now
    return markets


# ---------------------------------------------------------------------------
# Market data
# ---------------------------------------------------------------------------

def get_best_bid_ask(client: RobinhoodClient, symbol: str) -> dict:
    """Return best bid/ask data for a single symbol.

    ``symbol`` may be ``'BTC/USD'`` or ``'BTC-USD'``.
    Raises :class:`RobinhoodError` when no data is returned.
    """
    rh_symbol = _to_rh_symbol(symbol)
    resp = client.get(f"/api/v1/crypto/marketdata/best_bid_ask/?symbol={rh_symbol}")
    results = resp.get("results", [])
    if not results:
        raise RobinhoodError(f"No market data available for {symbol}")
    return results[0]


def get_market_price(client: RobinhoodClient, base_asset: str, quote_asset: str) -> float:
    """Return the mid-price for base/quote.

    Uses the ask (for buys) and bid (for sells) average as a mid-price
    approximation.  If only the inverse pair is available, the returned
    price is inverted.

    Raises :class:`RobinhoodError` when no price can be determined.
    """
    direct_symbol = f"{base_asset}-{quote_asset}"
    inverse_symbol = f"{quote_asset}-{base_asset}"

    def _mid(data: dict) -> float | None:
        ask = float(data.get("ask_inclusive_of_buy_spread") or data.get("ask") or 0)
        bid = float(data.get("bid_inclusive_of_sell_spread") or data.get("bid") or 0)
        if ask > 0 and bid > 0:
            return (ask + bid) / 2.0
        price = ask or bid
        return price if price > 0 else None

    try:
        data = get_best_bid_ask(client, direct_symbol)
        price = _mid(data)
        if price is not None:
            return price
    except RobinhoodError:
        pass

    try:
        data = get_best_bid_ask(client, inverse_symbol)
        price = _mid(data)
        if price is not None and price > 0:
            return 1.0 / price
    except RobinhoodError:
        pass

    raise RobinhoodError(
        f"No market price available for {base_asset}/{quote_asset} on Robinhood"
    )
