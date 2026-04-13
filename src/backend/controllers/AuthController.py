from flask import Blueprint, request
from controllers.AuthDbContext import AuthDbContext
from controllers.ExchangeConnectionDbContext import ExchangeConnectionDbContext
from helper.Security import hash_password, verify_password, generate_token
from helper.ErrorHandler import handle_error, bad_request, not_found
from helper.Helper import success_response, created_response

auth_bp = Blueprint('auth', __name__)


@auth_bp.route('/register', methods=['POST'])
def register():
    try:
        data = request.get_json()
        
        if not data:
            return bad_request("No data provided")
        
        username = data.get('username', '').strip()
        password = data.get('password', '')
        
        if not username:
            return bad_request("Username is required")
        
        if len(username) < 3:
            return bad_request("Username must be at least 3 characters")
        
        if not password or len(password) < 6:
            return bad_request("Password must be at least 6 characters")
        
        if AuthDbContext.username_exists(username):
            return bad_request("Username already exists")
        
        password_hashed = hash_password(password)
        
        user = AuthDbContext.create_user(
            username=username,
            password_hash=password_hashed,
        )
        
        return created_response(
            data=user.to_dict(),
            message="Account created successfully"
        )
        
    except Exception as e:
        return handle_error(e)


@auth_bp.route('/login', methods=['POST'])
def login():
    try:
        data = request.get_json()
        
        if not data:
            return bad_request("No data provided")
        
        username = data.get('username', '').strip()
        password = data.get('password', '')
        
        if not username or not password:
            return bad_request("Username and password are required")
        
        user = AuthDbContext.get_user_by_username(username)
        
        if not user:
            return bad_request("Invalid username or password")
        
        if not verify_password(password, user.password_hash):
            return bad_request("Invalid username or password")
        
        AuthDbContext.update_last_login(user.id)
        
        token = generate_token(user.id, user.username)

        user_data = user.to_dict()
        connections = ExchangeConnectionDbContext.get_connections_by_user(user.id)
        user_data['exchange_connections'] = [
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
        user_data['has_validated_connection'] = any(c.get('is_validated') for c in connections)

        return success_response(
            data={
                "token": token,
                "user": user_data
            },
            message="Login successful"
        )
        
    except Exception as e:
        return handle_error(e)


@auth_bp.route('/accounts', methods=['GET'])
def get_accounts():
    try:
        accounts = AuthDbContext.get_all_accounts()
        return success_response(data=[
            {
                'id': a['id'],
                'username': a['username'],
                'created_at': a['created_at'],
                'is_active': bool(a['is_active']),
                'command_count': a['command_count'],
            }
            for a in accounts
        ])
    except Exception as e:
        return handle_error(e)


@auth_bp.route('/accounts/<int:user_id>/toggle-active', methods=['PUT'])
def toggle_account_active(user_id):
    try:
        updated = AuthDbContext.toggle_user_active(user_id)
        if not updated:
            return not_found("Account not found")
        return success_response(
            data={
                'id': updated['id'],
                'username': updated['username'],
                'created_at': updated['created_at'],
                'is_active': bool(updated['is_active']),
            },
            message="Account status updated"
        )
    except Exception as e:
        return handle_error(e)
