"""Data access for cost basis the user enters by hand.

Three kinds, one per gap the replay can report:

* **Manual lots** (``cost_basis_manual_lots``) — purchases Cyrus has no record
  of, which fix "sold more than the history accounts for".
* **Deposit overrides** (``cost_basis_deposit_overrides``) — the original cost
  and purchase date of coins that arrived from outside, which fix "arrived by
  deposit, cost unknown".
* **Manual prices** — the USD value of a fill's quote asset, written straight
  onto ``trade_history`` with ``usd_price_source = 'manual'``. The trade
  upsert keeps an existing price on conflict, so a re-sync never undoes it.

Every write is scoped by ``user_id`` in the SQL itself, so an id from another
user's data simply matches nothing.
"""

import time

from helper.Helper import execute_insert, execute_non_query, execute_query_all, execute_query_one


class CostBasisDbContext:

    # -----------------------------------------------------------------
    # Manual lots
    # -----------------------------------------------------------------

    @staticmethod
    def list_lots(user_id: int) -> list[dict]:
        return execute_query_all(
            '''SELECT m.id, m.exchange_connection_id, m.asset, m.amount, m.total_cost_usd,
                      m.acquired_at, m.note, m.created_at,
                      c.exchange_name, c.label AS connection_label
               FROM cost_basis_manual_lots m
               LEFT JOIN exchange_connections c ON c.id = m.exchange_connection_id
               WHERE m.user_id = ?
               ORDER BY m.acquired_at ASC, m.id ASC''',
            (user_id,)
        )

    @staticmethod
    def add_lot(user_id: int, conn_id: int, asset: str, amount: float,
                total_cost_usd: float, acquired_at: int, note: str | None) -> int:
        return execute_insert(
            '''INSERT INTO cost_basis_manual_lots
               (user_id, exchange_connection_id, asset, amount, total_cost_usd,
                acquired_at, note, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
            (user_id, int(conn_id), asset.upper(), float(amount), float(total_cost_usd),
             int(acquired_at), note, int(time.time()))
        )

    @staticmethod
    def delete_lot(user_id: int, lot_id: int) -> bool:
        before = execute_query_one(
            'SELECT id FROM cost_basis_manual_lots WHERE id = ? AND user_id = ?',
            (int(lot_id), user_id))
        if not before:
            return False
        execute_non_query('DELETE FROM cost_basis_manual_lots WHERE id = ? AND user_id = ?',
                          (int(lot_id), user_id))
        return True

    # -----------------------------------------------------------------
    # Deposit overrides
    # -----------------------------------------------------------------

    @staticmethod
    def list_deposit_overrides(user_id: int) -> list[dict]:
        return execute_query_all(
            '''SELECT o.transfer_id, o.total_cost_usd, o.acquired_at, o.note, o.created_at,
                      t.asset, t.amount_num, t.occurred_at, t.exchange_connection_id,
                      t.exchange_name, c.label AS connection_label
               FROM cost_basis_deposit_overrides o
               JOIN transfer_history t ON t.id = o.transfer_id
               LEFT JOIN exchange_connections c ON c.id = t.exchange_connection_id
               WHERE o.user_id = ?
               ORDER BY t.occurred_at ASC''',
            (user_id,)
        )

    @staticmethod
    def get_deposit(user_id: int, transfer_id: int) -> dict | None:
        return execute_query_one(
            '''SELECT id, kind, asset, amount_num, occurred_at, exchange_connection_id
               FROM transfer_history WHERE id = ? AND user_id = ?''',
            (int(transfer_id), user_id)
        )

    @staticmethod
    def set_deposit_override(user_id: int, transfer_id: int, total_cost_usd: float,
                             acquired_at: int, note: str | None) -> None:
        execute_non_query(
            '''INSERT INTO cost_basis_deposit_overrides
               (transfer_id, user_id, total_cost_usd, acquired_at, note, created_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(transfer_id) DO UPDATE SET
                   total_cost_usd = excluded.total_cost_usd,
                   acquired_at = excluded.acquired_at,
                   note = excluded.note''',
            (int(transfer_id), user_id, float(total_cost_usd), int(acquired_at), note,
             int(time.time()))
        )

    @staticmethod
    def delete_deposit_override(user_id: int, transfer_id: int) -> bool:
        row = execute_query_one(
            'SELECT transfer_id FROM cost_basis_deposit_overrides WHERE transfer_id = ? AND user_id = ?',
            (int(transfer_id), user_id))
        if not row:
            return False
        execute_non_query(
            'DELETE FROM cost_basis_deposit_overrides WHERE transfer_id = ? AND user_id = ?',
            (int(transfer_id), user_id))
        return True

    # -----------------------------------------------------------------
    # Manual prices on fills
    # -----------------------------------------------------------------

    @staticmethod
    def get_trade(user_id: int, trade_id: int) -> dict | None:
        return execute_query_one(
            '''SELECT id, symbol, base, quote, side, amount_num, price_num, cost_num,
                      occurred_at, quote_usd_price, usd_price_source
               FROM trade_history WHERE id = ? AND user_id = ?''',
            (int(trade_id), user_id)
        )

    @staticmethod
    def list_manual_prices(user_id: int) -> list[dict]:
        return execute_query_all(
            '''SELECT t.id AS trade_id, t.symbol, t.base, t.quote, t.side, t.amount_num,
                      t.price_num, t.occurred_at, t.quote_usd_price,
                      t.exchange_connection_id, t.exchange_name, c.label AS connection_label
               FROM trade_history t
               LEFT JOIN exchange_connections c ON c.id = t.exchange_connection_id
               WHERE t.user_id = ? AND t.usd_price_source = 'manual'
               ORDER BY t.occurred_at ASC''',
            (user_id,)
        )

    @staticmethod
    def set_manual_price(user_id: int, trade_id: int, quote_usd_price: float) -> None:
        execute_non_query(
            '''UPDATE trade_history
               SET quote_usd_price = ?, usd_price_source = 'manual', updated_at = ?
               WHERE id = ? AND user_id = ?''',
            (float(quote_usd_price), int(time.time()), int(trade_id), user_id)
        )

    @staticmethod
    def clear_manual_price(user_id: int, trade_id: int) -> bool:
        """Back to unpriced. 'unavailable' (not NULL) so the sync's pricing pass
        doesn't immediately retry a lookup that already failed once."""
        row = execute_query_one(
            '''SELECT id FROM trade_history
               WHERE id = ? AND user_id = ? AND usd_price_source = 'manual' ''',
            (int(trade_id), user_id))
        if not row:
            return False
        execute_non_query(
            '''UPDATE trade_history
               SET quote_usd_price = NULL, usd_price_source = 'unavailable', updated_at = ?
               WHERE id = ? AND user_id = ?''',
            (int(time.time()), int(trade_id), user_id)
        )
        return True
