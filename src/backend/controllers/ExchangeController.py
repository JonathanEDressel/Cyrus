from flask import Blueprint, request, jsonify
from helper.Security import token_required, active_required
from helper.ErrorHandler import handle_error, bad_request, not_found
from helper.Helper import success_response, created_response
from helper.ExchangeRegistry import (get_user_exchange, get_connection_row,
                                    get_order_pacing_ms)
from helper.ExchangeClient import (get_open_orders, get_withdrawal_addresses, get_balance,
                                   get_portfolio, cancel_order, create_limit_order,
                                   get_available_balance, limit_order_markets,
                                   get_prices_for_symbols, market_base_quote,
                                   supports_post_only, is_spot_market,
                                   is_unknown_pair_error)
from helper.robinhood.errors import (RobinhoodAuthError, RobinhoodError,
                                     RobinhoodNotSupportedError, RobinhoodRateLimitError)
import ccxt
import math
import re
import time

exchange_data_bp = Blueprint('exchange_data', __name__)

# UI range key -> lookback seconds (None = all recorded history).
PORTFOLIO_RANGES = {
    '12H': 12 * 3600,
    '24H': 24 * 3600,
    '7D':  7 * 86400,
    '1M':  30 * 86400,
    '3M':  90 * 86400,
    '6M':  180 * 86400,
    '1Y':  365 * 86400,
    '3Y':  3 * 365 * 86400,
    'ALL': None,
}


def _keys_invalid_response(message):
    return jsonify({"success": False, "result": message, "keys_invalid": True}), 403


def _rate_limited_response(exchange_name, error, retry_after_ms: int = 5000):
    """429 with a retry hint so a placement loop can pause instead of hammering."""
    return jsonify({
        "success": False,
        "result": f"{exchange_name} is rate-limiting requests. Wait a moment "
                  f"before placing the next order. ({error})",
        "rate_limited": True,
        "retry_after_ms": retry_after_ms,
    }), 429


def _unavailable_response(exchange_name, error):
    """503, worded so the caller knows the order's fate is UNKNOWN, not 'failed'.

    A timeout on order entry is genuinely ambiguous — the exchange may well have
    accepted it. Reporting that as a failure invites the user to place a duplicate.
    """
    return jsonify({
        "success": False,
        "result": f"Could not reach {exchange_name}. This order may or may not "
                  f"have been placed — check your open orders before retrying. ({error})",
        "retryable": True,
    }), 503


def _positive_number(value, label):
    """``float(value)`` when finite and positive, else an error message string.

    ``float('nan') > 0`` is already False, but ``float('inf')`` sails through a
    naive check, so finiteness is tested explicitly.
    """
    try:
        number = float(value)
    except (TypeError, ValueError):
        return f"{label} must be a number"
    if not math.isfinite(number):
        return f"{label} must be a finite number"
    if number <= 0:
        return f"{label} must be greater than zero"
    return number


def _safe_client_order_id(value):
    """A conservative client order id, or None.

    Dropped rather than rejected: it's an idempotency nicety (Robinhood dedupes
    on it, so a retried ambiguous request can't double-place), not a requirement,
    and every exchange generates one when it's absent.
    """
    text = str(value or '').strip()
    if not text or len(text) > 64 or not re.fullmatch(r'[A-Za-z0-9_-]+', text):
        return None
    return text


def _is_synthetic_order(order: dict) -> bool:
    """True for a Kraken synthetic-pair order.

    Kraken synthesises some pairs (LUNA/USDT, XDC/USDT) by routing through two
    legs rather than listing them in AssetPairs. Those orders carry
    ``descr.aclass == 'synthetic_pair'`` and an ``SO``-prefixed id, and Kraken's
    own CancelOrder endpoint cannot cancel them — it fails resolving the pair.
    Checked via ``aclass`` first, with the id prefix as a secondary signal.
    """
    info = order.get('info') or {}
    descr = info.get('descr') or {}
    if str(descr.get('aclass') or '').lower() == 'synthetic_pair':
        return True
    return str(order.get('id') or '').startswith('SO')


