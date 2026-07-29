from flask import Blueprint, request, jsonify
from helper.Security import token_required, active_required
from helper.ErrorHandler import handle_error, bad_request, not_found
from helper.Helper import success_response
from helper.ExchangeRegistry import get_user_exchange, get_connection_row
from helper.ExchangeClient import get_open_orders, get_withdrawal_addresses, get_balance, get_portfolio
import ccxt
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
            })

        return success_response(data=orders)

    except ccxt.AuthenticationError as e:
        return _keys_invalid_response(str(e))
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
