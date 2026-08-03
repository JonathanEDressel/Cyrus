"""Unified exchange client built on top of CCXT.

Every public helper accepts a ready-made ``ccxt.Exchange`` instance so the
caller owns the lifecycle and the functions stay stateless / exchange-agnostic.

``RobinhoodAdapter`` is duck-typed in wherever a ``ccxt.Exchange`` is annotated;
it implements the same method names, so nothing here needs a Robinhood branch.
"""

from decimal import Decimal, ROUND_DOWN, ROUND_HALF_EVEN

import ccxt


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

def create_exchange(exchange_name: str, api_key: str, private_key: str,
                    passphrase: str | None = None, sandbox: bool = False) -> ccxt.Exchange:
    """Instantiate a CCXT exchange object with credentials.

    ``exchange_name`` must match a key in ``ccxt.exchanges``
    (e.g. ``'kraken'``, ``'coinbase'``, ``'binance'``).
    """
    exchange_class = getattr(ccxt, exchange_name, None)
    if exchange_class is None:
        raise ValueError(f"Unsupported exchange: {exchange_name}")

    config: dict = {
        'apiKey': api_key,
        'secret': private_key,
        'enableRateLimit': True,
        # Explicit ceiling so a hung socket can't park the automation worker's
        # poll thread indefinitely (ccxt's own default is 10s, but relying on a
        # library default for something that can freeze rule execution is thin).
        'timeout': 20000,
    }
    if passphrase:
        config['password'] = passphrase

    exchange = exchange_class(config)
    if sandbox:
        try:
            exchange.set_sandbox_mode(True)
        except Exception as e:
            raise ValueError(f"{exchange_name} does not support sandbox mode: {e}")

    return exchange


# ---------------------------------------------------------------------------
# Unified helpers (exchange-agnostic)
# ---------------------------------------------------------------------------

def get_open_orders(exchange: ccxt.Exchange, symbol: str | None = None) -> list[dict]:
    """Return a list of open orders in CCXT unified format."""
    return exchange.fetch_open_orders(symbol)


def get_closed_orders(exchange: ccxt.Exchange, symbol: str | None = None,
                      since: int | None = None) -> list[dict]:
    """Return a list of closed orders in CCXT unified format.

    A **synthetic pair** (see ``cancel_order`` below) is one the exchange routes
    without listing it as a market — LUNA/USDT and XDC/USDT on Kraken. Passing
    one as ``symbol`` makes ccxt raise ``BadSymbol`` while resolving the market,
    even though the order itself is real and comes back in the response. On
    Kraken the symbol is never sent to the API anyway (it's only used to parse
    the result), so retrying without it returns the same orders instead of
    failing outright. Callers already match on the order id.
    """
    try:
        return exchange.fetch_closed_orders(symbol, since=since)
    except ccxt.BadSymbol:
        if symbol is None:
            raise
        print(f"[EXCHANGE] {getattr(exchange, 'id', 'exchange')} cannot resolve "
              f"{symbol} (synthetic pair) — fetching closed orders unfiltered")
        return exchange.fetch_closed_orders(None, since=since)


#: Kraken's response when asked to cancel an order whose pair it can't resolve
#: against its real asset-pair list — which is what happens for a synthetic-pair
#: order. Not in ccxt's error map, so it arrives as a bare ExchangeError.
_UNKNOWN_PAIR_MARKER = 'unknown asset pair'


def is_unknown_pair_error(error: Exception) -> bool:
    """True for Kraken's 'EQuery:Unknown asset pair' rejection."""
    return _UNKNOWN_PAIR_MARKER in str(error).lower()


def cancel_order(exchange: ccxt.Exchange, order_id: str,
                 symbol: str | None = None) -> dict:
    """Cancel a single open order by id.

    Kraken can look an order up from the id alone, but most other exchanges
    (Binance, Coinbase Advanced) reject the call without the market, so callers
    should pass the pair the order was placed on whenever they know it.

    Kraken **synthetic-pair** orders (``descr.aclass == 'synthetic_pair'``, ids
    prefixed ``SO``, e.g. LUNA/USDT) are a special case: the pair is not in
    Kraken's real AssetPairs list, so ``CancelOrder`` fails while resolving it and
    returns ``EQuery:Unknown asset pair``. A bogus id returns
    ``EOrder:Invalid order`` instead, which is how we know the id itself is fine
    and the pair lookup is what breaks. When that happens we retry once through
    ``CancelOrderBatch``, a different Kraken code path that may not perform the
    same lookup. If that also fails the original error is re-raised for the
    caller to explain.
    """
    try:
        result = exchange.cancel_order(order_id, symbol)
        return result if isinstance(result, dict) else {}
    except Exception as e:
        if not (getattr(exchange, 'id', None) == 'kraken' and is_unknown_pair_error(e)):
            raise
        batch = getattr(exchange, 'privatePostCancelOrderBatch', None)
        if not callable(batch):
            raise
        print(f"[DEBUG] kraken CancelOrder rejected {order_id} with an unknown-pair "
              f"error (synthetic pair?); retrying via CancelOrderBatch")
        try:
            response = batch({'orders': [order_id]})
        except Exception as batch_error:
            print(f"[DEBUG] CancelOrderBatch also failed for {order_id}: {batch_error}")
            raise e from batch_error
        return response if isinstance(response, dict) else {}


