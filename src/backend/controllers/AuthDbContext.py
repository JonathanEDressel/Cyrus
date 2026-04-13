from helper.Helper import execute_query_one, execute_insert, execute_non_query, execute_scalar, execute_query_all
from models.UserModel import UserModel


class AuthDbContext:
    
    @staticmethod
    def get_user_by_username(username: str) -> UserModel:
        row = execute_query_one(
            'SELECT * FROM users WHERE username = ?',
            (username,)
        )
        return UserModel.from_row(row)
    
    @staticmethod
    def create_user(username: str, password_hash: str) -> UserModel:
        user_id = execute_insert(
            '''INSERT INTO users (username, password_hash)
               VALUES (?, ?)''',
            (username, password_hash)
        )
        
        row = execute_query_one(
            'SELECT * FROM users WHERE id = ?',
            (user_id,)
        )
        return UserModel.from_row(row)
    
    @staticmethod
    def update_last_login(user_id: int) -> None:
        execute_non_query(
            "UPDATE users SET last_login = datetime('now') WHERE id = ?",
            (user_id,)
        )
    
    @staticmethod
    def username_exists(username: str) -> bool:
        result = execute_scalar(
            'SELECT 1 FROM users WHERE username = ?',
            (username,)
        )
        return result is not None

    @staticmethod
    def get_all_accounts() -> list:
        return execute_query_all(
            '''SELECT u.id, u.username, u.created_at, u.is_active,
                      COUNT(ar.id) as command_count
               FROM users u
               LEFT JOIN automation_rules ar ON ar.user_id = u.id
               GROUP BY u.id
               ORDER BY u.created_at DESC'''
        )

    @staticmethod
    def toggle_user_active(user_id: int) -> dict:
        execute_non_query(
            'UPDATE users SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ?',
            (user_id,)
        )
        return execute_query_one(
            'SELECT id, username, created_at, is_active FROM users WHERE id = ?',
            (user_id,)
        )

    @staticmethod
    def is_user_active(user_id: int) -> bool:
        result = execute_scalar(
            'SELECT is_active FROM users WHERE id = ?',
            (user_id,)
        )
        return bool(result) if result is not None else False
