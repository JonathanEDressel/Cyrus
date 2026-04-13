from flask import Blueprint, request
from controllers.ExchangeConnectionDbContext import ExchangeConnectionDbContext
from helper.Security import token_required, encrypt_api_key, active_required
from helper.ErrorHandler import handle_error, bad_request, not_found
from helper.Helper import success_response, created_response
from helper.ExchangeRegistry import (
    SUPPORTED_EXCHANGES, get_supported_exchanges, get_user_exchange
)
from helper.ExchangeClient import validate_keys
import ccxt

exchange_bp = Blueprint('exchanges', __name__)


def _format_connection(row: dict) -> dict:
    """Serialise a connection row for the API (no raw keys)."""
    return {
        'id': row['id'],
        'user_id': row['user_id'],
        'exchange_name': row['exchange_name'],
        'label': row['label'],
        'is_validated': bool(row.get('is_validated', 0)),
        'is_sandbox': bool(row.get('is_sandbox', 0)),
        'keys_last_validated': row.get('keys_last_validated'),
        'created_at': row.get('created_at'),
    }


@exchange_bp.route('/supported', methods=['GET'])
@token_required
@active_required
def supported_exchanges():
    try:
        return success_response(data=get_supported_exchanges())
    except Exception as e:
        return handle_error(e)


@exchange_bp.route('/connections', methods=['GET'])
@token_required
@active_required
def list_connections():
    try:
        rows = ExchangeConnectionDbContext.get_connections_by_user(request.user_id)
        return success_response(data=[_format_connection(r) for r in rows])
    except Exception as e:
        return handle_error(e)


@exchange_bp.route('/connections', methods=['POST'])
@token_required
@active_required
def add_connection():
    try:
        data = request.get_json()
        if not data:
            return bad_request("No data provided")

        exchange_name = data.get('exchange_name', '').strip().lower()
        label = data.get('label', '').strip()
        api_key = data.get('api_key', '').strip()
        private_key = data.get('private_key', '').strip()
        passphrase = data.get('passphrase', '').strip() or None
        is_sandbox = bool(data.get('is_sandbox', False))

        if not exchange_name or exchange_name not in SUPPORTED_EXCHANGES:
            return bad_request(f"Unsupported exchange. Supported: {', '.join(SUPPORTED_EXCHANGES.keys())}")
        if not label:
            return bad_request("Connection label is required")
        if not api_key or not private_key:
            return bad_request("API key and private/secret key are required")

        meta = SUPPORTED_EXCHANGES[exchange_name]
        if meta['requires_passphrase'] and not passphrase:
            return bad_request(f"{meta['name']} requires a passphrase")
        if is_sandbox and not meta.get('has_sandbox', False):
            return bad_request(f"{meta['name']} does not support sandbox mode")

        api_enc = encrypt_api_key(api_key)
        priv_enc = encrypt_api_key(private_key)
        pass_enc = encrypt_api_key(passphrase) if passphrase else None

        conn_id = ExchangeConnectionDbContext.create_connection(
            user_id=request.user_id,
            exchange_name=exchange_name,
            label=label,
            api_key_encrypted=api_enc,
            private_key_encrypted=priv_enc,
            passphrase_encrypted=pass_enc,
            is_sandbox=is_sandbox,
        )

        row = ExchangeConnectionDbContext.get_connection(conn_id, request.user_id)
        return created_response(data=_format_connection(row), message="Exchange connection added")

    except Exception as e:
        if 'UNIQUE constraint' in str(e):
            return bad_request("A connection with this exchange and label already exists")
        return handle_error(e)


@exchange_bp.route('/connections/<int:conn_id>', methods=['PUT'])
@token_required
@active_required
def update_connection(conn_id):
    try:
        row = ExchangeConnectionDbContext.get_connection(conn_id, request.user_id)
        if not row:
            return not_found("Exchange connection not found")

        data = request.get_json()
        if not data:
            return bad_request("No data provided")

        api_key = data.get('api_key', '').strip()
        private_key = data.get('private_key', '').strip()
        passphrase = data.get('passphrase', '').strip() or None

        if not api_key or not private_key:
            return bad_request("API key and private/secret key are required")

        api_enc = encrypt_api_key(api_key)
        priv_enc = encrypt_api_key(private_key)
        pass_enc = encrypt_api_key(passphrase) if passphrase else None

        ExchangeConnectionDbContext.update_connection_keys(
            conn_id, request.user_id, api_enc, priv_enc, pass_enc
        )

        return success_response(message="Connection keys updated. Please re-validate.")

    except Exception as e:
        return handle_error(e)


@exchange_bp.route('/connections/<int:conn_id>', methods=['DELETE'])
@token_required
@active_required
def delete_connection(conn_id):
    try:
        row = ExchangeConnectionDbContext.get_connection(conn_id, request.user_id)
        if not row:
            return not_found("Exchange connection not found")

        active = ExchangeConnectionDbContext.count_active_rules_for_connection(conn_id)
        if active > 0:
            return bad_request(
                f"Cannot delete — {active} active automation rule(s) use this connection. "
                "Disable or delete them first."
            )

        ExchangeConnectionDbContext.delete_connection(conn_id, request.user_id)
        return success_response(message="Exchange connection deleted")

    except Exception as e:
        return handle_error(e)


@exchange_bp.route('/connections/<int:conn_id>/validate', methods=['POST'])
@token_required
@active_required
def validate_connection(conn_id):
    try:
        row = ExchangeConnectionDbContext.get_connection(conn_id, request.user_id)
        if not row:
            return not_found("Exchange connection not found")

        try:
            exchange = get_user_exchange(request.user_id, conn_id)
            validate_keys(exchange)
            ExchangeConnectionDbContext.mark_validated(conn_id, request.user_id)
            return success_response(data={'valid': True})

        except ccxt.AuthenticationError as e:
            ExchangeConnectionDbContext.mark_invalid(conn_id, request.user_id)
            return success_response(data={'valid': False, 'error': str(e)})

        except ccxt.NetworkError:
            return success_response(data={'valid': None, 'error': 'Network connection failed'})

        except ccxt.ExchangeError as e:
            return success_response(data={'valid': None, 'error': str(e)})

        except Exception:
            return success_response(data={'valid': None, 'error': 'Unable to verify connection'})

    except Exception as e:
        return handle_error(e)