# ---------------------------------------------------------------------------
# Precision / tick sizes
#
# All three CCXT exchanges the app supports run in TICK_SIZE precision mode, so
# ``market['precision']['amount']`` is a tick like 1e-08 — NOT a count of
# decimal places. Treating it as a digit count silently mangles every order.
# ---------------------------------------------------------------------------

def tick_decimals(tick) -> int | None:
    """Decimal places implied by a tick size (``1e-08`` -> 8, ``0.1`` -> 1).

    Returns None when the tick is unusable, so callers can tell "no precision
    information" apart from "zero decimals".
    """
    if tick is None:
        return None
    try:
        exponent = Decimal(str(tick)).normalize().as_tuple().exponent
    except Exception:
        return None
    if not isinstance(exponent, int):
        return None
    return -exponent if exponent < 0 else 0


def _snap_to_tick(value: float, tick, rounding) -> float:
    """Quantise *value* to a multiple of *tick* using Decimal, not float math.

    ``0.3 / 1e-8`` in binary floats lands a hair under the true multiple; going
    through Decimal is what keeps a 'round down' from silently shaving a whole
    tick off the user's amount.
    """
    if not tick:
        return float(value)
    try:
        step = Decimal(str(tick))
        steps = (Decimal(str(value)) / step).quantize(Decimal(1), rounding=rounding)
        return float(steps * step)
    except Exception:
        return float(value)


def _to_amount_precision(exchange, symbol: str, market: dict | None, amount) -> float:
    """Snap *amount* DOWN to the exchange's amount tick.

    Down, never nearest: rounding a sell amount up past the user's balance is an
    InsufficientFunds they didn't ask for, and on the last rung of a "100% of
    balance" ladder that is exactly what nearest-rounding would do.
    """
    native = getattr(exchange, 'amount_to_precision', None)
    if callable(native):
        try:
            return float(native(symbol, amount))
        except Exception:
            pass
    tick = ((market or {}).get('precision') or {}).get('amount')
    return _snap_to_tick(amount, tick, ROUND_DOWN)


def _to_price_precision(exchange, symbol: str, market: dict | None, price) -> float:
    """Snap *price* to the nearest price tick (matching ccxt's own rounding)."""
    native = getattr(exchange, 'price_to_precision', None)
    if callable(native):
        try:
            return float(native(symbol, price))
        except Exception:
            pass
    tick = ((market or {}).get('precision') or {}).get('price')
    return _snap_to_tick(price, tick, ROUND_HALF_EVEN)


def market_base_quote(symbol: str, market: dict | None) -> tuple[str, str]:
    """``(base, quote)`` for a market, tolerating dicts that lack the keys.

    Robinhood's markets historically carried no ``base``/``quote`` — the raw pair
    payload in ``info`` has ``asset_code``/``quote_code``, and the symbol itself
    is always ``BASE/QUOTE``, so there are two fallbacks before giving up.
    """
    market = market or {}
    base = str(market.get('base') or '').upper()
    quote = str(market.get('quote') or '').upper()
    if base and quote:
        return base, quote

    info = market.get('info') or {}
    base = base or str(info.get('asset_code') or '').upper()
    quote = quote or str(info.get('quote_code') or '').upper()
    if base and quote:
        return base, quote

    parts = str(symbol or '').replace('-', '/').split('/')
    if len(parts) >= 2:
        # Strip a settle suffix ('BTC/USDT:USDT') so the quote stays readable
        # even though _is_spot_market filters those out anyway.
        return (base or parts[0].upper()), (quote or parts[1].split(':')[0].upper())
    return base, quote


