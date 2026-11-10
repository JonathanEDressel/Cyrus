"""Data access for executed fills (``trade_history``) and their sync state.

Mirrors :mod:`controllers.TransferDbContext`, including its one invariant: a
page's rows and the cursor/watermark that covers them are written in ONE
transaction (:meth:`TradeDbContext.save_page`), so an interrupted sync re-reads
a page rather than skipping it.
"""

import json
import time

from helper.Helper import execute_query_all, execute_query_one, execute_non_query, execute_scalar
from helper.InitiateConnection import get_db_connection


#: Columns written on insert, in order — one list so the column names, the
#: placeholders and the value tuple can't drift apart.
_INSERT_COLUMNS = (
    'user_id', 'exchange_connection_id', 'exchange_name', 'external_id',
    'order_id', 'dedupe_key', 'symbol', 'base', 'quote', 'side', 'amount',
    'amount_num', 'price', 'price_num', 'cost_num', 'fee_amount',
    'fee_amount_num', 'fee_currency', 'occurred_at', 'quote_usd_price',
    'fee_usd_value', 'usd_price_source', 'raw_payload', 'first_seen_at',
    'updated_at',
)

_UPSERT_SQL = f'''
    INSERT INTO trade_history ({', '.join(_INSERT_COLUMNS)})
    VALUES ({', '.join('?' * len(_INSERT_COLUMNS))})
    ON CONFLICT(user_id, exchange_connection_id, dedupe_key) DO UPDATE SET
        fee_amount       = COALESCE(excluded.fee_amount,       trade_history.fee_amount),
        fee_amount_num   = COALESCE(excluded.fee_amount_num,   trade_history.fee_amount_num),
        fee_currency     = COALESCE(excluded.fee_currency,     trade_history.fee_currency),
        quote_usd_price  = COALESCE(trade_history.quote_usd_price, excluded.quote_usd_price),
        fee_usd_value    = COALESCE(trade_history.fee_usd_value,   excluded.fee_usd_value),
        usd_price_source = COALESCE(trade_history.usd_price_source, excluded.usd_price_source),
        updated_at       = excluded.updated_at
'''
# A fill never changes once executed, so amount, price, side and time are NOT
# refreshed on conflict — a different value arriving under the same key is a
# collision or an exchange bug, and rewriting tax history is the wrong answer
# to either. USD pricing keeps the FIRST value found for the same reason.

#: Columns the cost-basis engine and the API read. raw_payload is left out.
_SELECT_COLUMNS = '''
    t.id, t.exchange_connection_id, t.exchange_name, t.external_id, t.order_id,
    t.symbol, t.base, t.quote, t.side, t.amount, t.amount_num, t.price,
    t.price_num, t.cost_num, t.fee_amount, t.fee_amount_num, t.fee_currency,
    t.occurred_at, t.quote_usd_price, t.fee_usd_value, t.usd_price_source
'''


