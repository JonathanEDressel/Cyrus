from flask import Blueprint, request, jsonify
from helper.Security import token_required, active_required
from helper.ErrorHandler import handle_error, bad_request, not_found
from helper.Helper import success_response
from helper.ExchangeRegistry import get_user_exchange, get_connection_row
from helper.ExchangeClient import get_open_orders, get_withdrawal_addresses, get_balance
import ccxt

exchange_data_bp = Blueprint('exchange_data', __name__)


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