def is_spot_market(market: dict) -> bool:
    """True for a plain spot market — excludes derivatives.

    Binance's ccxt market list mixes in swaps and futures (``BTC/USDT:USDT``);
    resting a "limit order" on one of those is not what the order modal means.
    Written permissively rather than as ``spot is True`` so a minimal market
    dict with no ``spot`` key at all is not filtered out.
    """
    for key in ('contract', 'swap', 'future', 'option'):
        if market.get(key):
            return False
    market_type = market.get('type')
    return market_type in (None, '', 'spot')


#: Exchanges whose ccxt driver we have verified maps ``params['postOnly']``:
#: Kraken -> ``oflags=post``, Coinbase -> ``post_only``, Binance -> LIMIT_MAKER.
_POST_ONLY_EXCHANGES = ('kraken', 'coinbase', 'binance')


def supports_post_only(exchange) -> bool:
    """True when a post-only limit order can be placed on this exchange.

    Deliberately a positive list rather than ``has['createPostOnlyOrder']``:
    that flag is None on Kraken even though the driver does support the param,
    so trusting it would disable a feature that works.

    Robinhood's crypto API has no post-only concept, so this returns False and
    :func:`create_limit_order` refuses rather than quietly placing a taker order.
    """
    return getattr(exchange, 'id', None) in _POST_ONLY_EXCHANGES


def get_balance(exchange: ccxt.Exchange) -> dict:
    """Return account balances.  Non-zero ``'total'`` entries are extracted.

    Deliberately still ``total`` and still strings: the automation worker's
    balance_threshold triggers and the portfolio history series are both built
    on this. Order sizing must use :func:`get_available_balance` instead.
    """
    raw = exchange.fetch_balance()
    totals = raw.get('total', {})
    return {asset: str(amount) for asset, amount in totals.items()
            if amount and float(amount) > 0}


def get_available_balance(exchange: ccxt.Exchange) -> dict[str, float]:
    """Free (spendable) balance per asset — NOT total.

    ``get_balance()`` returns ``total``, which includes everything already
    committed to resting orders. Sizing a new order off it is how you place a
    ladder whose later rungs are funded by the earlier rungs' own money.

    Every exchange the app supports reports a usable free figure:
      * Kraken   — ``free = balance - hold_trade``, so resting orders are out.
      * Coinbase — ``free = available_balance``, ``used = hold``.
      * Binance  — ``free`` / ``locked`` straight from the account endpoint.
      * Robinhood — via ``fetch_available_balance`` on the adapter, which also
        folds in cash buying power (``/holdings/`` is crypto-only).

    Falls back to ``total`` per asset when ``free`` lacks that one asset, never
    globally — a partially populated ``free`` map is normal, and treating a
    missing entry as zero would refuse orders the user can afford.

    Returns floats, not strings: every caller does arithmetic on these.
    """
    # Robinhood's cash sits outside /holdings/ entirely, so an adapter that can
    # answer more completely than fetch_balance() gets first refusal.
    native = getattr(exchange, 'fetch_available_balance', None)
    if callable(native):
        try:
            out = native()
            if isinstance(out, dict):
                return {asset: float(value) for asset, value in out.items()
                        if value is not None and float(value) > 0}
        except Exception as e:
            print(f"[DEBUG] fetch_available_balance failed on "
                  f"{getattr(exchange, 'id', '?')}: {e}")

    raw = exchange.fetch_balance() or {}
    free = raw.get('free') or {}
    total = raw.get('total') or {}

    out: dict[str, float] = {}
    for asset in set(total) | set(free):
        value = free.get(asset)
        if value is None:
            value = total.get(asset)
        try:
            amount = float(value)
        except (TypeError, ValueError):
            continue
        if amount > 0:
            out[asset] = amount
    return out


# ---------------------------------------------------------------------------
# Limit orders
# ---------------------------------------------------------------------------

_ORDER_SIDES = ('buy', 'sell')


def _normalize_placed_order(raw: dict, symbol: str, side: str, amount: float,
                            price: float, post_only: bool) -> dict:
    """Uniform result for a freshly placed order.

    Echoes the amount/price actually SENT alongside whatever the exchange
    reported, because the two differ after precision snapping and the caller has
    to be able to show what really got placed, not what was typed. Coinbase in
    particular answers ``createOrder`` with little more than an id, so ``sent``
    is often the only trustworthy pair of numbers here.
    """
    raw = raw if isinstance(raw, dict) else {}
    return {
        'id': str(raw.get('id') or ''),
        'symbol': raw.get('symbol') or symbol,
        'side': raw.get('side') or side,
        'type': raw.get('type') or 'limit',
        'status': raw.get('status') or 'open',
        'amount': float(raw.get('amount') or amount),
        'price': float(raw.get('price') or price),
        'filled': float(raw.get('filled') or 0.0),
        'cost': amount * price,
        'timestamp': raw.get('timestamp'),
        'post_only': bool(post_only),
        'sent': {'amount': amount, 'price': price},
    }


