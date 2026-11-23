import time

from helper.Helper import execute_query_all, execute_query_one, execute_insert, execute_non_query, execute_scalar

_COLUMNS = '''id, user_id, chart_id, drawing_id, source, symbol, kind, price, t1, p1, t2, p2,
              direction, note, status, created_at, updated_at, last_checked_at,
              triggered_at, triggered_price'''


def alert_price_at(alert: dict, t: int) -> float | None:
    """The alert's target price at time ``t``: its level, or the line's value then."""
    if alert['kind'] == 'level':
        return alert['price']
    t1, p1, t2, p2 = alert['t1'], alert['p1'], alert['t2'], alert['p2']
    if None in (t1, p1, t2, p2):
        return None
    if t2 == t1:
        return p2
    return p1 + (p2 - p1) * (t - t1) / (t2 - t1)


class AlertDbContext:

    @staticmethod
    def list_for_user(user_id: int) -> list[dict]:
        return execute_query_all(
            f'SELECT {_COLUMNS} FROM price_alerts WHERE user_id = ? ORDER BY created_at DESC, id DESC',
            (user_id,)
        )

    @staticmethod
    def get(user_id: int, alert_id: int) -> dict | None:
        return execute_query_one(
            f'SELECT {_COLUMNS} FROM price_alerts WHERE user_id = ? AND id = ?',
            (user_id, alert_id)
        )

    @staticmethod
    def count_for_user(user_id: int) -> int:
        return int(execute_scalar('SELECT COUNT(*) FROM price_alerts WHERE user_id = ?', (user_id,)) or 0)

    @staticmethod
    def create(user_id: int, fields: dict) -> int:
        now = int(time.time())
        return execute_insert(
            '''INSERT INTO price_alerts (user_id, chart_id, drawing_id, source, symbol, kind, price,
                   t1, p1, t2, p2, direction, note, status, created_at, updated_at, last_checked_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)''',
            (user_id, fields.get('chart_id'), fields.get('drawing_id'), fields['source'], fields['symbol'],
             fields['kind'], fields.get('price'), fields.get('t1'), fields.get('p1'), fields.get('t2'),
             fields.get('p2'), fields['direction'], fields.get('note'), now, now, now)
        )

    @staticmethod
    def update_geometry(user_id: int, alert_id: int, fields: dict) -> bool:
        """Move an alert (and re-arm it: a moved alert is a new target)."""
        now = int(time.time())
        rows = execute_non_query(
            '''UPDATE price_alerts SET kind = ?, price = ?, t1 = ?, p1 = ?, t2 = ?, p2 = ?,
                   direction = ?, note = COALESCE(?, note), status = 'active', triggered_at = NULL,
                   triggered_price = NULL, last_checked_at = ?, updated_at = ?
               WHERE user_id = ? AND id = ?''',
            (fields['kind'], fields.get('price'), fields.get('t1'), fields.get('p1'), fields.get('t2'),
             fields.get('p2'), fields['direction'], fields.get('note'), now, now, user_id, alert_id)
        )
        return rows > 0

    @staticmethod
    def delete(user_id: int, alert_id: int) -> bool:
        return execute_non_query('DELETE FROM price_alerts WHERE user_id = ? AND id = ?', (user_id, alert_id)) > 0

    @staticmethod
    def triggered_since(user_id: int, since: int) -> list[dict]:
        return execute_query_all(
            f'''SELECT {_COLUMNS} FROM price_alerts
                WHERE user_id = ? AND triggered_at IS NOT NULL AND triggered_at > ?
                ORDER BY triggered_at ASC''',
            (user_id, since)
        )

    # ── Worker ────────────────────────────────────────────────────────────

    @staticmethod
    def active_alerts() -> list[dict]:
        """Every armed alert, for users whose account is active."""
        return execute_query_all(
            f'''SELECT {', '.join('a.' + c.strip() for c in _COLUMNS.split(','))}
                FROM price_alerts a JOIN users u ON u.id = a.user_id
                WHERE a.status = 'active' AND COALESCE(u.is_active, 1) = 1'''
        )

    @staticmethod
    def mark_checked(alert_ids: list[int], at: int) -> None:
        if not alert_ids:
            return
        marks = ','.join('?' for _ in alert_ids)
        execute_non_query(f'UPDATE price_alerts SET last_checked_at = ? WHERE id IN ({marks})', (at, *alert_ids))

    @staticmethod
    def mark_triggered(alert_id: int, at: int, price: float) -> bool:
        """Flip an armed alert to triggered; False if something else got there first."""
        rows = execute_non_query(
            '''UPDATE price_alerts SET status = 'triggered', triggered_at = ?, triggered_price = ?,
                   last_checked_at = ?, updated_at = ?
               WHERE id = ? AND status = 'active' ''',
            (at, price, at, at, alert_id)
        )
        return rows > 0