def _get_validated_exchange(user_id: int, conn_id: int):
    """Load connection, verify it's validated, and return the ccxt instance."""
    row = get_connection_row(user_id, conn_id)
    if not row:
        return None, not_found("Exchange connection not found")
    if not row.get('is_validated'):
        return None, _keys_invalid_response(
            "API keys have not been validated. Please validate them in your profile."
        )
    exchange = get_user_exchange(user_id, conn_id)
    return exchange, None


@exchange_data_bp.route('/<int:conn_id>/open-orders', methods=['GET'])
@token_required
@active_required
def open_orders(conn_id):
    try:
        exchange, err = _get_validated_exchange(request.user_id, conn_id)
        if err:
            return err

        raw_orders = get_open_orders(exchange)
        orders = []
        for o in raw_orders:
            orders.append({
                'id': o.get('id', ''),
                'pair': o.get('symbol', ''),
                'type': o.get('type', ''),
                'side': o.get('side', ''),
                'price': str(o.get('price', '0') or '0'),
                'volume': str(o.get('amount', '0') or '0'),
                'filled': str(o.get('filled', '0') or '0'),
                'status': o.get('status', ''),
                'opentm': o.get('timestamp', 0),
                'description': '',
                # Kraken routes some pairs (LUNA/USDT, XDC/USDT) instead of listing
                # them, and flags those orders 'synthetic_pair'. Its own cancel
                # endpoint then can't resolve the pair, so the UI needs to know
                # before offering a Cancel button that cannot work.
                'synthetic': _is_synthetic_order(o),
            })

        return success_response(data=orders)

    except ccxt.AuthenticationError as e:
        return _keys_invalid_response(str(e))
    except Exception as e:
        return handle_error(e)


@exchange_data_bp.route('/<int:conn_id>/cancel-order', methods=['POST'])
@token_required
@active_required
def cancel_open_order(conn_id):
    """Cancel one of the user's open orders.

    The id and pair travel in the body rather than the path: exchange order ids
    are opaque strings that can contain URL-significant characters, and CCXT
    needs the symbol alongside the id on every exchange except Kraken.
    """
    try:
        payload = request.get_json(silent=True) or {}
        order_id = str(payload.get('order_id') or '').strip()
        symbol = str(payload.get('symbol') or '').strip() or None
        if not order_id:
            return bad_request("order_id is required")

        exchange, err = _get_validated_exchange(request.user_id, conn_id)
        if err:
            return err

        result = cancel_order(exchange, order_id, symbol)
        return success_response(
            data={'id': order_id, 'status': result.get('status') or 'canceled'},
            message="Order canceled",
        )

    except ccxt.OrderNotFound:
        # Filled or already cancelled between the page load and the click —
        # not an error the user can act on, so say what happened plainly.
        return not_found("That order no longer exists. It may have already filled or been canceled.")
    except ccxt.AuthenticationError as e:
        return _keys_invalid_response(str(e))
    except RobinhoodAuthError as e:
        # Robinhood raises its own hierarchy rather than ccxt's, so it needs the
        # keys_invalid flag set here too or the UI won't prompt a re-validation.
        return _keys_invalid_response(str(e))
    except ccxt.ExchangeError as e:
        # Kraken synthetic-pair orders land here: the exchange itself can't
        # resolve their pair on the cancel endpoint. It isn't a 500 — nothing is
        # broken on our side and there IS something the user can do about it, so
        # say exactly what rather than dumping a raw JSON error at them.
        if is_unknown_pair_error(e):
            return bad_request(
                "This looks like a Kraken synthetic-pair order (a pair such as "
                "LUNA/USDT that Kraken routes rather than lists directly). Kraken's "
                "API rejects cancel requests for these because it cannot resolve the "
                "pair, and Cyrus has already retried through Kraken's batch-cancel "
                "endpoint. Cancel it from Kraken's own website or app instead.")
        return handle_error(e)
    except Exception as e:
        return handle_error(e)


