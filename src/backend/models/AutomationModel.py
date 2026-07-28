from datetime import datetime
from typing import Optional


class AutomationRule:
    
    def __init__(self, id: int, user_id: int, rule_name: str,
                 trigger_type: str, action_type: str,
                 trigger_order_id: Optional[str] = None,
                 trigger_pair: Optional[str] = None,
                 trigger_side: Optional[str] = None,
                 action_asset: Optional[str] = None,
                 action_address_key: Optional[str] = None,
                 action_amount: Optional[str] = None,
                 use_filled_amount: bool = False,
                 trigger_asset: Optional[str] = None,
                 trigger_threshold: Optional[str] = None,
                 last_executed_at: Optional[datetime] = None,
                 cooldown_minutes: int = 1440,
                 is_active: bool = True,
                 created_at: Optional[datetime] = None,
                 last_triggered_at: Optional[datetime] = None,
                 trigger_count: int = 0,
                 trigger_exchange_id: Optional[int] = None,
                 action_exchange_id: Optional[int] = None,
                 convert_to_asset: Optional[str] = None,
                 trigger_price_quote_asset: Optional[str] = None,
                 action_amount_mode: Optional[str] = None,
                 max_executions: Optional[int] = None,
                 execution_count: int = 0,
                 trigger_allocation_percent: Optional[str] = None,
                 rebalance_target_percent: Optional[str] = None,
                 min_trade_usd: Optional[str] = None,
                 dry_run: bool = False):
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
        self.use_filled_amount = use_filled_amount
        self.trigger_asset = trigger_asset
        self.trigger_threshold = trigger_threshold
        self.last_executed_at = last_executed_at
        self.cooldown_minutes = cooldown_minutes
        self.is_active = is_active
        self.created_at = created_at
        self.last_triggered_at = last_triggered_at
        self.trigger_count = trigger_count
        self.trigger_exchange_id = trigger_exchange_id
        self.action_exchange_id = action_exchange_id
        self.convert_to_asset = convert_to_asset
        self.trigger_price_quote_asset = trigger_price_quote_asset
        self.action_amount_mode = action_amount_mode
        self.max_executions = max_executions
        self.execution_count = execution_count
        # Portfolio balancer ('allocation_threshold') fields.
        self.trigger_allocation_percent = trigger_allocation_percent
        self.rebalance_target_percent = rebalance_target_percent
        self.min_trade_usd = min_trade_usd
        self.dry_run = dry_run

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
            use_filled_amount=bool(row.get('use_filled_amount', False)),
            trigger_asset=row.get('trigger_asset'),
            trigger_threshold=row.get('trigger_threshold'),
            last_executed_at=row.get('last_executed_at'),
            cooldown_minutes=row.get('cooldown_minutes', 1440),
            is_active=row.get('is_active', True),
            created_at=row.get('created_at'),
            last_triggered_at=row.get('last_triggered_at'),
            trigger_count=row.get('trigger_count', 0),
            trigger_exchange_id=row.get('trigger_exchange_id'),
            action_exchange_id=row.get('action_exchange_id'),
            convert_to_asset=row.get('convert_to_asset'),
            trigger_price_quote_asset=row.get('trigger_price_quote_asset'),
            action_amount_mode=row.get('action_amount_mode'),
            max_executions=row.get('max_executions'),
            execution_count=row.get('execution_count', 0),
            trigger_allocation_percent=row.get('trigger_allocation_percent'),
            rebalance_target_percent=row.get('rebalance_target_percent'),
            min_trade_usd=row.get('min_trade_usd'),
            dry_run=bool(row.get('dry_run', False)),
        )

    def allocation_cap(self) -> Optional[float]:
        """The rule's max-allocation percent, or None when it isn't set."""
        try:
            return float(self.trigger_allocation_percent)
        except (TypeError, ValueError):
            return None

    def allocation_target(self) -> float:
        """Percent to rebalance down to.

        Defaults to 5 points below the cap when unset — acting exactly down to
        the cap would leave the position sitting on the trigger and re-firing
        every cycle.
        """
        cap = self.allocation_cap() or 0.0
        try:
            target = float(self.rebalance_target_percent)
        except (TypeError, ValueError):
            target = cap - 5.0
        return max(0.0, min(target, cap))

    def has_reached_execution_limit(self) -> bool:
        if self.max_executions is None:
            return False
        return int(self.execution_count or 0) >= int(self.max_executions)

    def to_dict(self) -> dict:
        # SQLite returns datetime as string, MySQL as datetime object
        def format_datetime(dt):
            if dt is None:
                return None
            if isinstance(dt, str):
                return dt  # Already a string from SQLite
            return dt.isoformat()  # datetime object from MySQL
        
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
            'use_filled_amount': self.use_filled_amount,
            'trigger_asset': self.trigger_asset,
            'trigger_threshold': self.trigger_threshold,
            'last_executed_at': format_datetime(self.last_executed_at),
            'cooldown_minutes': self.cooldown_minutes,
            'is_active': self.is_active,
            'created_at': format_datetime(self.created_at),
            'last_triggered_at': format_datetime(self.last_triggered_at),
            'trigger_count': self.trigger_count,
            'trigger_exchange_id': self.trigger_exchange_id,
            'action_exchange_id': self.action_exchange_id,
            'convert_to_asset': self.convert_to_asset,
            'trigger_price_quote_asset': self.trigger_price_quote_asset,
            'action_amount_mode': self.action_amount_mode,
            'max_executions': self.max_executions,
            'execution_count': self.execution_count,
            'trigger_allocation_percent': self.trigger_allocation_percent,
            'rebalance_target_percent': self.rebalance_target_percent,
            'min_trade_usd': self.min_trade_usd,
            'dry_run': self.dry_run,
        }


class AutomationLog:

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
        # SQLite returns datetime as string, MySQL as datetime object
        def format_datetime(dt):
            if dt is None:
                return None
            if isinstance(dt, str):
                return dt  # Already a string from SQLite
            return dt.isoformat()  # datetime object from MySQL
        
        return {
            'id': self.id,
            'rule_id': self.rule_id,
            'user_id': self.user_id,
            'trigger_event': self.trigger_event,
            'action_executed': self.action_executed,
            'action_result': self.action_result,
            'status': self.status,
            'created_at': format_datetime(self.created_at),
        }
