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

import datetime
import uuid
from decimal import Decimal

from helper.robinhood.client import RobinhoodClient
from helper.robinhood.errors import RobinhoodNotSupportedError


def _fmt(value) -> str:
    """Plain decimal string — never scientific notation.

    ``str(1e-08)`` is ``'1e-08'``, which Robinhood's JSON body rejects. Any order
    small enough to matter hits this: a SHIB price, or a dust-sized BTC rung of a
    ladder. Every numeric field in an order body goes through here.
    """
    try:
        return format(Decimal(str(value)).normalize(), 'f')
    except Exception:
        return str(value)


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


#: Robinhood carries an order's parameters in a per-type config block, keyed by
#: the order's ``type`` — ``limit_order_config`` for a limit order and so on.
#: Reading only the market block leaves every other type without a quantity or
#: a price, which is what blanked the limit-order columns in the UI.
_CONFIG_KEYS = (
    "limit_order_config",
    "market_order_config",
    "stop_limit_order_config",
    "stop_loss_order_config",
)


def _order_config(order: dict) -> dict:
    """The order's config block, whichever per-type key holds it.

    Prefers the key matching ``type`` and otherwise takes whichever block is
    present, so an order type Robinhood adds later still yields its numbers.
    """
    expected = f"{order.get('type') or ''}_order_config"
    cfg = order.get(expected)
    if isinstance(cfg, dict):
        return cfg
    for key in _CONFIG_KEYS:
        cfg = order.get(key)
        if isinstance(cfg, dict):
            return cfg
    return {}


def _to_float(value) -> float | None:
    """Parse a Robinhood numeric string, returning None when absent/unusable."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _parse_timestamp(created_at) -> int | None:
    """``'2026-08-03T12:34:56.789Z'`` -> epoch milliseconds.

    CCXT's ``timestamp`` is an integer count of milliseconds, and callers sort
    and compare on it. Passing Robinhood's ISO string straight through left
    Robinhood orders as the odd one out in any mixed-exchange list.
    """
    if not created_at:
        return None
    if isinstance(created_at, (int, float)):
        return int(created_at)
    try:
        dt = datetime.datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return int(dt.timestamp() * 1000)


def _normalize_order(order: dict) -> dict:
    """Map a raw Robinhood order dict to a CCXT-like unified format."""
    rh_symbol = order.get("symbol", "")
    state = order.get("state", "")
    cfg = _order_config(order)

    limit_price = _to_float(cfg.get("limit_price"))
    average_price = _to_float(order.get("average_price"))

    amount = _to_float(cfg.get("asset_quantity"))
    quote_amount = _to_float(cfg.get("quote_amount"))
    if amount is None and quote_amount is not None:
        # A quote-denominated order ("buy $50 of BTC") carries no asset
        # quantity. CCXT reports amount in the base asset, so derive it from
        # whichever price the order does carry.
        reference = limit_price or average_price
        amount = (quote_amount / reference) if reference else None

    return {
        "id": order.get("id", ""),
        "symbol": rh_symbol.replace("-", "/"),
        "side": order.get("side", ""),
        "type": order.get("type", ""),
        "status": _STATE_MAP.get(state, state),
        "amount": amount or 0.0,
        "filled": _to_float(order.get("filled_asset_quantity")) or 0.0,
        # CCXT semantics: 'price' is the order's own price — the limit it's
        # resting at — while 'average' is what it actually filled at. Reporting
        # average_price as the price is why a resting limit order showed none:
        # it has no average until something fills.
        "price": limit_price if limit_price is not None else average_price,
        "average": average_price,
        "stopPrice": _to_float(cfg.get("stop_price")),
        "timestamp": _parse_timestamp(order.get("created_at")),
        "datetime": order.get("created_at") or None,
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
        dt = datetime.datetime.fromtimestamp(
            since / 1000, datetime.timezone.utc
        ).strftime("%Y-%m-%dT%H:%M:%SZ")
        path += f"&created_at_start={dt}"
    results = client.get_all_pages(path)
    return [_normalize_order(o) for o in results]


def cancel_order(client: RobinhoodClient, order_id: str) -> dict:
    """Request cancellation of an open order.

    Robinhood treats this as a *request*: the endpoint acknowledges it and the
    order moves to ``canceled`` asynchronously, so the order can still come back
    as open on an immediate re-fetch. The returned status says ``canceling``
    rather than ``canceled`` so callers can word that honestly.
    """
    client.post(f"/api/v1/crypto/trading/orders/{order_id}/cancel/")
    return {"id": order_id, "status": "canceling"}


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
        # _fmt, not str(): a small enough quantity stringifies to '1e-08', which
        # Robinhood rejects.
        "market_order_config": {"asset_quantity": _fmt(asset_quantity)},
    }
    result = client.post("/api/v1/crypto/trading/orders/", body)
    return _normalize_order(result)


#: Robinhood's crypto limit orders accept 'gtc', 'ioc' and 'fok'. GTC is what a
#: resting ladder rung needs, and it is the only value Cyrus sends.
_DEFAULT_TIME_IN_FORCE = "gtc"
_TIME_IN_FORCE_VALUES = ("gtc", "ioc", "fok")


def place_limit_order(
    client: RobinhoodClient,
    symbol: str,
    side: str,
    asset_quantity: float,
    limit_price: float,
    time_in_force: str = _DEFAULT_TIME_IN_FORCE,
    client_order_id: str | None = None,
) -> dict:
    """Place a resting limit order.

    ``symbol`` may be ``'BTC/USD'`` or ``'BTC-USD'``; ``side`` is 'buy'/'sell'.
    Quantity is in the base asset and ``limit_price`` is quote-per-base, matching
    CCXT's convention so ``ExchangeClient.create_limit_order`` needs no
    Robinhood-specific branch.

    ``client_order_id`` is accepted so a caller retrying an ambiguous request (a
    timeout, where the order may or may not have landed) can reuse the id and let
    Robinhood dedupe instead of placing a second order.

    The response flows back through :func:`_normalize_order`, which already reads
    ``limit_order_config`` — the same key Robinhood returns.
    """
    if side not in ("buy", "sell"):
        raise RobinhoodNotSupportedError(f"Invalid order side: '{side}'. Must be 'buy' or 'sell'.")
    if not asset_quantity or float(asset_quantity) <= 0:
        raise RobinhoodNotSupportedError("Order quantity must be greater than zero")
    if not limit_price or float(limit_price) <= 0:
        raise RobinhoodNotSupportedError("Limit price must be greater than zero")

    tif = (time_in_force or _DEFAULT_TIME_IN_FORCE).lower()
    if tif not in _TIME_IN_FORCE_VALUES:
        raise RobinhoodNotSupportedError(
            f"Robinhood does not support time-in-force '{time_in_force}'")

    body = {
        "client_order_id": client_order_id or str(uuid.uuid4()),
        "side": side,
        "type": "limit",
        "symbol": _to_rh_symbol(symbol),
        "limit_order_config": {
            # asset_quantity, not quote_amount: the ladder decides the base size,
            # and a quote-denominated order's filled size would drift with the
            # market between rungs.
            "asset_quantity": _fmt(asset_quantity),
            "limit_price": _fmt(limit_price),
            "time_in_force": tif,
        },
    }
    result = client.post("/api/v1/crypto/trading/orders/", body)
    return _normalize_order(result)