def create_limit_order(exchange: ccxt.Exchange, symbol: str, side: str,
                       amount: float, price: float,
                       post_only: bool = False,
                       time_in_force: str | None = None,
                       client_order_id: str | None = None,
                       market: dict | None = None) -> dict:
    """Place a single resting LIMIT order on *symbol*.

    Unlike :func:`convert`, the pair is DIRECTIONAL: *symbol* must be a listed
    ``BASE/QUOTE`` market, *amount* is always in the base asset and *price* is
    always quote-per-base. There is deliberately no ``QUOTE/BASE`` fallback —
    an inverted market would silently invert the meaning of *price*, which on a
    pair like BTC/USDT is a factor-of-60,000 error.

    Amount and price are snapped to the exchange's tick sizes BEFORE the minimum
    checks, because snapping the amount down can push a request that looked fine
    on the raw number below the minimum — and the exchange would then reject an
    order the app had already accepted.

    ``time_in_force`` is left unset by default: GTC is the default on every
    exchange the app supports, so sending it explicitly buys nothing. The kwarg
    exists as a seam for a future IOC feature.

    Raises ``ValueError`` for anything the caller can fix (unlisted symbol, bad
    side, below minimum, above maximum, post-only unsupported) and lets genuine
    exchange failures propagate as ccxt / Robinhood exceptions.
    """
    side = (side or '').strip().lower()
    if side not in _ORDER_SIDES:
        raise ValueError(f"Invalid order side '{side}'. Must be 'buy' or 'sell'.")

    symbol = (symbol or '').strip().upper()
    if not symbol:
        raise ValueError("A trading pair is required")

    if market is None:
        exchange.load_markets()
        market = (exchange.markets or {}).get(symbol)
    if not market:
        raise ValueError(f"{symbol} is not a market on {exchange.id}")
    if market.get('active') is False:
        raise ValueError(f"{symbol} is not currently tradable on {exchange.id}")
    if not is_spot_market(market):
        raise ValueError(f"{symbol} is not a spot market on {exchange.id}")

    try:
        amount = float(amount)
        price = float(price)
    except (TypeError, ValueError):
        raise ValueError("Amount and price must be numbers")
    if amount <= 0:
        raise ValueError("Amount must be greater than zero")
    if price <= 0:
        raise ValueError("Limit price must be greater than zero")

    base, quote = market_base_quote(symbol, market)

    # Snap first, THEN validate — see the docstring.
    amount = _to_amount_precision(exchange, symbol, market, amount)
    price = _to_price_precision(exchange, symbol, market, price)
    if amount <= 0:
        raise ValueError(f"Amount rounds to zero at {symbol}'s precision on {exchange.id}")
    if price <= 0:
        raise ValueError(f"Limit price rounds to zero at {symbol}'s precision on {exchange.id}")

    limits = market.get('limits') or {}
    min_amount = (limits.get('amount') or {}).get('min')
    max_amount = (limits.get('amount') or {}).get('max')
    min_cost = (limits.get('cost') or {}).get('min')
    max_cost = (limits.get('cost') or {}).get('max')
    min_price = (limits.get('price') or {}).get('min')
    max_price = (limits.get('price') or {}).get('max')
    cost = amount * price

    if min_amount and amount < float(min_amount):
        raise ValueError(
            f"{amount:.10g} {base} is below {symbol}'s minimum order size of "
            f"{float(min_amount):.10g} {base} on {exchange.id}")
    if max_amount and amount > float(max_amount):
        raise ValueError(
            f"{amount:.10g} {base} is above {symbol}'s maximum order size of "
            f"{float(max_amount):.10g} {base} on {exchange.id}")
    if min_cost and cost < float(min_cost):
        raise ValueError(
            f"Order value {cost:.8g} {quote} is below {symbol}'s minimum of "
            f"{float(min_cost):.8g} {quote} on {exchange.id}")
    if max_cost and cost > float(max_cost):
        raise ValueError(
            f"Order value {cost:.8g} {quote} is above {symbol}'s maximum of "
            f"{float(max_cost):.8g} {quote} on {exchange.id}")
    if min_price and price < float(min_price):
        raise ValueError(
            f"Limit price {price:.10g} is below {symbol}'s minimum price of "
            f"{float(min_price):.10g} on {exchange.id}")
    if max_price and price > float(max_price):
        raise ValueError(
            f"Limit price {price:.10g} is above {symbol}'s maximum price of "
            f"{float(max_price):.10g} on {exchange.id}")

    params: dict = {}
    if post_only:
        if not supports_post_only(exchange):
            raise ValueError(f"{exchange.id} does not support post-only limit orders")
        params['postOnly'] = True
    if time_in_force:
        params['timeInForce'] = str(time_in_force).upper()
    if client_order_id:
        params['clientOrderId'] = str(client_order_id)

    raw = exchange.create_order(symbol, 'limit', side, amount, price, params)
    return _normalize_placed_order(raw, symbol, side, amount, price, post_only)


