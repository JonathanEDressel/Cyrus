from helper.Helper import execute_query_one, execute_non_query
from models.UserModel import UserModel


class UserDbContext:
    
    @staticmethod
    def get_user_by_id(user_id: int) -> UserModel:
        row = execute_query_one(
            'SELECT * FROM users WHERE id = ?',
            (user_id,)
        )
        return UserModel.from_row(row)
    
    @staticmethod
    def update_kraken_keys(user_id: int, api_key_encrypted: str, private_key_encrypted: str) -> bool:
        execute_non_query(
            '''UPDATE users 
               SET kraken_api_key_encrypted = ?, kraken_private_key_encrypted = ?
               WHERE id = ?''',
            (api_key_encrypted, private_key_encrypted, user_id)
        )
        return True
    
    @staticmethod
    def update_password(user_id: int, password_hash: str) -> bool:
        execute_non_query(
            '''UPDATE users 
               SET password_hash = ?
               WHERE id = ?''',
            (password_hash, user_id)
        )
        return True
    
    @staticmethod
    def update_username(user_id: int, username: str) -> bool:
        execute_non_query(
            '''UPDATE users 
               SET username = ?
               WHERE id = ?''',
            (username, user_id)
        )
        return True

    @staticmethod
    def delete_user(user_id: int) -> bool:
        execute_non_query(
            'DELETE FROM users WHERE id = ?',
            (user_id,)
        )
        return True

    @staticmethod
    def mark_keys_valid(user_id: int) -> bool:
        execute_non_query(
            '''UPDATE users 
               SET keys_validated = 1, keys_last_validated = CURRENT_TIMESTAMP
               WHERE id = ?''',
            (user_id,)
        )
        return True

    @staticmethod
    def mark_keys_invalid(user_id: int) -> bool:
        execute_non_query(
            '''UPDATE users 
               SET keys_validated = 0, keys_last_validated = CURRENT_TIMESTAMP
               WHERE id = ?''',
            (user_id,)
        )
        return True

    @staticmethod
    def clear_keys_validation(user_id: int) -> bool:
        execute_non_query(
            '''UPDATE users 
               SET keys_validated = 0, keys_last_validated = NULL
               WHERE id = ?''',
            (user_id,)
        )
        return True
