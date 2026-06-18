from datetime import datetime
from typing import Optional


class UserModel:
    
    def __init__(self, id: int, username: str, password_hash: str,
                 created_at: Optional[datetime] = None,
                 last_login: Optional[datetime] = None,
                 notifications_enabled: bool = True,
                 donation_modal_enabled: bool = True,
                 is_active: bool = True,
                 theme: str = 'dark',
                 email_notifications_enabled: bool = False,
                 notify_email: Optional[str] = None,
                 smtp_password_encrypted: Optional[str] = None,
                 smtp_host: Optional[str] = None,
                 smtp_port: Optional[int] = None):
        self.id = id
        self.username = username
        self.password_hash = password_hash
        self.created_at = created_at
        self.last_login = last_login
        self.notifications_enabled = notifications_enabled
        self.donation_modal_enabled = donation_modal_enabled
        self.is_active = is_active
        self.theme = theme
        self.email_notifications_enabled = email_notifications_enabled
        self.notify_email = notify_email
        # Stored encrypted at rest; never serialized to the client.
        self.smtp_password_encrypted = smtp_password_encrypted
        self.smtp_host = smtp_host
        self.smtp_port = smtp_port
    
    @staticmethod
    def from_row(row: dict) -> 'UserModel':
        if row is None:
            return None
        
        return UserModel(
            id=row['id'],
            username=row['username'],
            password_hash=row['password_hash'],
            created_at=row.get('created_at'),
            last_login=row.get('last_login'),
            notifications_enabled=bool(row.get('notifications_enabled', 1)),
            donation_modal_enabled=bool(row.get('donation_modal_enabled', 1)),
            is_active=bool(row.get('is_active', 1)),
            theme=row.get('theme', 'dark'),
            email_notifications_enabled=bool(row.get('email_notifications_enabled', 0)),
            notify_email=row.get('notify_email'),
            smtp_password_encrypted=row.get('smtp_password_encrypted'),
            smtp_host=row.get('smtp_host'),
            smtp_port=row.get('smtp_port'),
        )
    
    def to_dict(self) -> dict:
        def format_datetime(dt):
            if dt is None:
                return None
            if isinstance(dt, str):
                return dt
            return dt.isoformat()
        
        return {
            'id': self.id,
            'username': self.username,
            'created_at': format_datetime(self.created_at),
            'last_login': format_datetime(self.last_login),
            'notifications_enabled': self.notifications_enabled,
            'donation_modal_enabled': self.donation_modal_enabled,
            'is_active': self.is_active,
            'theme': self.theme,
            'email_notifications_enabled': self.email_notifications_enabled,
            'notify_email': self.notify_email,
            # Expose only whether a password is on file — never the secret itself.
            'smtp_password_set': bool(self.smtp_password_encrypted),
            'smtp_host': self.smtp_host,
            'smtp_port': self.smtp_port,
        }
