from datetime import datetime
from typing import Optional


class AutomationRule:
    """Model representing an automation rule."""
    
    def __init__(self, id: int, user_id: int, rule_name: str,
                 trigger_type: str, action_type: str,
                 trigger_order_id: Optional[str] = None,
                 trigger_pair: Optional[str] = None,
                 trigger_side: Optional[str] = None,
                 action_asset: Optional[str] = None,
                 action_address_key: Optional[str] = None,
                 action_amount: Optional[str] = None,
                 is_active: bool = True,
                 created_at: Optional[datetime] = None,
                 last_triggered_at: Optional[datetime] = None,
                 trigger_count: int = 0):
        self.id = id
        self.user_id = user_id
        self.rule_name = rule_name
        self.trigger_type = trigger_type
        self.trigger_order_id = trigger_order_id
        self.trigger_pair = trigger_pair
        self.trigger_side = trigger_side
        self.action_type = action_type
        self.action_asset = action_asset
        self.action_address_key = action_address_key
        self.action_amount = action_amount
        self.is_active = is_active
        self.created_at = created_at
        self.last_triggered_at = last_triggered_at
        self.trigger_count = trigger_count

    @staticmethod
    def from_row(row: dict) -> 'AutomationRule':
        if row is None:
            return None
        return AutomationRule(
            id=row['id'],
            user_id=row['user_id'],
            rule_name=row['rule_name'],
            trigger_type=row['trigger_type'],
            trigger_order_id=row.get('trigger_order_id'),
            trigger_pair=row.get('trigger_pair'),
            trigger_side=row.get('trigger_side'),
            action_type=row['action_type'],
            action_asset=row.get('action_asset'),
            action_address_key=row.get('action_address_key'),
            action_amount=row.get('action_amount'),
            is_active=row.get('is_active', True),
            created_at=row.get('created_at'),
            last_triggered_at=row.get('last_triggered_at'),
            trigger_count=row.get('trigger_count', 0),
        )

    def to_dict(self) -> dict:
        return {
            'id': self.id,
            'user_id': self.user_id,
            'rule_name': self.rule_name,
            'trigger_type': self.trigger_type,
            'trigger_order_id': self.trigger_order_id,
            'trigger_pair': self.trigger_pair,
            'trigger_side': self.trigger_side,
            'action_type': self.action_type,
            'action_asset': self.action_asset,
            'action_address_key': self.action_address_key,
            'action_amount': self.action_amount,
            'is_active': self.is_active,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'last_triggered_at': self.last_triggered_at.isoformat() if self.last_triggered_at else None,
            'trigger_count': self.trigger_count,
        }


class AutomationLog:
    """Model representing an automation execution log entry."""

    def __init__(self, id: int, rule_id: int, user_id: int,
                 trigger_event: str, action_executed: str,
                 action_result: str, status: str,
                 created_at: Optional[datetime] = None):
        self.id = id
        self.rule_id = rule_id
        self.user_id = user_id
        self.trigger_event = trigger_event
        self.action_executed = action_executed
        self.action_result = action_result
        self.status = status
        self.created_at = created_at

    @staticmethod
    def from_row(row: dict) -> 'AutomationLog':
        if row is None:
            return None
        return AutomationLog(
            id=row['id'],
            rule_id=row['rule_id'],
            user_id=row['user_id'],
            trigger_event=row.get('trigger_event', ''),
            action_executed=row.get('action_executed', ''),
            action_result=row.get('action_result', ''),
            status=row['status'],
            created_at=row.get('created_at'),
        )

    def to_dict(self) -> dict:
        return {
            'id': self.id,
            'rule_id': self.rule_id,
            'user_id': self.user_id,
            'trigger_event': self.trigger_event,
            'action_executed': self.action_executed,
            'action_result': self.action_result,
            'status': self.status,
            'created_at': self.created_at.isoformat() if self.created_at else None,
        }
