"""Unified exchange client built on top of CCXT.

Every public helper accepts a ready-made ``ccxt.Exchange`` instance so the
caller owns the lifecycle and the functions stay stateless / exchange-agnostic.
"""

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
    """Return a list of closed orders in CCXT unified format."""
    return exchange.fetch_closed_orders(symbol, since=since)


def get_balance(exchange: ccxt.Exchange) -> dict:
    """Return account balances.  Non-zero ``'total'`` entries are extracted."""
    raw = exchange.fetch_balance()
    totals = raw.get('total', {})
    return {asset: str(amount) for asset, amount in totals.items()
            if amount and float(amount) > 0}


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
