"""Tracks which monthly report periods have been emailed (period = 'YYYY-MM')."""

from helper.Helper import execute_query_one, execute_non_query


class ReportDbContext:

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
