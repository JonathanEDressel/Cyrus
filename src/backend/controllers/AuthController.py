from flask import Blueprint, request
from controllers.AuthDbContext import AuthDbContext
from helper.Security import hash_password, verify_password, generate_token, encrypt_api_key
from helper.ErrorHandler import handle_error, bad_request
from helper.Helper import success_response, created_response

auth_bp = Blueprint('auth', __name__)


@auth_bp.route('/register', methods=['POST'])
def register():
    """Create a new user account."""
    try:
        data = request.get_json()
        
        if not data:
            return bad_request("No data provided")
        
        username = data.get('username', '').strip()
        password = data.get('password', '')
        kraken_api_key = data.get('krakenApiKey', '').strip()
        kraken_private_key = data.get('krakenPrivateKey', '').strip()
        
        if not username:
            return bad_request("Username is required")
        
        if len(username) < 3:
            return bad_request("Username must be at least 3 characters")
        
        if not password or len(password) < 6:
            return bad_request("Password must be at least 6 characters")
        
        if not kraken_api_key:
            return bad_request("Kraken API key is required")
        
        if not kraken_private_key:
            return bad_request("Kraken private key is required")
        
        if AuthDbContext.username_exists(username):
            return bad_request("Username already exists")
        
        password_hashed = hash_password(password)
        
        # Encrypt the Kraken API keys before storing
        api_key_encrypted = encrypt_api_key(kraken_api_key)
        private_key_encrypted = encrypt_api_key(kraken_private_key)
        
        user = AuthDbContext.create_user(
            username=username,
            password_hash=password_hashed,
            kraken_api_key_encrypted=api_key_encrypted,
            kraken_private_key_encrypted=private_key_encrypted
        )
        
        return created_response(
            data=user.to_dict(),
            message="Account created successfully"
        )
        
    except Exception as e:
        return handle_error(e)


@auth_bp.route('/login', methods=['POST'])
def login():
    """Authenticate a user and return a JWT token."""
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
        
        return success_response(
            data={
                "token": token,
                "user": user.to_dict()
            },
            message="Login successful"
        )
        
    except Exception as e:
        return handle_error(e)
