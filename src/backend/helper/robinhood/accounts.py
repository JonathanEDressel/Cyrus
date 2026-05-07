"""Robinhood account and balance endpoint wrappers."""

from helper.robinhood.client import RobinhoodClient


def get_account(client: RobinhoodClient) -> dict:
    """Return account details: account_number, status, buying_power."""
    return client.get("/api/v1/crypto/trading/accounts/")


def get_holdings(client: RobinhoodClient) -> dict:
    """Return non-zero crypto holdings as a CCXT-compatible balance dict.

    Returns the CCXT-style structure::

        {
            'total': {'BTC': 0.05, 'ETH': 1.2, ...},
            'free':  {'BTC': 0.05, 'ETH': 1.2, ...},
            'used':  {},
        }

    This allows :func:`helper.ExchangeClient.get_balance` to process the
    result with ``raw.get('total', {})`` exactly as it does for CCXT exchanges.
    """
    results = client.get_all_pages("/api/v1/crypto/trading/holdings/")
    totals: dict[str, float] = {}
    for item in results:
        asset = item.get("asset_code", "")
        try:
            quantity = float(item.get("total_quantity") or 0)
        except (ValueError, TypeError):
            quantity = 0.0
        if asset and quantity > 0:
            totals[asset] = quantity

    return {"total": totals, "free": totals, "used": {}}
