"""Tracks which monthly report periods have been emailed (period = 'YYYY-MM')."""

from helper.Helper import execute_query_one, execute_query_all, execute_non_query


class ReportDbContext:

    @staticmethod
    def get_users_owed_report(period: str) -> list[int]:
        """Active users with email configured who haven't had ``period`` sent yet.

        Driven by the automation worker every cycle, so it's one query rather
        than a per-user check.
        """
        rows = execute_query_all(
            '''SELECT u.id
               FROM users u
               LEFT JOIN report_sends s
                      ON s.user_id = u.id AND s.period = ?
               WHERE u.is_active = 1
                 AND u.email_notifications_enabled = 1
                 AND u.notify_email IS NOT NULL AND TRIM(u.notify_email) != ''
                 AND u.smtp_password_encrypted IS NOT NULL
                 AND s.id IS NULL''',
            (period,)
        )
        return [r['id'] for r in (rows or [])]

    @staticmethod
    def was_sent(user_id: int, period: str) -> bool:
        row = execute_query_one(
            'SELECT 1 FROM report_sends WHERE user_id = ? AND period = ?',
            (user_id, period)
        )
        return row is not None

    @staticmethod
    def mark_sent(user_id: int, period: str) -> None:
        execute_non_query(
            'INSERT OR IGNORE INTO report_sends (user_id, period) VALUES (?, ?)',
            (user_id, period)
        )
