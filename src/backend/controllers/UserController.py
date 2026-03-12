from flask import Blueprint, request
from controllers.UserDbContext import UserDbContext
from controllers.AuthDbContext import AuthDbContext
from helper.Security import token_required, hash_password, verify_password, encrypt_api_key, decrypt_api_key
from helper.ErrorHandler import handle_error, bad_request, not_found
from helper.Helper import success_response
from helper.KrakenClient import get_account_balance
import requests as http_requests

user_bp = Blueprint('user', __name__)


@user_bp.route('/profile', methods=['GET'])
@token_required
def get_profile():
    try:
        user = UserDbContext.get_user_by_id(request.user_id)
        
        if not user:
            return not_found("User not found")
        
        return success_response(data=user.to_dict())
        
    except Exception as e:
        return handle_error(e)


@user_bp.route('/update-password', methods=['PUT'])
@token_required
def update_password():
    try:
        data = request.get_json()
        
        if not data:
            return bad_request("No data provided")
        
        current_password = data.get('currentPassword', '')
        new_password = data.get('newPassword', '')
        
        if not current_password or not new_password:
            return bad_request("Current password and new password are required")
        
        if len(new_password) < 6:
            return bad_request("New password must be at least 6 characters")
        
        user = UserDbContext.get_user_by_id(request.user_id)
        if not user:
            return not_found("User not found")
        
        if not verify_password(current_password, user.password_hash):
            return bad_request("Current password is incorrect")
        
        new_hash = hash_password(new_password)
        UserDbContext.update_password(request.user_id, new_hash)
        
        return success_response(message="Password updated successfully")
        
    except Exception as e:
        return handle_error(e)


@user_bp.route('/update-username', methods=['PUT'])
@token_required
def update_username():
    try:
        data = request.get_json()

        if not data:
            return bad_request("No data provided")

        new_username = data.get('username', '').strip()

        if not new_username or len(new_username) < 3:
            return bad_request("Username must be at least 3 characters")

        if AuthDbContext.username_exists(new_username):
            existing = AuthDbContext.get_user_by_username(new_username)
            if existing and existing.id != request.user_id:
                return bad_request("Username is already taken")

        UserDbContext.update_username(request.user_id, new_username)

        user = UserDbContext.get_user_by_id(request.user_id)
        return success_response(data=user.to_dict(), message="Username updated successfully")

    except Exception as e:
        return handle_error(e)


@user_bp.route('/update-keys', methods=['PUT'])
@token_required
def update_kraken_keys():
    try:
        data = request.get_json()
        
        if not data:
            return bad_request("No data provided")
        
        api_key = data.get('krakenApiKey', '').strip()
        private_key = data.get('krakenPrivateKey', '').strip()
        
        if not api_key or not private_key:
            return bad_request("Both API key and private key are required")
        
        api_key_encrypted = encrypt_api_key(api_key)
        private_key_encrypted = encrypt_api_key(private_key)
        
        UserDbContext.update_kraken_keys(request.user_id, api_key_encrypted, private_key_encrypted)
        UserDbContext.clear_keys_validation(request.user_id)
        
        return success_response(message="Kraken API keys updated successfully")
        
    except Exception as e:
        return handle_error(e)


AUTH_ERROR_KEYWORDS = [
    'EAPI:INVALID KEY', 'EAPI:INVALID SIGNATURE', 'EAPI:INVALID NONCE',
    'EAPI:PERMISSION DENIED', 'INVALID API-KEY', 'INVALID API-SIGN',
    'PERMISSION DENIED',
]


@user_bp.route('/validate-keys', methods=['POST'])
@token_required
def validate_keys():
    try:
        user = UserDbContext.get_user_by_id(request.user_id)

        if not user:
            return not_found("User not found")

        if not user.kraken_api_key_encrypted or not user.kraken_private_key_encrypted:
            return success_response(data={'valid': False, 'error': 'No API keys configured'})

        api_key = decrypt_api_key(user.kraken_api_key_encrypted)
        private_key = decrypt_api_key(user.kraken_private_key_encrypted)

        try:
            result = get_account_balance(api_key, private_key)

            if result.get('error') and len(result['error']) > 0:
                error_msg = str(result['error'][0])

                if any(kw in error_msg.upper() for kw in AUTH_ERROR_KEYWORDS):
                    UserDbContext.mark_keys_invalid(request.user_id)
                    return success_response(data={'valid': False, 'error': error_msg})
                else:
                    return success_response(data={'valid': None, 'error': 'Unable to validate: ' + error_msg})

            UserDbContext.mark_keys_valid(request.user_id)
            return success_response(data={'valid': True})

        except http_requests.exceptions.Timeout:
            return success_response(data={'valid': None, 'error': 'Connection timeout'})

        except http_requests.exceptions.ConnectionError:
            return success_response(data={'valid': None, 'error': 'Network connection failed'})

        except Exception:
            return success_response(data={'valid': None, 'error': 'Unable to verify connection'})

    except Exception as e:
        return handle_error(e)


@user_bp.route('/delete', methods=['DELETE'])
@token_required
def delete_account():
    try:
        UserDbContext.delete_user(request.user_id)
        return success_response(message="Account deleted successfully")
        
    except Exception as e:
        return handle_error(e)