@exchange_data_bp.route('/<int:conn_id>/create-order', methods=['POST'])
@token_required
@active_required
def create_order(conn_id):
    """Place ONE limit order. A staggered ladder is the caller invoking this N times.

    Deliberately single-order and stateless: nothing is persisted, so a partially
    placed ladder is exactly N successful orders plus a visible error, with no
    batch state to reconcile.

    Everything is re-validated here. The client's amount and price are a request,
    not a fact — the ladder's prices are generated in the browser, so they are
    attacker-controlled and get re-parsed, re-bounded, re-snapped and re-checked
    against a server-read balance before anything is sent to the exchange.
    """
    exchange_name = '?'
    symbol = '?'
    try:
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return bad_request("A JSON body is required")

        # Pinned, not defaulted. Without this the endpoint would happily accept
        # type='market' and become an unbounded market-order endpoint with no
        # price to check.
        order_type = str(payload.get('type') or 'limit').strip().lower()
        if order_type != 'limit':
            return bad_request(
                "Only limit orders can be placed from here (type must be 'limit')")

        symbol = str(payload.get('symbol') or '').strip().upper()
        if not symbol:
            return bad_request("symbol is required")

        side = str(payload.get('side') or '').strip().lower()
        if side not in ('buy', 'sell'):
            return bad_request("side must be 'buy' or 'sell'")

        amount = _positive_number(payload.get('amount'), 'amount')
        if isinstance(amount, str):
            return bad_request(amount)
        price = _positive_number(payload.get('price'), 'price')
        if isinstance(price, str):
            return bad_request(price)

        post_only = bool(payload.get('post_only'))
        client_order_id = _safe_client_order_id(payload.get('client_order_id'))

        row = get_connection_row(request.user_id, conn_id)
        if not row:
            return not_found("Exchange connection not found")
        exchange_name = row['exchange_name']

        exchange, err = _get_validated_exchange(request.user_id, conn_id)
        if err:
            return err

        exchange.load_markets()
        market = (exchange.markets or {}).get(symbol)
        if not market or market.get('active') is False or not is_spot_market(market):
            return bad_request(f"{symbol} is not a tradable spot market on {exchange_name}")
        base, quote = market_base_quote(symbol, market)
        if not base or not quote:
            return bad_request(f"Could not determine the assets for {symbol}")

        # Read the balance FRESH on every call. A ladder is placed one rung at a
        # time and each resting rung locks funds; Kraken, Coinbase and Binance all
        # report 'free' net of open orders, so a fresh read is precisely what stops
        # rung 12 from being funded by rung 1's money. Caching this — even for a
        # few seconds — is how a ladder overspends. Do not "optimise" it.
        available = get_available_balance(exchange)

        if side == 'sell':
            needed, needed_asset = amount, base
        else:
            needed, needed_asset = amount * price, quote
        have = available.get(needed_asset, 0.0)

        # Relative tolerance, not absolute: a "100% of balance" request lands a
        # float-epsilon over `have`, and rejecting that with a scary message for a
        # 1e-16 shortfall would be worse than useless.
        if needed > have * (1 + 1e-9):
            return bad_request(
                f"Not enough {needed_asset} on {exchange_name}: this order needs "
                f"{needed:.8g} {needed_asset} but only {have:.8g} is available "
                f"(short by {needed - have:.8g}). Resting orders you already have "
                f"hold funds, and a buy also needs headroom for fees.")

        result = create_limit_order(
            exchange, symbol, side, amount, price,
            post_only=post_only, client_order_id=client_order_id, market=market)
        result['exchange'] = exchange_name
        result['connection_id'] = conn_id
        result['base'] = base
        result['quote'] = quote
        return created_response(data=result, message="Limit order placed")

    except ValueError as e:
        # Everything create_limit_order rejects — unlisted, below minimum, rounds
        # to zero, post-only unsupported — is user-fixable.
        return bad_request(str(e))
    except ccxt.InsufficientFunds as e:
        return bad_request(
            f"{exchange_name} rejected the order for insufficient funds. Resting "
            f"orders hold funds, and a buy also needs room for fees. ({e})")
    # BadSymbol before BadRequest — it's a subclass.
    except ccxt.BadSymbol as e:
        return bad_request(f"{symbol} is not a valid market on {exchange_name}: {e}")
    # These two before InvalidOrder, which is their parent.
    except (ccxt.OrderImmediatelyFillable, ccxt.OrderNotFillable) as e:
        return bad_request(
            "The exchange rejected this as a post-only order because the price "
            f"would have crossed the book and filled immediately. ({e})")
    except ccxt.InvalidOrder as e:
        return bad_request(f"{exchange_name} rejected the order: {e}")
    except (ccxt.AuthenticationError, RobinhoodAuthError) as e:
        return _keys_invalid_response(str(e))
    except ccxt.BadRequest as e:
        return bad_request(f"{exchange_name} rejected the order: {e}")
    # RateLimitExceeded and DDoSProtection are SIBLINGS of NetworkError, not
    # children, so they have to be caught before it.
    except (ccxt.RateLimitExceeded, ccxt.DDoSProtection, RobinhoodRateLimitError) as e:
        return _rate_limited_response(exchange_name, e)
    except (ccxt.ExchangeNotAvailable, ccxt.RequestTimeout, ccxt.NetworkError) as e:
        return _unavailable_response(exchange_name, e)
    except RobinhoodNotSupportedError as e:
        return bad_request(str(e))
    # Base class of the Robinhood hierarchy — must stay last of the RH clauses.
    except RobinhoodError as e:
        return handle_error(e, 502)
    except Exception as e:
        return handle_error(e)


