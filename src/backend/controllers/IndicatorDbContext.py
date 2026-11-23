from helper.Helper import execute_query_all, execute_query_one, execute_insert, execute_non_query, execute_scalar

_COLUMNS = 'id, name, source, created_at, updated_at'


class IndicatorDbContext:

    @staticmethod
    def list_for_user(user_id: int) -> list[dict]:
        return execute_query_all(
            f'SELECT {_COLUMNS} FROM custom_indicators WHERE user_id = ? ORDER BY name COLLATE NOCASE, id',
            (user_id,)
        )

    @staticmethod
    def get(user_id: int, indicator_id: int) -> dict | None:
        return execute_query_one(
            f'SELECT {_COLUMNS} FROM custom_indicators WHERE user_id = ? AND id = ?',
            (user_id, indicator_id)
        )

    @staticmethod
    def count_for_user(user_id: int) -> int:
        return int(execute_scalar('SELECT COUNT(*) FROM custom_indicators WHERE user_id = ?', (user_id,)) or 0)

    @staticmethod
    def create(user_id: int, name: str, source: str) -> int:
        return execute_insert(
            'INSERT INTO custom_indicators (user_id, name, source) VALUES (?, ?, ?)',
            (user_id, name, source)
        )

    @staticmethod
    def update(user_id: int, indicator_id: int, name: str | None, source: str | None) -> bool:
        sets, params = [], []
        if name is not None:
            sets.append('name = ?')
            params.append(name)
        if source is not None:
            sets.append('source = ?')
            params.append(source)
        sets.append('updated_at = CURRENT_TIMESTAMP')
        params.extend([user_id, indicator_id])
        rows = execute_non_query(
            f'UPDATE custom_indicators SET {", ".join(sets)} WHERE user_id = ? AND id = ?',
            tuple(params)
        )
        return rows > 0

    @staticmethod
    def delete(user_id: int, indicator_id: int) -> bool:
        return execute_non_query(
            'DELETE FROM custom_indicators WHERE user_id = ? AND id = ?',
            (user_id, indicator_id)
        ) > 0
