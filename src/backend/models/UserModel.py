from datetime import datetime
from typing import Optional


class UserModel:
    
    def __init__(self, id: int, username: str, password_hash: str,
                 kraken_api_key_encrypted: Optional[str] = None,
                 kraken_private_key_encrypted: Optional[str] = None,
                 created_at: Optional[datetime] = None,
                 last_login: Optional[datetime] = None,
                 keys_validated: bool = False,
                 keys_last_validated: Optional[datetime] = None):
        self.id = id
        self.username = username
        self.password_hash = password_hash
        self.kraken_api_key_encrypted = kraken_api_key_encrypted
        self.kraken_private_key_encrypted = kraken_private_key_encrypted
        self.created_at = created_at
        self.last_login = last_login
        self.keys_validated = keys_validated
        self.keys_last_validated = keys_last_validated
    
    @staticmethod
    def from_row(row: dict) -> 'UserModel':
        if row is None:
            return None
        
        return UserModel(
            id=row['id'],
            username=row['username'],
            password_hash=row['password_hash'],
            kraken_api_key_encrypted=row.get('kraken_api_key_encrypted'),
            kraken_private_key_encrypted=row.get('kraken_private_key_encrypted'),
            created_at=row.get('created_at'),
            last_login=row.get('last_login'),
            keys_validated=bool(row.get('keys_validated', 0)),
            keys_last_validated=row.get('keys_last_validated'),
        )
    
    def to_dict(self) -> dict:
        # SQLite returns datetime as string, MySQL as datetime object
        def format_datetime(dt):
            if dt is None:
                return None
            if isinstance(dt, str):
                return dt  # Already a string from SQLite
            return dt.isoformat()  # datetime object from MySQL
        
        has_keys = bool(self.kraken_api_key_encrypted and self.kraken_private_key_encrypted)
        return {
            'id': self.id,
            'username': self.username,
            'created_at': format_datetime(self.created_at),
            'last_login': format_datetime(self.last_login),
            'has_keys': has_keys,
            'keys_validated': self.keys_validated if has_keys else False,
            'keys_last_validated': format_datetime(self.keys_last_validated),
        }