@exchange_data_bp.route('/<int:conn_id>/withdrawal-addresses', methods=['GET'])
@token_required
@active_required
def withdrawal_addresses(conn_id):
    try:
        exchange, err = _get_validated_exchange(request.user_id, conn_id)
        if err:
            return err

        addresses = get_withdrawal_addresses(exchange)
        return success_response(data=addresses)

    except ccxt.AuthenticationError as e:
        return _keys_invalid_response(str(e))
    except Exception as e:
        return handle_error(e)


@exchange_data_bp.route('/<int:conn_id>/balance', methods=['GET'])
@token_required
@active_required
def balance(conn_id):
    try:
        exchange, err = _get_validated_exchange(request.user_id, conn_id)
        if err:
            return err

        non_zero = get_balance(exchange)
        return success_response(data=non_zero)

    except ccxt.AuthenticationError as e:
        return _keys_invalid_response(str(e))
    except Exception as e:
        return handle_error(e)


# Tradable assets per exchange, cached in-process: the list is identical for
# every user of that exchange and load_markets() is a heavy call, so a fresh
# ccxt client per request would otherwise refetch it every time a dropdown opens.
_ASSETS_CACHE: dict = {}
ASSETS_CACHE_TTL = 3600


@exchange_data_bp.route('/<int:conn_id>/assets', methods=['GET'])
@token_required
@active_required
def tradable_assets(conn_id):
    """Every asset tradable on this connection's exchange.

    Automation rules can legitimately name a coin you don't hold yet — "when my
    USDG balance reaches 500, convert it" is a perfectly good rule to write
    before the first USDG ever arrives — so the asset pickers need the
    exchange's whole list, not just current balances.
    """
    try:
        row = get_connection_row(request.user_id, conn_id)
        if not row:
            return not_found("Exchange connection not found")
        exchange_name = row['exchange_name']

        cached = _ASSETS_CACHE.get(exchange_name)
        if cached and (time.time() - cached['at']) < ASSETS_CACHE_TTL:
            return success_response(data=cached['assets'])

        exchange, err = _get_validated_exchange(request.user_id, conn_id)
        if err:
            return err

        exchange.load_markets()
        assets = set()
        for symbol, market in (exchange.markets or {}).items():
            if market.get('active') is False:
                continue
            for key in ('base', 'quote'):
                code = (market.get(key) or '').upper()
                if code:
                    assets.add(code)

        ordered = sorted(assets)
        _ASSETS_CACHE[exchange_name] = {'assets': ordered, 'at': time.time()}
        return success_response(data=ordered)

    except ccxt.AuthenticationError as e:
        return _keys_invalid_response(str(e))
    except Exception as e:
        return handle_error(e)


# Directional pair metadata per (exchange_name, asset). Same rationale as
# _ASSETS_CACHE: identical for every user of that exchange, and load_markets() is
# the expensive part. Prices and balances are NEVER cached here — those are
# per-user and change with every order a ladder places.
_PAIRS_CACHE: dict = {}
PAIRS_CACHE_TTL = 3600