_USD_STABLES = {'USD', 'USDT', 'USDC', 'DAI', 'USDD', 'TUSD', 'PYUSD', 'ZUSD'}


def _ticker_price(ticker: dict | None) -> float | None:
    """Best available price from a CCXT ticker.

    Some exchanges (notably Coinbase Advanced) return ``last`` as null and only
    populate ``close`` or bid/ask — which used to make those holdings unpriceable
    and silently dropped from the portfolio. Fall back through
    last → close → mid(bid, ask) → bid/ask.
    """
    if not ticker:
        return None

    def _num(v):
        try:
            f = float(v)
            return f if f > 0 else None
        except (TypeError, ValueError):
            return None

    for key in ('last', 'close'):
        p = _num(ticker.get(key))
        if p is not None:
            return p

    bid, ask = _num(ticker.get('bid')), _num(ticker.get('ask'))
    if bid is not None and ask is not None:
        return (bid + ask) / 2.0
    return bid if bid is not None else ask


# Ceiling on per-symbol ticker calls when an exchange has no bulk endpoint.
# This is the Robinhood guard: it has no fetchTickers, so a wide pair list would
# otherwise spend a large slice of its 100 req/min budget just opening a dropdown.
_PER_SYMBOL_PRICE_CAP = 12


def limit_order_markets(exchange: ccxt.Exchange, base_asset: str) -> list[dict]:
    """Listed spot markets where *base_asset* is the BASE, with order metadata.

    Directional on purpose. The inverse-pair fallback that :func:`convert` and
    :func:`has_convert_pair` rely on is correct for market converts but wrong
    here: a limit order's ``price`` means quote-per-base of the specific market
    it rests on, so offering ``USDT -> BTC`` because ``BTC/USDT`` exists would
    price the order upside down.

    Each entry carries the tick sizes, their decimal-place equivalents, and the
    min/max amount and cost the exchange enforces. Prices and balances are added
    by the caller — they are per-user and must never be cached alongside this.
    """
    base_asset = (base_asset or '').strip().upper()
    if not base_asset:
        return []
    exchange.load_markets()

    out: list[dict] = []
    for symbol, market in (exchange.markets or {}).items():
        if market.get('active') is False or not is_spot_market(market):
            continue
        base, quote = market_base_quote(symbol, market)
        if base != base_asset or not quote:
            continue

        precision = market.get('precision') or {}
        limits = market.get('limits') or {}
        amount_tick = precision.get('amount')
        price_tick = precision.get('price')
        out.append({
            'symbol': symbol,
            'base': base,
            'quote': quote,
            'amount_tick': amount_tick,
            'price_tick': price_tick,
            'amount_decimals': tick_decimals(amount_tick),
            'price_decimals': tick_decimals(price_tick),
            'min_amount': (limits.get('amount') or {}).get('min'),
            'max_amount': (limits.get('amount') or {}).get('max'),
            'min_cost': (limits.get('cost') or {}).get('min'),
            'max_cost': (limits.get('cost') or {}).get('max'),
            'stable_quote': quote in _USD_STABLES,
        })

    # USD-ish quotes first — that's what a ladder is almost always priced in —
    # then alphabetical, so the default selection is the useful one.
    out.sort(key=lambda pair: (not pair['stable_quote'], pair['quote']))
    return out


def get_prices_for_symbols(exchange: ccxt.Exchange,
                           symbols: list[str]) -> dict[str, float]:
    """``{symbol: last price}`` for *symbols*, best effort — never raises.

    One bulk call where the exchange has ``fetchTickers``, otherwise one call per
    symbol capped at ``_PER_SYMBOL_PRICE_CAP``. A pair that can't be priced is
    simply absent, so one thin market with no ticker doesn't fail the whole list.
    """
    prices: dict[str, float] = {}
    if not symbols:
        return prices

    if exchange.has.get('fetchTickers'):
        try:
            for symbol, ticker in (exchange.fetch_tickers(symbols) or {}).items():
                price = _ticker_price(ticker)
                if price:
                    prices[symbol] = price
            if prices:
                return prices
        except Exception as e:
            print(f"[DEBUG] fetch_tickers failed on {exchange.id}: {e}")

    for symbol in symbols[:_PER_SYMBOL_PRICE_CAP]:
        try:
            price = _ticker_price(exchange.fetch_ticker(symbol))
            if price:
                prices[symbol] = price
        except Exception:
            continue
    return prices