class TradeDbContext:

    # -----------------------------------------------------------------
    # Reads
    # -----------------------------------------------------------------

    @staticmethod
    def get_trades(user_id: int, until_ts: int | None = None) -> list[dict]:
        """Every stored fill for the user, oldest first, with connection labels."""
        params: list = [user_id]
        where = 't.user_id = ?'
        if until_ts is not None:
            where += ' AND t.occurred_at <= ?'
            params.append(int(until_ts))
        return execute_query_all(
            f'''SELECT {_SELECT_COLUMNS}, c.label AS connection_label
                FROM trade_history t
                LEFT JOIN exchange_connections c ON c.id = t.exchange_connection_id
                WHERE {where}
                ORDER BY t.occurred_at ASC, t.id ASC''',
            tuple(params)
        )

    @staticmethod
    def count_by_connection(user_id: int) -> dict[int, int]:
        rows = execute_query_all(
            '''SELECT exchange_connection_id AS conn_id, COUNT(*) AS n
               FROM trade_history WHERE user_id = ?
               GROUP BY exchange_connection_id''',
            (user_id,)
        )
        return {int(r['conn_id']): int(r['n']) for r in rows}

    @staticmethod
    def get_sync_state(conn_id: int, scope: str) -> dict | None:
        return execute_query_one(
            '''SELECT * FROM trade_sync_state
               WHERE exchange_connection_id = ? AND scope = ?''',
            (int(conn_id), scope)
        )

    @staticmethod
    def get_sync_states(conn_id: int) -> list[dict]:
        return execute_query_all(
            '''SELECT * FROM trade_sync_state WHERE exchange_connection_id = ?
               ORDER BY scope''',
            (int(conn_id),)
        )

    @staticmethod
    def get_sync_states_by_user(user_id: int) -> list[dict]:
        """Sync-state rows for every validated connection, never-synced included."""
        return execute_query_all(
            '''SELECT c.id AS exchange_connection_id, c.exchange_name, c.label,
                      s.scope, s.synced_through, s.history_epoch,
                      s.backfill_complete, s.last_sync_ok_at, s.last_error,
                      s.disabled, s.disabled_reason
               FROM exchange_connections c
               LEFT JOIN trade_sync_state s ON s.exchange_connection_id = c.id
               WHERE c.user_id = ? AND c.is_validated = 1
               ORDER BY c.id, s.scope''',
            (user_id,)
        )

    @staticmethod
    def get_unpriced(conn_id: int, limit: int = 200) -> list[dict]:
        """Fills still waiting for a USD lookup, oldest first.

        ``usd_price_source`` doubles as the "attempted" flag: rows that need
        nothing are written as ``'peg'`` and a failed lookup as
        ``'unavailable'``, so a NULL here always means "not tried yet" and the
        pricing pass can never loop on a price that doesn't exist.
        """
        return execute_query_all(
            '''SELECT id, base, quote, price_num, fee_amount_num, fee_currency,
                      occurred_at, quote_usd_price
               FROM trade_history
               WHERE exchange_connection_id = ? AND usd_price_source IS NULL
               ORDER BY occurred_at ASC, id ASC LIMIT ?''',
            (int(conn_id), int(limit))
        )

    @staticmethod
    def count_unpriced(conn_id: int) -> int:
        return int(execute_scalar(
            '''SELECT COUNT(*) FROM trade_history
               WHERE exchange_connection_id = ? AND usd_price_source IS NULL''',
            (int(conn_id),)
        ) or 0)

    @staticmethod
    def get_seen_bases(conn_id: int) -> list[str]:
        rows = execute_query_all(
            'SELECT DISTINCT base FROM trade_history WHERE exchange_connection_id = ?',
            (int(conn_id),)
        )
        return [r['base'] for r in rows if r['base']]

    # -----------------------------------------------------------------
    # Writes
    # -----------------------------------------------------------------

    @staticmethod
    def ensure_sync_state(conn_id: int, scope: str, history_epoch: int) -> dict:
        """Create the state row if absent (epoch frozen on first write), return it."""
        execute_non_query(
            '''INSERT OR IGNORE INTO trade_sync_state
               (exchange_connection_id, scope, synced_through, history_epoch)
               VALUES (?, ?, ?, ?)''',
            (int(conn_id), scope, int(history_epoch), int(history_epoch))
        )
        return TradeDbContext.get_sync_state(conn_id, scope)

    @staticmethod
    def save_page(conn_id: int, user_id: int, exchange_name: str, rows: list[dict],
                  scope: str, synced_through: int | None = None,
                  cursor=None) -> int:
        """Upsert a page of fills and advance the scope's cursor, atomically.

        Returns how many rows were new. ``cursor`` is stored as JSON text so a
        strategy can keep whatever it pages on (a trade id, a timestamp).
        """
        now = int(time.time())
        conn = get_db_connection()
        try:
            before = conn.execute(
                'SELECT COUNT(*) FROM trade_history WHERE exchange_connection_id = ?',
                (int(conn_id),)
            ).fetchone()[0]

            for row in rows or []:
                if not row.get('dedupe_key'):
                    continue
                conn.execute(_UPSERT_SQL, (
                    user_id, int(conn_id), exchange_name, row.get('external_id'),
                    row.get('order_id'), row['dedupe_key'], row['symbol'],
                    row['base'], row['quote'], row['side'], row['amount'],
                    row.get('amount_num') or 0.0, row['price'],
                    row.get('price_num') or 0.0, row.get('cost_num') or 0.0,
                    row.get('fee_amount'), row.get('fee_amount_num'),
                    row.get('fee_currency'), int(row.get('occurred_at') or 0),
                    row.get('quote_usd_price'), row.get('fee_usd_value'),
                    row.get('usd_price_source'), row.get('raw_payload'), now, now,
                ))

            after = conn.execute(
                'SELECT COUNT(*) FROM trade_history WHERE exchange_connection_id = ?',
                (int(conn_id),)
            ).fetchone()[0]

            updates, params = [], []
            if synced_through is not None:
                updates.append('synced_through = ?')
                params.append(int(synced_through))
            if cursor is not None:
                updates.append('cursor = ?')
                params.append(json.dumps(cursor))
            if updates:
                updates.append('last_error = NULL')
                conn.execute(
                    f'''UPDATE trade_sync_state SET {', '.join(updates)}
                        WHERE exchange_connection_id = ? AND scope = ?''',
                    (*params, int(conn_id), scope)
                )

            conn.commit()
            return after - before
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    @staticmethod
    def set_pricing(trade_id: int, quote_usd_price: float | None,
                    fee_usd_value: float | None, source: str) -> None:
        execute_non_query(
            '''UPDATE trade_history
               SET quote_usd_price = COALESCE(quote_usd_price, ?),
                   fee_usd_value = COALESCE(fee_usd_value, ?),
                   usd_price_source = ?, updated_at = ?
               WHERE id = ?''',
            (quote_usd_price, fee_usd_value, source, int(time.time()), int(trade_id))
        )

    @staticmethod
    def finish_pass(conn_id: int, scope: str, synced_through: int,
                    cursor=None) -> None:
        """Close a pass: watermark forward, resume cursor replaced or cleared."""
        execute_non_query(
            '''UPDATE trade_sync_state
               SET synced_through = ?, backfill_complete = 1, last_sync_ok_at = ?,
                   last_error = NULL, cursor = ?
               WHERE exchange_connection_id = ? AND scope = ?''',
            (int(synced_through), int(time.time()),
             json.dumps(cursor) if cursor is not None else None,
             int(conn_id), scope)
        )

    @staticmethod
    def set_cursor(conn_id: int, scope: str, cursor) -> None:
        execute_non_query(
            '''UPDATE trade_sync_state SET cursor = ?
               WHERE exchange_connection_id = ? AND scope = ?''',
            (json.dumps(cursor) if cursor is not None else None, int(conn_id), scope)
        )

    @staticmethod
    def mark_sync_ok(conn_id: int, scope: str) -> None:
        execute_non_query(
            '''UPDATE trade_sync_state SET last_sync_ok_at = ?, last_error = NULL
               WHERE exchange_connection_id = ? AND scope = ?''',
            (int(time.time()), int(conn_id), scope)
        )

    @staticmethod
    def mark_sync_error(conn_id: int, scope: str, message: str) -> None:
        execute_non_query(
            '''UPDATE trade_sync_state SET last_error = ?
               WHERE exchange_connection_id = ? AND scope = ?''',
            (str(message)[:500], int(conn_id), scope)
        )

    @staticmethod
    def set_disabled(conn_id: int, scope: str, reason: str | None) -> None:
        execute_non_query(
            '''UPDATE trade_sync_state SET disabled = ?, disabled_reason = ?
               WHERE exchange_connection_id = ? AND scope = ?''',
            (1 if reason else 0, str(reason)[:500] if reason else None,
             int(conn_id), scope)
        )
