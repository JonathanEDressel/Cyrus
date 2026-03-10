from datetime import datetime
from typing import Optional


class UserModel:
    
    def __init__(self, id: int, username: str, password_hash: str,
                 kraken_api_key_encrypted: Optional[str] = None,
                 kraken_private_key_encrypted: Optional[str] = None,
                 created_at: Optional[datetime] = None,
                 last_login: Optional[datetime] = None):
        self.id = id
        self.username = username
        self.password_hash = password_hash
        self.kraken_api_key_encrypted = kraken_api_key_encrypted
        self.kraken_private_key_encrypted = kraken_private_key_encrypted
        self.created_at = created_at
        self.last_login = last_login
    
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
            last_login=row.get('last_login')
        )
    
    def to_dict(self) -> dict:
        return {
            'id': self.id,
            'username': self.username,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'last_login': self.last_login.isoformat() if self.last_login else None
        }