def get_portfolio(exchange: ccxt.Exchange) -> dict:
    """Value every non-zero holding in USD.

    Returns ``{'positions': [{asset, amount, usd_value}, ...], 'total_usd': float}``
    sorted by USD value descending. Holdings that can't be priced are skipped.
    """
    exchange.load_markets()
    balances = get_balance(exchange)

    tickers: dict = {}
    try:
        if exchange.has.get('fetchTickers'):
            tickers = exchange.fetch_tickers()
    except Exception:
        tickers = {}

    def price_in_usd(asset: str) -> float | None:
        if asset in _USD_STABLES:
            return 1.0
        # Prefer the bulk tickers we already fetched.
        for quote in ('USD', 'USDT', 'USDC'):
            p = _ticker_price(tickers.get(f"{asset}/{quote}"))
            if p is not None:
                return p
        # Fall back to a direct/inverse lookup (handles stablecoin equivalents).
        try:
            return get_market_price(exchange, asset, 'USD')
        except Exception:
            return None

    positions: list[dict] = []
    total = 0.0
    for asset, amt in balances.items():
        try:
            amount = float(amt)
        except (TypeError, ValueError):
            continue
        price = price_in_usd(asset)
        if price is None:
            continue
        usd = amount * price
        if usd > 0:
            positions.append({'asset': asset, 'amount': amount, 'usd_value': usd})
            total += usd

    positions.sort(key=lambda p: p['usd_value'], reverse=True)
    return {'positions': positions, 'total_usd': total}


def get_withdrawal_addresses(exchange: ccxt.Exchange) -> list[dict]:
    """Return whitelisted withdrawal addresses if the exchange supports it.

    Falls back to an empty list when the feature is unavailable.
    """
    # Kraken exposes fetchDepositWithdrawFees but not a generic address list
    # through CCXT.  Use the private Kraken endpoint when available.
    if exchange.id == 'kraken':
        try:
            response = exchange.privatePostWithdrawAddresses()
            raw = response.get('result', response) if isinstance(response, dict) else []
            # print(f"[DEBUG] Kraken withdrawal addresses response: {raw}")
            if isinstance(raw, list):
                return [
                    {
                        'nickname_key': a.get('key', ''),
                        'address': a.get('address', ''),
                        'asset': a.get('asset', ''),
                        'method': a.get('method', ''),
                        'verified': a.get('verified', False),
                    }
                    for a in raw
                ]
        except Exception as e:
            print(f"[DEBUG] get_withdrawal_addresses failed: {e}")
    return []


def withdraw(exchange: ccxt.Exchange, asset: str, amount: str,
             address: str, tag: str | None = None,
             params: dict | None = None) -> dict:
    """Execute a withdrawal through CCXT.

    For Kraken the ``address`` field is the *nickname key* of the whitelisted
    address.  We pass it via ``params['key']`` which the Kraken CCXT driver
    accepts.
    """
    extra = dict(params or {})
    if exchange.id == 'kraken':
        extra['key'] = address
        addrs = get_withdrawal_addresses(exchange)
        real_address = next((a['address'] for a in addrs if a['nickname_key'].strip() == address.strip()), address)
        return exchange.withdraw(asset, float(amount), real_address, tag=tag, params=extra)
    return exchange.withdraw(asset, float(amount), address, tag=tag, params=extra)


def validate_keys(exchange: ccxt.Exchange) -> bool:
    """Test credentials by fetching the account balance.

    Returns ``True`` on success.  Raises on auth failures.
    """
    exchange.fetch_balance()
    return True


