from helper.Helper import execute_query_all, execute_query_one, execute_insert, execute_non_query


class ChartDbContext:

    @staticmethod
    def list_for_user(user_id: int) -> list[dict]:
        return execute_query_all(
            'SELECT id, name, state, created_at, updated_at FROM saved_charts '
            'WHERE user_id = ? ORDER BY updated_at DESC, id DESC',
            (user_id,)
        )

    @staticmethod
    def get(user_id: int, chart_id: int) -> dict | None:
        return execute_query_one(
            'SELECT id, name, state, created_at, updated_at FROM saved_charts '
            'WHERE user_id = ? AND id = ?',
            (user_id, chart_id)
        )

    @staticmethod
    def create(user_id: int, name: str, state: str) -> int:
        return execute_insert(
            'INSERT INTO saved_charts (user_id, name, state) VALUES (?, ?, ?)',
            (user_id, name, state)
        )

    @staticmethod
    def update(user_id: int, chart_id: int, name: str | None, state: str | None) -> bool:
        sets, params = [], []
        if name is not None:
            sets.append('name = ?')
            params.append(name)
        if state is not None:
            sets.append('state = ?')
            params.append(state)
        sets.append('updated_at = CURRENT_TIMESTAMP')
        params.extend([user_id, chart_id])
        rows = execute_non_query(
            f'UPDATE saved_charts SET {", ".join(sets)} WHERE user_id = ? AND id = ?',
            tuple(params)
        )
        return rows > 0

    @staticmethod
    def delete(user_id: int, chart_id: int) -> bool:
        rows = execute_non_query(
            'DELETE FROM saved_charts WHERE user_id = ? AND id = ?',
            (user_id, chart_id)
        )
        return rows > 0
