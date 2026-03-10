from helper.Helper import execute_query_one, execute_non_query
from models.UserModel import UserModel


class UserDbContext:
    """Database operations for user management."""
    
    @staticmethod
    def get_user_by_id(user_id: int) -> UserModel:
        row = execute_query_one(
            'SELECT * FROM users WHERE id = %s',
            (user_id,)
        )
        return UserModel.from_row(row)
    
    @staticmethod
    def update_kraken_keys(user_id: int, api_key_encrypted: str, private_key_encrypted: str) -> bool:
        execute_non_query(
            '''UPDATE users 
               SET kraken_api_key_encrypted = %s, kraken_private_key_encrypted = %s
               WHERE id = %s''',
            (api_key_encrypted, private_key_encrypted, user_id)
        )
        return True
    
    @staticmethod
    def update_password(user_id: int, password_hash: str) -> bool:
        execute_non_query(
            '''UPDATE users 
               SET password_hash = %s
               WHERE id = %s''',
            (password_hash, user_id)
        )
        return True
    
    @staticmethod
    def update_username(user_id: int, username: str) -> bool:
        execute_non_query(
            '''UPDATE users 
               SET username = %s
               WHERE id = %s''',
            (username, user_id)
        )
        return True

    @staticmethod
    def delete_user(user_id: int) -> bool:
        execute_non_query(
            'DELETE FROM users WHERE id = %s',
            (user_id,)
        )
        return True
