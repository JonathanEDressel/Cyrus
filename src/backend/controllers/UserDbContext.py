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
    def update_notifications(user_id: int, enabled: bool) -> bool:
        execute_non_query(
            'UPDATE users SET notifications_enabled = ? WHERE id = ?',
            (1 if enabled else 0, user_id)
        )
        return True
    
    @staticmethod
    def update_donation_modal(user_id: int, enabled: bool) -> bool:
        execute_non_query(
            'UPDATE users SET donation_modal_enabled = ? WHERE id = ?',
            (1 if enabled else 0, user_id)
        )
        return True

    @staticmethod
    def update_theme(user_id: int, theme: str) -> bool:
        execute_non_query(
            'UPDATE users SET theme = ? WHERE id = ?',
            (theme, user_id)
        )
        return True
