import time

from helper.Helper import execute_query_all, execute_query_one, execute_insert, execute_non_query, execute_scalar

_COLUMNS = '''id, user_id, indicator_id, chart_id, indicator_name, source, symbol, timeframe,
              condition_key, condition_title, script_source, inputs, frequency, message, status,
              last_bar_time, trigger_count, triggered_at, created_at, updated_at'''


class ScriptAlertDbContext:

    @staticmethod
    def list_for_user(user_id: int) -> list[dict]:
        return execute_query_all(
            f'SELECT {_COLUMNS} FROM script_alerts WHERE user_id = ? ORDER BY created_at DESC, id DESC',
            (user_id,)
        )

    @staticmethod
    def get(user_id: int, alert_id: int) -> dict | None:
        return execute_query_one(
            f'SELECT {_COLUMNS} FROM script_alerts WHERE user_id = ? AND id = ?',
            (user_id, alert_id)
        )

    @staticmethod
    def count_active(user_id: int) -> int:
        return int(execute_scalar(
            "SELECT COUNT(*) FROM script_alerts WHERE user_id = ? AND status = 'active'", (user_id,)
        ) or 0)

    @staticmethod
    def create(user_id: int, f: dict) -> int:
        now = int(time.time())
        return execute_insert(
            '''INSERT INTO script_alerts (user_id, indicator_id, chart_id, indicator_name, source, symbol,
                   timeframe, condition_key, condition_title, script_source, inputs, frequency, message,
                   status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)''',
            (user_id, f.get('indicator_id'), f.get('chart_id'), f['indicator_name'], f['source'], f['symbol'],
             f['timeframe'], f['condition_key'], f['condition_title'], f['script_source'], f['inputs'],
             f['frequency'], f.get('message'), now, now)
        )

    @staticmethod
    def update(user_id: int, alert_id: int, fields: dict) -> bool:
        """Change any of the editable columns in ``fields``."""
        allowed = ('indicator_name', 'condition_key', 'condition_title', 'script_source', 'inputs',
                   'frequency', 'message', 'status')
        sets, params = [], []
        for k in allowed:
            if k in fields:
                sets.append(f'{k} = ?')
                params.append(fields[k])
        if not sets:
            return False
        sets.append('updated_at = ?')
        params.append(int(time.time()))
        params.extend([user_id, alert_id])
        return execute_non_query(
            f'UPDATE script_alerts SET {", ".join(sets)} WHERE user_id = ? AND id = ?', tuple(params)
        ) > 0

    @staticmethod
    def delete(user_id: int, alert_id: int) -> bool:
        return execute_non_query('DELETE FROM script_alerts WHERE user_id = ? AND id = ?', (user_id, alert_id)) > 0

    @staticmethod
    def record_fire(user_id: int, alert: dict, bar_time: int, message: str | None) -> bool:
        """Log a hit for one bar. False if that bar already fired (or the alert isn't armed)."""
        if alert['status'] != 'active':
            return False
        now = int(time.time())
        inserted = execute_non_query(
            '''INSERT OR IGNORE INTO script_alert_events (alert_id, user_id, bar_time, fired_at, message)
               VALUES (?, ?, ?, ?, ?)''',
            (alert['id'], user_id, bar_time, now, message)
        )
        if inserted <= 0:
            return False
        status = 'triggered' if alert['frequency'] == 'once' else 'active'
        execute_non_query(
            '''UPDATE script_alerts SET last_bar_time = MAX(COALESCE(last_bar_time, 0), ?),
                   trigger_count = trigger_count + 1, triggered_at = ?, status = ?, updated_at = ?
               WHERE user_id = ? AND id = ?''',
            (bar_time, now, status, now, user_id, alert['id'])
        )
        return True

    @staticmethod
    def events_since(user_id: int, since: int) -> list[dict]:
        return execute_query_all(
            '''SELECT e.id, e.alert_id, e.bar_time, e.fired_at, e.message,
                      a.indicator_name, a.condition_title, a.symbol, a.timeframe, a.chart_id
               FROM script_alert_events e JOIN script_alerts a ON a.id = e.alert_id
               WHERE e.user_id = ? AND e.fired_at > ?
               ORDER BY e.fired_at ASC, e.id ASC''',
            (user_id, since)
        )
