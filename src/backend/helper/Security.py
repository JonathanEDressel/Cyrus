import jwt
import bcrypt
import datetime
from functools import wraps
from flask import request, current_app
from helper.ErrorHandler import unauthorized
from cryptography.fernet import Fernet
import base64
import hashlib


def hash_password(password: str) -> str:
    """Hash a password using bcrypt."""
    salt = bcrypt.gensalt()
    return bcrypt.hashpw(password.encode('utf-8'), salt).decode('utf-8')


def verify_password(password: str, hashed: str) -> bool:
    """Verify a password against its hash."""
    return bcrypt.checkpw(password.encode('utf-8'), hashed.encode('utf-8'))


def generate_token(user_id: int, username: str) -> str:
    """Generate a JWT token for the user."""
    payload = {
        'user_id': user_id,
        'username': username,
        'exp': datetime.datetime.utcnow() + datetime.timedelta(hours=24),
        'iat': datetime.datetime.utcnow()
    }
    return jwt.encode(payload, current_app.config['SECRET_KEY'], algorithm='HS256')


def decode_token(token: str) -> dict:
    """Decode and validate a JWT token."""
    return jwt.decode(token, current_app.config['SECRET_KEY'], algorithms=['HS256'])


def token_required(f):
    """Decorator to require a valid JWT token."""
    @wraps(f)
    def decorated(*args, **kwargs):
        token = None
        
        if 'Authorization' in request.headers:
            auth_header = request.headers['Authorization']
            if auth_header.startswith('Bearer '):
                token = auth_header.split(' ')[1]
        
        if not token:
            return unauthorized("Token is missing")
        
        try:
            data = decode_token(token)
            request.user_id = data['user_id']
            request.username = data['username']
        except jwt.ExpiredSignatureError:
            return unauthorized("Token has expired")
        except jwt.InvalidTokenError:
            return unauthorized("Invalid token")
        
        return f(*args, **kwargs)
    
    return decorated


def _get_encryption_key() -> bytes:
    """Generate a Fernet key from the Flask SECRET_KEY."""
    # Use the SECRET_KEY to derive a consistent 32-byte key
    key_material = current_app.config['SECRET_KEY'].encode('utf-8')
    # Generate a 32-byte key using SHA-256
    key = hashlib.sha256(key_material).digest()
    # Fernet requires a base64-encoded 32-byte key
    return base64.urlsafe_b64encode(key)


def encrypt_api_key(api_key: str) -> str:
    """Encrypt an API key using Fernet symmetric encryption."""
    if not api_key:
        return None
    
    fernet = Fernet(_get_encryption_key())
    encrypted = fernet.encrypt(api_key.encode('utf-8'))
    return encrypted.decode('utf-8')


def decrypt_api_key(encrypted_key: str) -> str:
    """Decrypt an API key using Fernet symmetric encryption."""
    if not encrypted_key:
        return None
    
    fernet = Fernet(_get_encryption_key())
    decrypted = fernet.decrypt(encrypted_key.encode('utf-8'))
    return decrypted.decode('utf-8')
