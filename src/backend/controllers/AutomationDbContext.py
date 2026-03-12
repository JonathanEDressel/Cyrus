from helper.Helper import execute_query_one, execute_query_all, execute_non_query, execute_insert
from models.AutomationModel import AutomationRule, AutomationLog


class AutomationDbContext:

    @staticmethod
    def create_rule(user_id: int, rule_name: str, trigger_type: str,
                    action_type: str, trigger_order_id: str = None,
                    trigger_pair: str = None, trigger_side: str = None,
                    action_asset: str = None, action_address_key: str = None,
                    action_amount: str = None, use_filled_amount: bool = False,
                    trigger_asset: str = None, trigger_threshold: str = None,
                    cooldown_minutes: int = 1440) -> int:
        return execute_insert(
            '''INSERT INTO automation_rules
               (user_id, rule_name, trigger_type, trigger_order_id,
                trigger_pair, trigger_side, action_type, action_asset,
                action_address_key, action_amount, use_filled_amount,
                trigger_asset, trigger_threshold, cooldown_minutes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (user_id, rule_name, trigger_type, trigger_order_id,
             trigger_pair, trigger_side, action_type, action_asset,
             action_address_key, action_amount, use_filled_amount,
             trigger_asset, trigger_threshold, cooldown_minutes)
        )

    @staticmethod
    def get_rules_by_user(user_id: int) -> list:
        rows = execute_query_all(
            'SELECT * FROM automation_rules WHERE user_id = ? ORDER BY created_at DESC',
            (user_id,)
        )
        return [AutomationRule.from_row(r) for r in rows]

    @staticmethod
    def get_active_rules_by_user(user_id: int) -> list:
        rows = execute_query_all(
            'SELECT * FROM automation_rules WHERE user_id = ? AND is_active = 1 ORDER BY created_at DESC',
            (user_id,)
        )
        return [AutomationRule.from_row(r) for r in rows]

    @staticmethod
    def get_rule_by_id(rule_id: int, user_id: int) -> AutomationRule:
        row = execute_query_one(
            'SELECT * FROM automation_rules WHERE id = ? AND user_id = ?',
            (rule_id, user_id)
        )
        return AutomationRule.from_row(row)

    @staticmethod
    def toggle_rule(rule_id: int, user_id: int, is_active: bool) -> bool:
        execute_non_query(
            'UPDATE automation_rules SET is_active = ? WHERE id = ? AND user_id = ?',
            (is_active, rule_id, user_id)
        )
        return True

    @staticmethod
    def delete_rule(rule_id: int, user_id: int) -> bool:
        execute_non_query(
            'DELETE FROM automation_rules WHERE id = ? AND user_id = ?',
            (rule_id, user_id)
        )
        return True

    @staticmethod
    def mark_rule_triggered(rule_id: int) -> None:
        execute_non_query(
            '''UPDATE automation_rules 
               SET last_triggered_at = datetime('now'), last_executed_at = datetime('now'),
                   trigger_count = trigger_count + 1
               WHERE id = ?''',
            (rule_id,)
        )

    @staticmethod
    def is_cooldown_elapsed(rule_id: int) -> bool:
        row = execute_query_one(
            '''SELECT last_executed_at, cooldown_minutes FROM automation_rules WHERE id = ?''',
            (rule_id,)
        )
        if not row or not row.get('last_executed_at'):
            return True
        from datetime import datetime, timedelta
        last = datetime.fromisoformat(row['last_executed_at'])
        cooldown = int(row.get('cooldown_minutes', 1440))
        return datetime.utcnow() >= last + timedelta(minutes=cooldown)

    # ---- All active rules (for worker) ----

    @staticmethod
    def get_all_active_rules() -> list:
        rows = execute_query_all(
            'SELECT * FROM automation_rules WHERE is_active = 1'
        )
        return [AutomationRule.from_row(r) for r in rows]

    @staticmethod
    def get_users_with_active_rules() -> list:
        rows = execute_query_all(
            'SELECT DISTINCT user_id FROM automation_rules WHERE is_active = 1'
        )
        return [r['user_id'] for r in rows]

    @staticmethod
    def upsert_order_snapshot(user_id: int, order_id: str, pair: str,
                              side: str, status: str, volume: str, filled: str) -> None:
        execute_non_query(
            '''INSERT INTO order_snapshots (user_id, order_id, pair, side, status, volume, filled)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(user_id, order_id) DO UPDATE SET
                 status = excluded.status,
                 filled = excluded.filled,
                 last_checked_at = datetime('now')''',
            (user_id, order_id, pair, side, status, volume, filled)
        )

    @staticmethod
    def get_order_snapshot(user_id: int, order_id: str) -> dict:
        return execute_query_one(
            'SELECT * FROM order_snapshots WHERE user_id = ? AND order_id = ?',
            (user_id, order_id)
        )

    @staticmethod
    def get_order_snapshots_by_user(user_id: int) -> list:
        return execute_query_all(
            'SELECT * FROM order_snapshots WHERE user_id = ?',
            (user_id,)
        )

    @staticmethod
    def delete_order_snapshot(user_id: int, order_id: str) -> None:
        execute_non_query(
            'DELETE FROM order_snapshots WHERE user_id = ? AND order_id = ?',
            (user_id, order_id)
        )

    @staticmethod
    def create_log(rule_id: int, user_id: int, trigger_event: str,
                   action_executed: str, action_result: str, status: str) -> int:
        return execute_insert(
            '''INSERT INTO automation_log
               (rule_id, user_id, trigger_event, action_executed, action_result, status)
               VALUES (?, ?, ?, ?, ?, ?)''',
            (rule_id, user_id, trigger_event, action_executed, action_result, status)
        )

    @staticmethod
    def get_logs_by_user(user_id: int, limit: int = 50) -> list:
        rows = execute_query_all(
            'SELECT * FROM automation_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
            (user_id, limit)
        )
        return [AutomationLog.from_row(r) for r in rows]

    @staticmethod
    def get_logs_by_rule(rule_id: int, user_id: int, limit: int = 20) -> list:
        rows = execute_query_all(
            '''SELECT * FROM automation_log 
               WHERE rule_id = ? AND user_id = ? 
               ORDER BY created_at DESC LIMIT ?''',
            (rule_id, user_id, limit)
        )
        return [AutomationLog.from_row(r) for r in rows]
