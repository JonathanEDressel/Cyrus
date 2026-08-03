"""Robinhood account and balance endpoint wrappers."""

from helper.robinhood.client import RobinhoodClient


def get_account(client: RobinhoodClient) -> dict:
    """Return account details: account_number, status, buying_power."""
    return client.get("/api/v1/crypto/trading/accounts/")


def _num(value) -> float | None:
    """Parse a Robinhood numeric string, returning None when absent/unusable."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def get_holdings(client: RobinhoodClient) -> dict:
    """Return non-zero crypto holdings as a CCXT-compatible balance dict.

    Returns the CCXT-style structure::

        {
            'total': {'BTC': 0.05, 'ETH': 1.2, ...},
            'free':  {'BTC': 0.04, 'ETH': 1.2, ...},
            'used':  {'BTC': 0.01},
        }

    This allows :func:`helper.ExchangeClient.get_balance` to process the
    result with ``raw.get('total', {})`` exactly as it does for CCXT exchanges.

    ``free`` uses ``quantity_available_for_trading`` where Robinhood supplies it
    — that figure already excludes crypto committed to resting sell orders, which
    ``total_quantity`` does not. It falls back to the total rather than to zero: a
    missing field must not read as "nothing spendable" and block every sell.

    Note this covers crypto only. Robinhood's ``/holdings/`` endpoint has no cash
    entry, so USD buying power is folded in separately by
    ``RobinhoodAdapter.fetch_available_balance``.
    """
    results = client.get_all_pages("/api/v1/crypto/trading/holdings/")
    totals: dict[str, float] = {}
    frees: dict[str, float] = {}
    for item in results:
        asset = item.get("asset_code", "")
        if not asset:
            continue
        quantity = _num(item.get("total_quantity")) or 0.0
        if quantity <= 0:
            continue
        available = _num(item.get("quantity_available_for_trading"))
        totals[asset] = quantity
        frees[asset] = quantity if available is None else available

    used = {asset: max(total - frees.get(asset, total), 0.0)
            for asset, total in totals.items()}
    return {"total": totals, "free": frees, "used": used}
