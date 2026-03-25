from flask import Blueprint, request
from controllers.UserDbContext import UserDbContext
from controllers.AuthDbContext import AuthDbContext
from controllers.ExchangeConnectionDbContext import ExchangeConnectionDbContext
from helper.Security import token_required, hash_password, verify_password
from helper.ErrorHandler import handle_error, bad_request, not_found
from helper.Helper import success_response

user_bp = Blueprint('user', __name__)


@user_bp.route('/profile', methods=['GET'])
@token_required
def get_profile():
    try:
        user = UserDbContext.get_user_by_id(request.user_id)
        
        if not user:
            return not_found("User not found")
        
        profile = user.to_dict()

        # Include exchange connections summary
        connections = ExchangeConnectionDbContext.get_connections_by_user(request.user_id)
        profile['exchange_connections'] = [
            {
                'id': c['id'],
                'exchange_name': c['exchange_name'],
                'label': c['label'],
                'is_validated': bool(c.get('is_validated', 0)),
                'is_sandbox': bool(c.get('is_sandbox', 0)),
                'keys_last_validated': c.get('keys_last_validated'),
            }
            for c in connections
        ]
        profile['has_validated_connection'] = any(c.get('is_validated') for c in connections)

        return success_response(data=profile)
        
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


@user_bp.route('/update-notifications', methods=['PUT'])
@token_required
def update_notifications():
    try:
        data = request.get_json()
        if data is None or 'notifications_enabled' not in data:
            return bad_request("notifications_enabled is required")
        enabled = bool(data['notifications_enabled'])
        UserDbContext.update_notifications(request.user_id, enabled)
        user = UserDbContext.get_user_by_id(request.user_id)
        return success_response(data=user.to_dict(), message="Notification preference saved")
    except Exception as e:
        return handle_error(e)

@user_bp.route('/update-donation-modal', methods=['PUT'])
@token_required
def update_donation_modal():
    try:
        data = request.get_json()
        if data is None or 'donation_modal_enabled' not in data:
            return bad_request("donation_modal_enabled is required")
        enabled = bool(data['donation_modal_enabled'])
        UserDbContext.update_donation_modal(request.user_id, enabled)
        user = UserDbContext.get_user_by_id(request.user_id)
        return success_response(data=user.to_dict(), message="Donation modal preference saved")
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
