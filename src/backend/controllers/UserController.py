from flask import Blueprint, request
from controllers.UserDbContext import UserDbContext
from controllers.AuthDbContext import AuthDbContext
from controllers.ExchangeConnectionDbContext import ExchangeConnectionDbContext
from helper.Security import token_required, hash_password, verify_password, encrypt_api_key, decrypt_api_key
from helper.ErrorHandler import handle_error, bad_request, not_found
from helper.Helper import success_response

user_bp = Blueprint('user', __name__)


@user_bp.route('/update-active', methods=['PUT'])
@token_required
def update_active():
    try:
        data = request.get_json()
        if not data or 'is_active' not in data:
            return bad_request("is_active field is required")

        is_active = bool(data['is_active'])
        UserDbContext.update_active(request.user_id, is_active)

        user = UserDbContext.get_user_by_id(request.user_id)
        return success_response(data=user.to_dict(), message="Account status updated")
    except Exception as e:
        return handle_error(e)


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

@user_bp.route('/update-email-notifications', methods=['PUT'])
@token_required
def update_email_notifications():
    try:
        data = request.get_json() or {}

        enabled = bool(data.get('email_notifications_enabled', False))
        notify_email = (data.get('notify_email') or '').strip()
        smtp_host = (data.get('smtp_host') or '').strip() or None
        smtp_port_raw = data.get('smtp_port')
        # New password only if the user actually typed one this time.
        smtp_password = data.get('smtp_password')

        smtp_port = None
        if smtp_port_raw not in (None, ''):
            try:
                smtp_port = int(smtp_port_raw)
            except (TypeError, ValueError):
                return bad_request("smtp_port must be a number")

        if notify_email and '@' not in notify_email:
            return bad_request("A valid email address is required")

        user = UserDbContext.get_user_by_id(request.user_id)
        if not user:
            return not_found("User not found")

        update_password = bool(smtp_password)
        encrypted = encrypt_api_key(smtp_password) if update_password else None

        # Guard: can't enable without an address and a stored/new app password.
        if enabled:
            if not notify_email:
                return bad_request("An email address is required to enable email notifications")
            has_password = update_password or bool(user.smtp_password_encrypted)
            if not has_password:
                return bad_request("An SMTP app password is required to enable email notifications")

        UserDbContext.update_email_notifications(
            request.user_id, enabled, notify_email or None,
            smtp_host, smtp_port,
            smtp_password_encrypted=encrypted, update_password=update_password,
        )

        user = UserDbContext.get_user_by_id(request.user_id)
        return success_response(data=user.to_dict(), message="Email notification settings saved")
    except Exception as e:
        return handle_error(e)


@user_bp.route('/test-email', methods=['POST'])
@token_required
def test_email():
    try:
        from helper.notifier import send_email

        data = request.get_json() or {}
        user = UserDbContext.get_user_by_id(request.user_id)
        if not user:
            return not_found("User not found")

        # Prefer values typed in the form (lets the user test before saving),
        # falling back to whatever is already stored.
        notify_email = (data.get('notify_email') or user.notify_email or '').strip()
        smtp_host = (data.get('smtp_host') or '').strip() or user.smtp_host
        smtp_port_raw = data.get('smtp_port')
        smtp_port = user.smtp_port
        if smtp_port_raw not in (None, ''):
            try:
                smtp_port = int(smtp_port_raw)
            except (TypeError, ValueError):
                return bad_request("smtp_port must be a number")

        typed_password = data.get('smtp_password')
        if typed_password:
            password = typed_password
        elif user.smtp_password_encrypted:
            password = decrypt_api_key(user.smtp_password_encrypted)
        else:
            password = None

        if not notify_email:
            return bad_request("An email address is required")
        if not password:
            return bad_request("An SMTP app password is required to send a test email")

        send_email(
            to_addr=notify_email,
            subject="Cyrus test email",
            body="This is a test from Cyrus. Your email notifications are configured correctly.",
            smtp_user=notify_email,
            smtp_password=password,
            smtp_host=smtp_host,
            smtp_port=smtp_port,
        )
        return success_response(message=f"Test email sent to {notify_email}")
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

@user_bp.route('/update-theme', methods=['PUT'])
@token_required
def update_theme():
    try:
        data = request.get_json()
        if data is None or 'theme' not in data:
            return bad_request("theme is required")
        theme = data['theme']
        if theme not in ('dark', 'light'):
            return bad_request("theme must be 'dark' or 'light'")
        UserDbContext.update_theme(request.user_id, theme)
        user = UserDbContext.get_user_by_id(request.user_id)
        return success_response(data=user.to_dict(), message="Theme preference saved")
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
