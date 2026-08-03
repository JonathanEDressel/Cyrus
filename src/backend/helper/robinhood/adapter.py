"""Robinhood exchange adapter.

Exposes a CCXT-compatible interface so the rest of the application
(ExchangeClient helpers, AutomationWorker, ExchangeController) can call the
same methods it already calls on CCXT exchange objects, with zero changes to
calling code.

Supported operations
--------------------
- fetch_balance()            → account holdings
- fetch_available_balance()  → spendable balance, including USD buying power
- fetch_open_orders()        → open orders
- fetch_closed_orders()      → filled orders
- cancel_order()             → request cancellation of an open order
- fetch_ticker()             → mid-price as {'last': price}
- load_markets() / .markets  → trading-pair metadata
- amount_to_precision() / price_to_precision() → snap to a pair's increments
- create_market_sell_order() → market sell
- create_order()             → market or limit, buy or sell (quote-amount
                               supported for market buys)

Unsupported operations
----------------------
- withdraw()                         → raises RobinhoodNotSupportedError
- privatePostWithdrawAddresses()     → returns empty result (no withdrawal
                                       address API on Robinhood)
"""

from decimal import Decimal, ROUND_DOWN, ROUND_HALF_EVEN

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

    #: Mirrors ccxt.Exchange.has — Robinhood exposes no bulk-ticker or OHLCV
    #: endpoints, so capability probes (e.g. ``exchange.has.get('fetchTickers')``)
    #: resolve to falsy and callers fall back to per-asset pricing.
    has: dict = {}

    def __init__(self, api_key: str, private_key_b64: str) -> None:
        self._client = RobinhoodClient(api_key=api_key, private_key_b64=private_key_b64)
        self._markets: dict | None = None

    # ------------------------------------------------------------------
    # Account / balance
    # ------------------------------------------------------------------

    def fetch_balance(self) -> dict:
        """Return CCXT-style balance dict with 'total', 'free', 'used' keys.

        Crypto only — see :meth:`fetch_available_balance` for cash.
        """
        return _accounts.get_holdings(self._client)

    def fetch_available_balance(self) -> dict:
        """Spendable balance per asset, including USD buying power.

        Robinhood's ``/holdings/`` endpoint lists crypto only; the cash available
        to buy with lives on the account as ``buying_power``. Without folding it
        in, every quote-side balance check on Robinhood sees zero and refuses
        every buy with a confidently wrong "not enough USD".

        Deliberately NOT merged into :meth:`fetch_balance`. That would flow into
        ``get_balance`` → ``get_portfolio`` → the portfolio-history snapshots and
        the worker's balance_threshold triggers, stepping every existing user's
        recorded portfolio value by their cash balance and potentially firing
        USD-threshold rules that have never fired.
        """
        balances = self.fetch_balance()
        free = dict(balances.get('free') or {})
        try:
            account = _accounts.get_account(self._client) or {}
            power = float(account.get('buying_power') or 0)
            currency = str(account.get('buying_power_currency') or 'USD').upper()
            if power > 0:
                free[currency] = free.get(currency, 0.0) + power
        except (RobinhoodError, TypeError, ValueError) as e:
            # Buying power is additive information; losing it should degrade buys
            # to "insufficient funds", not break the whole balance read.
            print(f"[DEBUG] Robinhood buying_power unavailable: {e}")
        return free

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

    def cancel_order(self, id: str, symbol: str | None = None, params: dict | None = None) -> dict:
        """Cancel an open order by id.

        Signature mirrors ``ccxt.Exchange.cancel_order``; Robinhood identifies an
        order by id alone, so ``symbol`` is accepted and ignored.
        """
        return _orders.cancel_order(self._client, id)

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
    # Precision
    # ------------------------------------------------------------------

    def amount_to_precision(self, symbol: str, amount) -> str:
        """Snap a base quantity DOWN to the pair's asset increment.

        Named to match ``ccxt.Exchange`` so ExchangeClient's precision helpers
        take their normal path here rather than the generic fallback. Returns a
        string, as ccxt's own version does.
        """
        return self._snap(symbol, 'amount', amount, ROUND_DOWN)

    def price_to_precision(self, symbol: str, price) -> str:
        """Snap a limit price to the nearest quote increment."""
        return self._snap(symbol, 'price', price, ROUND_HALF_EVEN)

    def _snap(self, symbol: str, kind: str, value, rounding) -> str:
        market = (self.markets or {}).get(symbol.replace('-', '/').upper()) or {}
        tick = (market.get('precision') or {}).get(kind)
        if tick is None:
            info_key = 'asset_increment' if kind == 'amount' else 'quote_increment'
            tick = (market.get('info') or {}).get(info_key)
        try:
            step = Decimal(str(tick))
        except Exception:
            step = None
        if step is None or step <= 0:
            # No increment published — pass the value through unrounded rather
            # than guessing, and let Robinhood reject it if it disagrees.
            return format(Decimal(str(value)).normalize(), 'f')
        steps = (Decimal(str(value)) / step).quantize(Decimal(1), rounding=rounding)
        return format((steps * step).normalize(), 'f')

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
    # Trading
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
        """Generic order entry point for market and limit orders.

        Signature mirrors ``ccxt.Exchange.create_order`` so
        ``ExchangeClient.create_limit_order`` calls it unchanged.

        Market orders support quote-amount buys via ``params['quoteOrderQty']``
        or ``params['cost']``; when a quote amount is supplied the current
        mid-price is used to estimate the asset quantity.
        """
        extra = params or {}
        order_type = (type or "").lower()

        if order_type == "limit":
            if price is None or float(price) <= 0:
                raise RobinhoodError("A limit order requires a positive limit price")
            if extra.get("postOnly"):
                # Robinhood's crypto API has no post-only flag. Accepting the
                # param and dropping it would place a taker order the user
                # explicitly asked not to place.
                raise RobinhoodNotSupportedError(
                    "Robinhood does not support post-only limit orders"
                )
            return _orders.place_limit_order(
                self._client, symbol, side, float(amount), float(price),
                time_in_force=str(extra.get("timeInForce") or "gtc").lower(),
                client_order_id=extra.get("clientOrderId"),
            )

        if order_type != "market":
            raise RobinhoodNotSupportedError(
                f"Order type '{type}' is not supported for Robinhood. "
                "Only 'market' and 'limit' orders are available."
            )

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

    def fetch_ohlcv(self, *args, **kwargs):
        """Not supported — Robinhood's crypto API has no OHLCV/candles endpoint.

        Charts in the app use public Kraken data, so this never affects them;
        callers that probe history (e.g. report gap-fill) catch this and fall
        back gracefully.
        """
        raise RobinhoodNotSupportedError(
            "Robinhood does not provide historical OHLCV candle data."
        )

    def withdraw(self, *args, **kwargs):
        """Not supported — Robinhood does not expose a crypto withdrawal API."""
        raise RobinhoodNotSupportedError(
            "Crypto withdrawals are not supported by the Robinhood API. "
            "Only 'Convert Crypto' is available for Robinhood."
        )

    def privatePostWithdrawAddresses(self, *args, **kwargs) -> dict:
        """Not supported — returns an empty result set."""
        return {"result": []}
