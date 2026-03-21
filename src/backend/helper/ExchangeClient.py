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