@exchange_data_bp.route('/<int:conn_id>/pairs', methods=['GET'])
@token_required
@active_required
def limit_order_pairs(conn_id):
    """Markets on which *asset* can be limit-ordered, with order metadata.

    Directional: only markets where ``asset`` is the BASE, because a limit
    order's price is quote-per-base of the market it rests on. A user who wants
    to spend USDT on BTC is placing a BUY on BTC/USDT, not a sell of USDT — and
    offering the inverse would price the order upside down by a factor of 60,000.

    ``side`` does not change which markets come back (the asset is the base
    either way); it's accepted so the caller can be explicit and so a future
    side-specific filter has somewhere to land.
    """
    try:
        asset = (request.args.get('asset') or '').strip().upper()
        if not asset:
            return bad_request("asset query parameter is required")

        side = (request.args.get('side') or '').strip().lower()
        if side and side not in ('buy', 'sell'):
            return bad_request("side must be 'buy' or 'sell'")

        want_prices = (request.args.get('prices') or '1').lower() not in ('0', 'false')

        row = get_connection_row(request.user_id, conn_id)
        if not row:
            return not_found("Exchange connection not found")
        exchange_name = row['exchange_name']

        exchange, err = _get_validated_exchange(request.user_id, conn_id)
        if err:
            return err

        cache_key = (exchange_name, asset)
        cached = _PAIRS_CACHE.get(cache_key)
        if cached and (time.time() - cached['at']) < PAIRS_CACHE_TTL:
            # Copy out: the decoration below is per-user, and mutating the cached
            # dicts would leak one user's balances into the next user's response.
            pairs = [dict(pair) for pair in cached['pairs']]
        else:
            pairs = limit_order_markets(exchange, asset)
            _PAIRS_CACHE[cache_key] = {'pairs': [dict(p) for p in pairs],
                                       'at': time.time()}

        envelope = {
            'asset': asset,
            'side': side or None,
            'exchange': exchange_name,
            'order_pacing_ms': get_order_pacing_ms(exchange_name),
            'supports_post_only': supports_post_only(exchange),
            'pairs': pairs,
        }

        if not pairs:
            return success_response(
                data=envelope,
                message=f"No {asset} markets are available on {exchange_name}")

        if want_prices:
            prices = get_prices_for_symbols(exchange, [p['symbol'] for p in pairs])
            for pair in pairs:
                pair['price'] = prices.get(pair['symbol'])

        # Balances are read live, never cached — see the note on /create-order.
        try:
            available = get_available_balance(exchange)
        except Exception as e:
            print(f"[DEBUG] available balance unavailable for conn {conn_id}: {e}")
            available = {}
        for pair in pairs:
            pair['available_base'] = available.get(pair['base'], 0.0)
            pair['available_quote'] = available.get(pair['quote'], 0.0)

        return success_response(data=envelope)

    except ccxt.AuthenticationError as e:
        return _keys_invalid_response(str(e))
    except RobinhoodAuthError as e:
        return _keys_invalid_response(str(e))
    except Exception as e:
        return handle_error(e)


@exchange_data_bp.route('/<int:conn_id>/portfolio', methods=['GET'])
@token_required
@active_required
def portfolio(conn_id):
    try:
        exchange, err = _get_validated_exchange(request.user_id, conn_id)
        if err:
            return err

        data = get_portfolio(exchange)
        return success_response(data=data)

    except ccxt.AuthenticationError as e:
        return _keys_invalid_response(str(e))
    except Exception as e:
        return handle_error(e)


@exchange_data_bp.route('/portfolio/history', methods=['GET'])
@token_required
@active_required
def portfolio_history():
    """Portfolio value over time for the Overview line chart.

    Aggregates stored snapshots across the user's connections (or a single one
    when ``conn_id`` is given). No live exchange calls — this reads the history
    the worker has been accumulating.
    """
    try:
        from controllers.PortfolioDbContext import PortfolioDbContext

        range_key = (request.args.get('range') or '1M').upper()
        lookback = PORTFOLIO_RANGES.get(range_key, PORTFOLIO_RANGES['1M'])
        since = None if lookback is None else int(time.time() - lookback)

        conn_arg = request.args.get('conn_id')
        conn_id = None
        if conn_arg and conn_arg.lower() != 'all':
            try:
                conn_id = int(conn_arg)
            except ValueError:
                conn_id = None

        data = PortfolioDbContext.get_history(request.user_id, since, conn_id)
        return success_response(data=data)

    except Exception as e:
        return handle_error(e)