def convert(exchange: ccxt.Exchange, from_asset: str, to_asset: str,
            amount: float) -> dict:
    """Convert *from_asset* into *to_asset* via a market order.

    Loads the exchange's markets to find a valid trading pair, then:
      - ``FROM/TO`` exists → market sell *amount* of FROM for TO.
      - ``TO/FROM`` exists → market buy TO, spending *amount* of FROM as quote.
    Raises ``ValueError`` when no suitable pair is found or amount is below minimum.
    """
    exchange.load_markets()

    sell_symbol = f"{from_asset}/{to_asset}"
    buy_symbol = f"{to_asset}/{from_asset}"

    if sell_symbol in exchange.markets:
        market = exchange.markets[sell_symbol]
        min_amount = market.get('limits', {}).get('amount', {}).get('min', 0)
        
        if min_amount and amount < min_amount:
            raise ValueError(
                f"Amount {amount} {from_asset} is below the minimum order size "
                f"of {min_amount} {from_asset} for {sell_symbol} on {exchange.id}"
            )
        
        return exchange.create_market_sell_order(sell_symbol, amount)

    if buy_symbol in exchange.markets:
        market = exchange.markets[buy_symbol]
        min_cost = market.get('limits', {}).get('cost', {}).get('min', 0)
        
        if min_cost and amount < min_cost:
            raise ValueError(
                f"Amount {amount} {from_asset} is below the minimum order cost "
                f"of {min_cost} {from_asset} for {buy_symbol} on {exchange.id}"
            )
        
        params: dict = {}
        if exchange.id == 'kraken':
            params['cost'] = amount
            return exchange.create_order(buy_symbol, 'market', 'buy', None, None, params)
        else:
            params['quoteOrderQty'] = amount
            return exchange.create_order(buy_symbol, 'market', 'buy', None, None, params)

    raise ValueError(
        f"No trading pair found for {from_asset}/{to_asset} or "
        f"{to_asset}/{from_asset} on {exchange.id}"
    )


def has_convert_pair(exchange: ccxt.Exchange, from_asset: str, to_asset: str) -> bool:
    """True when ``convert()`` could route *from_asset* into *to_asset*.

    Mirrors the pair lookup in ``convert()`` — either direction of the market is
    usable, since a missing FROM/TO is handled as a quote-amount buy on TO/FROM.
    Markets are loaded once and cached on the exchange instance.
    """
    if not from_asset or not to_asset or from_asset == to_asset:
        return False
    exchange.load_markets()
    markets = exchange.markets or {}
    return f"{from_asset}/{to_asset}" in markets or f"{to_asset}/{from_asset}" in markets


def available_convert_targets(exchange: ccxt.Exchange, from_asset: str,
                              candidates: list[str]) -> list[str]:
    """Filter *candidates* down to those actually tradable against *from_asset*."""
    try:
        exchange.load_markets()
    except Exception:
        # Without a market list we can't tell — offer the full candidate set
        # rather than presenting an empty dropdown. Save-time validation still
        # rejects a pair that doesn't exist.
        return [c for c in candidates if c != from_asset]
    return [c for c in candidates
            if c != from_asset and has_convert_pair(exchange, from_asset, c)]


_STABLECOIN_FALLBACKS: dict[str, list[str]] = {
    'USDT': ['USD', 'USDC'],
    'USDC': ['USD', 'USDT'],
    'BUSD': ['USD', 'USDT'],
    'USD':  ['USDT', 'USDC'],
}


def _fetch_price_for_symbol(exchange: ccxt.Exchange, symbol: str, inverse: bool = False) -> float | None:
    """Fetch last price for a symbol. Returns None if unavailable. Inverts if inverse=True."""
    if symbol not in exchange.markets:
        return None
    price = _ticker_price(exchange.fetch_ticker(symbol))
    if price is None or price <= 0:
        return None
    return (1.0 / price) if inverse else price


def get_market_price(exchange: ccxt.Exchange, base_asset: str, quote_asset: str) -> float:
    """Return latest market price for base/quote.

    If only the inverse pair exists, the returned price is inverted.
    Falls back to stablecoin equivalents (e.g. USDT -> USD) when the
    exact pair is not listed on the exchange (common on Kraken).
    """
    exchange.load_markets()

    quotes_to_try = [quote_asset] + [
        q for q in _STABLECOIN_FALLBACKS.get(quote_asset, [])
        if q != quote_asset
    ]

    for quote in quotes_to_try:
        direct_symbol = f"{base_asset}/{quote}"
        inverse_symbol = f"{quote}/{base_asset}"

        price = _fetch_price_for_symbol(exchange, direct_symbol)
        if price is not None:
            return price

        price = _fetch_price_for_symbol(exchange, inverse_symbol, inverse=True)
        if price is not None:
            return price

    raise ValueError(
        f"No trading pair found for {base_asset}/{quote_asset} or "
        f"{quote_asset}/{base_asset} on {exchange.id}"
    )


_EXTREME_TIMEFRAMES = ('1m', '3m', '5m', '15m')


