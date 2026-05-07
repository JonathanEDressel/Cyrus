"""Robinhood market-data and trading-pair endpoint wrappers.

Robinhood uses ``BTC-USD`` dash-separated symbols.  All public functions
accept either ``BTC/USD`` (CCXT style) or ``BTC-USD`` and normalise before
making API calls.  Returned market dicts use CCXT-style ``BTC/USD`` keys so
the rest of the app can treat them uniformly.
"""

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


def load_markets(client: RobinhoodClient) -> dict:
    """Return a markets dict keyed by CCXT-style symbol (e.g. ``'BTC/USD'``).

    The structure mirrors what CCXT returns so ``ExchangeClient.convert()``
    and ``get_market_price()`` can use ``exchange.markets`` without changes.
    """
    pairs = get_trading_pairs(client)
    markets: dict = {}
    for pair in pairs:
        rh_sym = pair.get("symbol", "")
        if not rh_sym:
            continue
        ccxt_sym = _to_ccxt_symbol(rh_sym)
        try:
            min_qty = float(pair.get("min_order_size") or 0)
        except (ValueError, TypeError):
            min_qty = 0.0
        markets[ccxt_sym] = {
            "id": rh_sym,
            "symbol": ccxt_sym,
            "limits": {
                "amount": {"min": min_qty},
                "cost": {"min": 0.0},
            },
            "info": pair,
        }
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
