from datetime import datetime
from typing import Optional


class UserModel:
    
    def __init__(self, id: int, username: str, password_hash: str,
                 created_at: Optional[datetime] = None,
                 last_login: Optional[datetime] = None,
                 notifications_enabled: bool = True,
                 donation_modal_enabled: bool = True):
        self.id = id
        self.username = username
        self.password_hash = password_hash
        self.created_at = created_at
        self.last_login = last_login
        self.notifications_enabled = notifications_enabled,
        self.donation_modal_enabled = donation_modal_enabled
    
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
        }
