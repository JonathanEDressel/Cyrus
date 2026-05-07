"""Robinhood order endpoint wrappers.

Symbols use Robinhood's ``BTC-USD`` dash-separated format internally; the
public functions accept either ``BTC/USD`` (CCXT style) or ``BTC-USD``
(Robinhood style) and normalise before making requests.

Order states map as follows:
  open            → 'open'
  filled          → 'closed'   (matches CCXT convention)
  partially_filled → 'open'
  canceled        → 'canceled'
  failed          → 'rejected'
"""

import uuid

from helper.robinhood.client import RobinhoodClient
from helper.robinhood.errors import RobinhoodNotSupportedError


def _to_rh_symbol(symbol: str) -> str:
    """Convert 'BTC/USD' or 'BTC-USD' to Robinhood's 'BTC-USD' format."""
    return symbol.replace("/", "-").upper()


_STATE_MAP = {
    "open": "open",
    "filled": "closed",
    "partially_filled": "open",
    "canceled": "canceled",
    "failed": "rejected",
}


def _normalize_order(order: dict) -> dict:
    """Map a raw Robinhood order dict to a CCXT-like unified format."""
    rh_symbol = order.get("symbol", "")
    state = order.get("state", "")
    cfg = order.get("market_order_config") or {}

    return {
        "id": order.get("id", ""),
        "symbol": rh_symbol.replace("-", "/"),
        "side": order.get("side", ""),
        "type": order.get("type", ""),
        "status": _STATE_MAP.get(state, state),
        "amount": float(cfg.get("asset_quantity") or 0),
        "filled": float(order.get("filled_asset_quantity") or 0),
        "price": order.get("average_price") or None,
        "timestamp": order.get("created_at", ""),
        "info": order,
    }


def get_open_orders(client: RobinhoodClient, symbol: str | None = None) -> list[dict]:
    """Return open orders, optionally filtered by symbol.

    ``symbol`` may be ``'BTC/USD'`` or ``'BTC-USD'``.
    """
    path = "/api/v1/crypto/trading/orders/?state=open"
    if symbol:
        path += f"&symbol={_to_rh_symbol(symbol)}"
    results = client.get_all_pages(path)
    return [_normalize_order(o) for o in results]


def get_closed_orders(
    client: RobinhoodClient,
    symbol: str | None = None,
    since: int | None = None,
) -> list[dict]:
    """Return filled orders, optionally filtered by symbol and start timestamp.

    ``since`` is a millisecond Unix timestamp (CCXT convention).
    """
    path = "/api/v1/crypto/trading/orders/?state=filled"
    if symbol:
        path += f"&symbol={_to_rh_symbol(symbol)}"
    if since:
        import datetime
        dt = datetime.datetime.utcfromtimestamp(since / 1000).strftime("%Y-%m-%dT%H:%M:%SZ")
        path += f"&created_at_start={dt}"
    results = client.get_all_pages(path)
    return [_normalize_order(o) for o in results]


def place_market_order(
    client: RobinhoodClient,
    symbol: str,
    side: str,
    asset_quantity: float,
) -> dict:
    """Place a market order.

    ``symbol`` may be ``'BTC/USD'`` or ``'BTC-USD'``.
    ``side`` must be ``'buy'`` or ``'sell'``.
    """
    if side not in ("buy", "sell"):
        raise RobinhoodNotSupportedError(f"Invalid order side: '{side}'. Must be 'buy' or 'sell'.")

    body = {
        "client_order_id": str(uuid.uuid4()),
        "side": side,
        "type": "market",
        "symbol": _to_rh_symbol(symbol),
        "market_order_config": {"asset_quantity": str(asset_quantity)},
    }
    result = client.post("/api/v1/crypto/trading/orders/", body)
    return _normalize_order(result)
