"""Robinhood exchange adapter.

Exposes a CCXT-compatible interface so the rest of the application
(ExchangeClient helpers, AutomationWorker, ExchangeController) can call the
same methods it already calls on CCXT exchange objects, with zero changes to
calling code.

Supported operations
--------------------
- fetch_balance()            → account holdings
- fetch_open_orders()        → open orders
- fetch_closed_orders()      → filled orders
- fetch_ticker()             → mid-price as {'last': price}
- load_markets() / .markets  → trading-pair metadata
- create_market_sell_order() → market sell
- create_order()             → market buy or sell (quote-amount supported)

Unsupported operations
----------------------
- withdraw()                         → raises RobinhoodNotSupportedError
- privatePostWithdrawAddresses()     → returns empty result (no withdrawal
                                       address API on Robinhood)
"""

import helper.robinhood.accounts as _accounts
import helper.robinhood.market as _market
import helper.robinhood.orders as _orders
from helper.robinhood.client import RobinhoodClient
from helper.robinhood.errors import RobinhoodError, RobinhoodNotSupportedError


class RobinhoodAdapter:
    """Adapter that wraps the Robinhood direct API behind a CCXT-like interface."""

    #: Mirrors ccxt.Exchange.id so existing id-checks (e.g. exchange.id == 'kraken')
    #: work correctly throughout the codebase.
    id = "robinhood"

    def __init__(self, api_key: str, private_key_b64: str) -> None:
        self._client = RobinhoodClient(api_key=api_key, private_key_b64=private_key_b64)
        self._markets: dict | None = None

    # ------------------------------------------------------------------
    # Account / balance
    # ------------------------------------------------------------------

    def fetch_balance(self) -> dict:
        """Return CCXT-style balance dict with 'total', 'free', 'used' keys."""
        return _accounts.get_holdings(self._client)

    # ------------------------------------------------------------------
    # Orders
    # ------------------------------------------------------------------

    def fetch_open_orders(self, symbol: str | None = None, **kwargs) -> list:
        """Return open orders, optionally filtered by symbol."""
        return _orders.get_open_orders(self._client, symbol)

    def fetch_closed_orders(
        self,
        symbol: str | None = None,
        since: int | None = None,
        **kwargs,
    ) -> list:
        """Return filled (closed) orders."""
        return _orders.get_closed_orders(self._client, symbol, since)

    # ------------------------------------------------------------------
    # Markets
    # ------------------------------------------------------------------

    def load_markets(self) -> dict:
        """Fetch and cache trading-pair metadata."""
        if self._markets is None:
            self._markets = _market.load_markets(self._client)
        return self._markets

    @property
    def markets(self) -> dict:
        """Lazily loaded markets dict (CCXT-style BTC/USD keys)."""
        return self.load_markets()

    # ------------------------------------------------------------------
    # Market data
    # ------------------------------------------------------------------

    def fetch_ticker(self, symbol: str) -> dict:
        """Return a ticker-like dict with a 'last' price key.

        ``symbol`` may be ``'BTC/USD'`` or ``'BTC-USD'``.
        """
        parts = symbol.replace("-", "/").split("/")
        base = parts[0] if parts else symbol
        quote = parts[1] if len(parts) > 1 else "USD"
        price = _market.get_market_price(self._client, base, quote)
        return {"symbol": symbol, "last": price, "info": {}}

    # ------------------------------------------------------------------
    # Trading — market orders only
    # ------------------------------------------------------------------

    def create_market_sell_order(
        self,
        symbol: str,
        amount: float,
        params: dict | None = None,
    ) -> dict:
        """Place a market sell order for ``amount`` units of the base asset."""
        return _orders.place_market_order(self._client, symbol, "sell", amount)

    def create_order(
        self,
        symbol: str,
        type: str,
        side: str,
        amount,
        price,
        params: dict | None = None,
    ) -> dict:
        """Generic order entry point (market orders only).

        Supports quote-amount buys via ``params['quoteOrderQty']`` or
        ``params['cost']``.  When a quote amount is supplied the current
        mid-price is used to estimate the asset quantity.
        """
        if type != "market":
            raise RobinhoodNotSupportedError(
                f"Order type '{type}' is not supported for Robinhood. "
                "Only 'market' orders are available."
            )

        extra = params or {}
        quote_amount = extra.get("quoteOrderQty") or extra.get("cost")

        if quote_amount:
            # Estimate asset quantity from the current mid-price.
            parts = symbol.replace("-", "/").split("/")
            base = parts[0] if parts else symbol
            quote = parts[1] if len(parts) > 1 else "USD"
            try:
                mid_price = _market.get_market_price(self._client, base, quote)
            except RobinhoodError as exc:
                raise RobinhoodError(
                    f"Cannot estimate asset quantity for {symbol}: {exc}"
                ) from exc
            if mid_price <= 0:
                raise RobinhoodError(
                    f"Cannot estimate asset quantity: mid-price for {symbol} is {mid_price}"
                )
            asset_qty = float(quote_amount) / mid_price
            return _orders.place_market_order(self._client, symbol, side, asset_qty)

        return _orders.place_market_order(self._client, symbol, side, float(amount))

    # ------------------------------------------------------------------
    # Unsupported operations
    # ------------------------------------------------------------------

    def withdraw(self, *args, **kwargs):
        """Not supported — Robinhood does not expose a crypto withdrawal API."""
        raise RobinhoodNotSupportedError(
            "Crypto withdrawals are not supported by the Robinhood API. "
            "Only 'Convert Crypto' is available for Robinhood."
        )

    def privatePostWithdrawAddresses(self, *args, **kwargs) -> dict:
        """Not supported — returns an empty result set."""
        return {"result": []}
