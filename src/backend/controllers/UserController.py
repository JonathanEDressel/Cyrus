from flask import Blueprint, request
from controllers.UserDbContext import UserDbContext
from helper.Security import token_required, hash_password, verify_password
from helper.ErrorHandler import handle_error, bad_request, not_found
from helper.Helper import success_response

user_bp = Blueprint('user', __name__)


@user_bp.route('/profile', methods=['GET'])
@token_required
def get_profile():
    """Get the current user's profile."""
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
    """Update the current user's password."""
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
        
        # Verify current password
        user = UserDbContext.get_user_by_id(request.user_id)
        if not user:
            return not_found("User not found")
        
        if not verify_password(current_password, user.password_hash):
            return bad_request("Current password is incorrect")
        
        # Update password
        new_hash = hash_password(new_password)
        UserDbContext.update_password(request.user_id, new_hash)
        
        return success_response(message="Password updated successfully")
        
    except Exception as e:
        return handle_error(e)


@user_bp.route('/update-keys', methods=['PUT'])
@token_required
def update_kraken_keys():
    """Update the user's Kraken API keys."""
    try:
        data = request.get_json()
        
        if not data:
            return bad_request("No data provided")
        
        api_key = data.get('krakenApiKey', '').strip()
        private_key = data.get('krakenPrivateKey', '').strip()
        
        if not api_key or not private_key:
            return bad_request("Both API key and private key are required")
        
        # TODO: Encrypt keys before storing
        UserDbContext.update_kraken_keys(request.user_id, api_key, private_key)
        
        return success_response(message="Kraken API keys updated successfully")
        
    except Exception as e:
        return handle_error(e)


@user_bp.route('/delete', methods=['DELETE'])
@token_required
def delete_account():
    """Delete the current user's account."""
    try:
        UserDbContext.delete_user(request.user_id)
        return success_response(message="Account deleted successfully")
        
    except Exception as e:
        return handle_error(e)
