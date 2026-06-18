from helper.Helper import execute_query_one, execute_non_query
from models.UserModel import UserModel
from typing import Optional


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

    @staticmethod
    def update_active(user_id: int, is_active: bool) -> bool:
        execute_non_query(
            'UPDATE users SET is_active = ? WHERE id = ?',
            (1 if is_active else 0, user_id)
        )
        return True

    @staticmethod
    def update_email_notifications(user_id: int, enabled: bool,
                                   notify_email: Optional[str],
                                   smtp_host: Optional[str],
                                   smtp_port: Optional[int],
                                   smtp_password_encrypted: Optional[str] = None,
                                   update_password: bool = False) -> bool:
        """Persist a user's email-notification settings.

        The SMTP app password is only written when ``update_password`` is True
        (i.e. the user typed a new one), so toggling the feature or editing the
        address never wipes a previously stored credential. The password value
        passed in is already Fernet-encrypted.
        """
        if update_password:
            execute_non_query(
                '''UPDATE users
                   SET email_notifications_enabled = ?, notify_email = ?,
                       smtp_host = ?, smtp_port = ?, smtp_password_encrypted = ?
                   WHERE id = ?''',
                (1 if enabled else 0, notify_email, smtp_host, smtp_port,
                 smtp_password_encrypted, user_id)
            )
        else:
            execute_non_query(
                '''UPDATE users
                   SET email_notifications_enabled = ?, notify_email = ?,
                       smtp_host = ?, smtp_port = ?
                   WHERE id = ?''',
                (1 if enabled else 0, notify_email, smtp_host, smtp_port, user_id)
            )
        return True

    @staticmethod
    def get_email_settings(user_id: int) -> Optional[dict]:
        """Return the raw email-notification columns for the worker to use.

        Includes ``smtp_password_encrypted`` (still encrypted) — the caller
        decrypts it only at send time.
        """
        return execute_query_one(
            '''SELECT email_notifications_enabled, notify_email,
                      smtp_password_encrypted, smtp_host, smtp_port
               FROM users WHERE id = ?''',
            (user_id,)
        )
