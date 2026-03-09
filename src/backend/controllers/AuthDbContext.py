from helper.Helper import execute_query_one, execute_insert, execute_non_query, execute_scalar
from models.UserModel import UserModel


class AuthDbContext:
    """Database operations for authentication."""
    
    @staticmethod
    def get_user_by_username(username: str) -> UserModel:
        row = execute_query_one(
            'SELECT * FROM users WHERE username = %s',
            (username,)
        )
        return UserModel.from_row(row)
    
    @staticmethod
    def create_user(username: str, password_hash: str,
                    kraken_api_key_encrypted: str, kraken_private_key_encrypted: str) -> UserModel:
        user_id = execute_insert(
            '''INSERT INTO users (username, password_hash, kraken_api_key_encrypted, kraken_private_key_encrypted)
               VALUES (%s, %s, %s, %s)''',
            (username, password_hash, kraken_api_key_encrypted, kraken_private_key_encrypted)
        )
        
        row = execute_query_one(
            'SELECT * FROM users WHERE id = %s',
            (user_id,)
        )
        return UserModel.from_row(row)
    
    @staticmethod
    def update_last_login(user_id: int) -> None:
        execute_non_query(
            'UPDATE users SET last_login = NOW() WHERE id = %s',
            (user_id,)
        )
    
    @staticmethod
    def username_exists(username: str) -> bool:
        result = execute_scalar(
            'SELECT 1 FROM users WHERE username = %s',
            (username,)
        )
        return result is not None