def _resolve_ohlcv_pair(exchange: ccxt.Exchange, base_asset: str,
                        quote_asset: str) -> tuple[str | None, bool]:
    """Find a listed market for base/quote, returning ``(symbol, inverted)``.

    Mirrors ``get_market_price``'s quote fallbacks (Kraken lists USD, not USDT,
    for a lot of pairs) but only needs the market to exist, not to have a price.
    """
    quotes_to_try = [quote_asset] + [
        q for q in _STABLECOIN_FALLBACKS.get(quote_asset, []) if q != quote_asset
    ]
    markets = exchange.markets or {}
    for quote in quotes_to_try:
        if f"{base_asset}/{quote}" in markets:
            return f"{base_asset}/{quote}", False
        if f"{quote}/{base_asset}" in markets:
            return f"{quote}/{base_asset}", True
    return None, False


def _smallest_timeframe(exchange: ccxt.Exchange) -> str:
    """The finest candle interval this exchange offers, out of the useful ones."""
    available = exchange.timeframes or {}
    for timeframe in _EXTREME_TIMEFRAMES:
        if timeframe in available:
            return timeframe
    return '1m'


def get_price_extremes(exchange: ccxt.Exchange, base_asset: str, quote_asset: str,
                       since_ms: int) -> dict:
    """Highest and lowest traded price since *since_ms*, from candles.

    ``fetch_ticker`` answers "what is the price right now", which is blind to
    anything that happened between two polls — a spike that rises and falls
    inside one poll interval is invisible to it. Candle highs and lows are the
    record of what the price actually *reached* in that window, so a rule can
    trigger on a wick it never sampled.

    Returns ``{'high', 'low', 'last', 'symbol', 'inverted', 'candles', 'source'}``.
    Raises when the exchange has no market or no candle history for the pair;
    callers fall back to a ticker sample.
    """
    exchange.load_markets()
    symbol, inverted = _resolve_ohlcv_pair(exchange, base_asset, quote_asset)
    if not symbol:
        raise ValueError(
            f"No trading pair found for {base_asset}/{quote_asset} or "
            f"{quote_asset}/{base_asset} on {exchange.id}"
        )

    timeframe = _smallest_timeframe(exchange)
    candles = exchange.fetch_ohlcv(symbol, timeframe=timeframe, since=since_ms, limit=1000)
    if not candles:
        raise ValueError(f"No {timeframe} candles returned for {symbol} on {exchange.id}")

    # Not every exchange honours `since`, and the candle that *contains* since is
    # wanted even though it starts before it — keep anything still open at that
    # point, and drop older candles so a stale wick can't trigger a rule.
    span_ms = exchange.parse_timeframe(timeframe) * 1000
    in_window = [c for c in candles if (c[0] + span_ms) > since_ms]
    if not in_window:
        in_window = candles[-1:]

    highs = [c[2] for c in in_window if c[2]]
    lows = [c[3] for c in in_window if c[3]]
    closes = [c[4] for c in in_window if c[4]]
    if not highs or not lows or not closes:
        raise ValueError(f"Incomplete {timeframe} candle data for {symbol}")

    high, low, last = max(highs), min(lows), closes[-1]
    if inverted:
        # Only the inverse pair is listed, so every price flips — and the
        # inversion swaps the extremes: the cheapest quote/base is the dearest
        # base/quote. Getting this backwards would compare a low to a target.
        high, low, last = 1.0 / low, 1.0 / high, 1.0 / last

    return {
        'high': high,
        'low': low,
        'last': last,
        'symbol': symbol,
        'inverted': inverted,
        'timeframe': timeframe,
        'candles': len(in_window),
        'source': 'candles',
    }


def get_ohlcv_price_map(exchange: ccxt.Exchange, base_asset: str,
                        since_ts_sec: int, timeframe: str = '30m',
                        bucket_seconds: int = 1800) -> dict:
    """Return ``{bucket_epoch_sec: close_price_usd}`` for an asset from ``since``.

    Used to value historical holdings when backfilling gaps. Each candle's
    timestamp is floored to a ``bucket_seconds`` bucket so it lines up with
    stored snapshots. Returns an empty dict if no USD-ish pair exists or the
    exchange doesn't support OHLCV.
    """
    exchange.load_markets()
    since_ms = int(since_ts_sec * 1000)
    for quote in ('USD', 'USDT', 'USDC'):
        symbol = f"{base_asset}/{quote}"
        if symbol not in exchange.markets:
            continue
        try:
            candles = exchange.fetch_ohlcv(symbol, timeframe=timeframe,
                                           since=since_ms, limit=1000)
        except Exception:
            return {}
        out: dict = {}
        for c in candles:
            ts = int(c[0] // 1000)
            bucket = ts - (ts % bucket_seconds)
            out[bucket] = float(c[4])
        return out
    return {}
