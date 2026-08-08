"""Data access for exchange transfer history (deposits and withdrawals).

Two tables. ``transfer_history`` is the record of individual transfers, keyed
for idempotency on ``(user, connection, kind, dedupe_key)``. ``transfer_sync_state``
is the resume state for the chunked backfill, one row per (connection, kind).

The one invariant worth stating up front: ``synced_through`` advances **only**
inside :meth:`save_window`, in the same transaction as the rows that window
covered. A failed commit therefore leaves the watermark where it was and the
window is re-read next time — which is why that method takes a raw connection
rather than a series of ``execute_non_query`` calls that would each commit
separately.
"""

import json
import time

from helper.Helper import execute_query_all, execute_query_one, execute_non_query, execute_scalar
from helper.InitiateConnection import get_db_connection


#: Statuses that will never change again. Anything else is still in flight and
#: makes the next sync rewind far enough to re-read it — see
#: ``get_oldest_unsettled``.
TERMINAL_STATUSES = ('ok', 'failed', 'canceled')

#: Columns written on insert, in order. Kept as one list so the INSERT column
#: list, the placeholders and the value tuple cannot drift apart.
_INSERT_COLUMNS = (
    'user_id', 'exchange_connection_id', 'exchange_name', 'kind',
    'external_id', 'dedupe_key', 'txid', 'network', 'asset',
    'amount', 'amount_num', 'fee_amount', 'fee_currency', 'status',
    'address', 'tag', 'occurred_at', 'is_internal', 'raw_payload',
    'first_seen_at', 'updated_at',
)

#: Columns surfaced to the API. ``raw_payload`` is deliberately absent: it can
#: run to kilobytes per row and holds the unfiltered exchange response.
_SELECT_COLUMNS = '''
    t.id, t.exchange_connection_id, t.exchange_name, t.kind, t.external_id,
    t.txid, t.network, t.asset, t.amount, t.amount_num, t.fee_amount,
    t.fee_currency, t.status, t.address, t.tag, t.occurred_at,
    t.usd_value, t.is_internal
'''

_UPSERT_SQL = f'''
    INSERT INTO transfer_history ({', '.join(_INSERT_COLUMNS)})
    VALUES ({', '.join('?' * len(_INSERT_COLUMNS))})
    ON CONFLICT(user_id, exchange_connection_id, kind, dedupe_key) DO UPDATE SET
        status       = excluded.status,
        fee_amount   = excluded.fee_amount,
        fee_currency = excluded.fee_currency,
        raw_payload  = excluded.raw_payload,
        updated_at   = excluded.updated_at,
        txid         = COALESCE(excluded.txid,        transfer_history.txid),
        network      = COALESCE(excluded.network,     transfer_history.network),
        address      = COALESCE(excluded.address,     transfer_history.address),
        tag          = COALESCE(excluded.tag,         transfer_history.tag),
        external_id  = COALESCE(excluded.external_id, transfer_history.external_id),
        is_internal  = COALESCE(excluded.is_internal, transfer_history.is_internal)
'''
# occurred_at, amount, amount_num and first_seen_at are deliberately NOT
# refreshed. A status can legitimately change; a recorded amount or timestamp
# changing under us is either an exchange bug or a dedupe collision, and
# silently rewriting history is the worst possible response to either.


class TransferDbContext:

    # -----------------------------------------------------------------
    # Reads
    # -----------------------------------------------------------------

    @staticmethod
    def _filters(user_id: int, conn_id=None, kind=None, asset=None, status=None,
                 since_ts=None, until_ts=None) -> tuple[str, list]:
        """Shared WHERE builder so list and count can never disagree.

        Values stay bound as ``?``; only the clause skeleton is interpolated.
        """
        clauses = ['t.user_id = ?']
        params: list = [user_id]
        if conn_id is not None:
            clauses.append('t.exchange_connection_id = ?')
            params.append(int(conn_id))
        if kind:
            clauses.append('t.kind = ?')
            params.append(kind)
        if asset:
            clauses.append('t.asset = ?')
            params.append(str(asset).upper())
        if status:
            clauses.append('t.status = ?')
            params.append(status)
        if since_ts is not None:
            clauses.append('t.occurred_at >= ?')
            params.append(int(since_ts))
        if until_ts is not None:
            clauses.append('t.occurred_at <= ?')
            params.append(int(until_ts))
        return ' AND '.join(clauses), params

    @staticmethod
    def list_transfers(user_id: int, conn_id: int | None = None,
                       kind: str | None = None, asset: str | None = None,
                       status: str | None = None, since_ts: int | None = None,
                       until_ts: int | None = None, limit: int = 100,
                       offset: int = 0) -> list[dict]:
        """Newest-first page of transfers, joined to the connection's label."""
        where, params = TransferDbContext._filters(
            user_id, conn_id, kind, asset, status, since_ts, until_ts)
        rows = execute_query_all(
            f'''SELECT {_SELECT_COLUMNS}, c.label AS exchange_label
                FROM transfer_history t
                LEFT JOIN exchange_connections c ON c.id = t.exchange_connection_id
                WHERE {where}
                ORDER BY t.occurred_at DESC, t.id DESC
                LIMIT ? OFFSET ?''',
            (*params, int(limit), int(offset))
        )
        return rows

    @staticmethod
    def count_transfers(user_id: int, conn_id: int | None = None,
                        kind: str | None = None, asset: str | None = None,
                        status: str | None = None, since_ts: int | None = None,
                        until_ts: int | None = None) -> int:
        where, params = TransferDbContext._filters(
            user_id, conn_id, kind, asset, status, since_ts, until_ts)
        total = execute_scalar(
            f'SELECT COUNT(*) FROM transfer_history t WHERE {where}', tuple(params))
        return int(total or 0)

    @staticmethod
    def get_distinct_assets(user_id: int) -> list[str]:
        rows = execute_query_all(
            '''SELECT DISTINCT asset FROM transfer_history
               WHERE user_id = ? ORDER BY asset''',
            (user_id,)
        )
        return [r['asset'] for r in rows if r['asset']]

    @staticmethod
    def get_oldest_unsettled(conn_id: int, kind: str) -> int | None:
        """Earliest still-in-flight transfer for this target, or None.

        This is what stops a plain high-water mark from freezing pending rows
        forever. A transfer's ``occurred_at`` is its creation time and never
        moves, but its status does — a Binance withdrawal can sit in
        "Processing" for days. Rewinding to just before the oldest unsettled row
        means the next sync re-reads it and picks up the transition. Self-healing:
        once everything settles this returns None and the rewind collapses away.
        """
        placeholders = ', '.join('?' * len(TERMINAL_STATUSES))
        return execute_scalar(
            f'''SELECT MIN(occurred_at) FROM transfer_history
                WHERE exchange_connection_id = ? AND kind = ?
                  AND occurred_at > 0
                  AND (status IS NULL OR status NOT IN ({placeholders}))''',
            (int(conn_id), kind, *TERMINAL_STATUSES)
        )

    @staticmethod
    def get_sync_states_by_user(user_id: int) -> list[dict]:
        """Every sync-state row for the user's validated connections.

        Left-joined from the connections so a connection that has never synced
        still appears, with NULLs the caller reads as "not started".
        """
        return execute_query_all(
            '''SELECT c.id AS exchange_connection_id, c.exchange_name, c.label,
                      s.kind, s.synced_through, s.history_epoch,
                      s.backfill_complete, s.last_sync_ok_at, s.last_error,
                      s.disabled, s.disabled_reason
               FROM exchange_connections c
               LEFT JOIN transfer_sync_state s ON s.exchange_connection_id = c.id
               WHERE c.user_id = ? AND c.is_validated = 1
               ORDER BY c.id, s.kind''',
            (user_id,)
        )

    @staticmethod
    def get_sync_state(conn_id: int, kind: str) -> dict | None:
        return execute_query_one(
            '''SELECT * FROM transfer_sync_state
               WHERE exchange_connection_id = ? AND kind = ?''',
            (int(conn_id), kind)
        )

    @staticmethod
    def count_rows_for_target(conn_id: int, kind: str) -> int:
        total = execute_scalar(
            '''SELECT COUNT(*) FROM transfer_history
               WHERE exchange_connection_id = ? AND kind = ?''',
            (int(conn_id), kind)
        )
        return int(total or 0)

    # -----------------------------------------------------------------
    # Writes
    # -----------------------------------------------------------------

    @staticmethod
    def ensure_sync_state(conn_id: int, kind: str, history_epoch: int) -> dict:
        """Create the sync-state row if absent, then return it.

        ``history_epoch`` is frozen on first write and never updated afterwards:
        it is the denominator for progress reporting, and letting a changed
        registry constant move it would either restart a finished backfill or
        make progress jump backwards.
        """
        execute_non_query(
            '''INSERT OR IGNORE INTO transfer_sync_state
               (exchange_connection_id, kind, synced_through, history_epoch)
               VALUES (?, ?, ?, ?)''',
            (int(conn_id), kind, int(history_epoch), int(history_epoch))
        )
        return TransferDbContext.get_sync_state(conn_id, kind)

    @staticmethod
    def save_window(conn_id: int, user_id: int, exchange_name: str,
                    rows: list[dict], kind: str | None = None,
                    synced_through: int | None = None,
                    account_queue: list | None = None,
                    pass_started_at: int | None = None) -> int:
        """Upsert a window's rows and advance its watermark, atomically.

        One transaction, one commit. If anything raises, the rollback takes the
        watermark with it and the window is simply re-read — which is the whole
        reason this doesn't use the per-statement ``execute_*`` helpers.

        Each row carries its own ``kind`` (Coinbase's ledger yields both
        directions from one fetch), so *kind* here names only the sync-state row
        whose watermark moves. Returns the number of rows that were new.

        Passing ``synced_through=None`` writes the rows without moving the
        watermark — used for the Coinbase pass, which cannot advance until every
        account in the queue has been walked.
        """
        now = int(time.time())
        conn = get_db_connection()
        try:
            before = conn.execute(
                'SELECT COUNT(*) FROM transfer_history WHERE exchange_connection_id = ?',
                (int(conn_id),)
            ).fetchone()[0]

            for row in rows or []:
                if not row.get('dedupe_key') or not row.get('asset'):
                    # Both are NOT NULL and a null dedupe_key would defeat the
                    # UNIQUE index entirely. Skipping beats corrupting.
                    continue
                conn.execute(_UPSERT_SQL, (
                    user_id, int(conn_id), exchange_name, row['kind'],
                    row.get('external_id'), row['dedupe_key'], row.get('txid'),
                    row.get('network'), row['asset'], row.get('amount') or '0',
                    row.get('amount_num') or 0.0, row.get('fee_amount'),
                    row.get('fee_currency'), row.get('status'),
                    row.get('address'), row.get('tag'),
                    int(row.get('occurred_at') or 0), row.get('is_internal'),
                    row.get('raw_payload'), now, now,
                ))

            after = conn.execute(
                'SELECT COUNT(*) FROM transfer_history WHERE exchange_connection_id = ?',
                (int(conn_id),)
            ).fetchone()[0]

            updates, params = [], []
            if synced_through is not None:
                updates.append('synced_through = ?')
                params.append(int(synced_through))
            if account_queue is not None:
                updates.append('account_queue = ?')
                params.append(json.dumps(account_queue))
            if pass_started_at is not None:
                updates.append('pass_started_at = ?')
                params.append(int(pass_started_at))
            if updates and kind:
                # Clear any stale error alongside a successful write — the
                # state row should describe the last thing that happened, not
                # the last thing that went wrong.
                updates.append('last_error = NULL')
                conn.execute(
                    f'''UPDATE transfer_sync_state SET {', '.join(updates)}
                        WHERE exchange_connection_id = ? AND kind = ?''',
                    (*params, int(conn_id), kind)
                )

            conn.commit()
            return after - before
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    @staticmethod
    def finish_pass(conn_id: int, kind: str, synced_through: int) -> None:
        """Close out a completed pass: watermark forward, queue cleared."""
        execute_non_query(
            '''UPDATE transfer_sync_state
               SET synced_through = ?, backfill_complete = 1, account_queue = NULL,
                   pass_started_at = NULL, last_sync_ok_at = ?, last_error = NULL
               WHERE exchange_connection_id = ? AND kind = ?''',
            (int(synced_through), int(time.time()), int(conn_id), kind)
        )

    @staticmethod
    def mark_sync_ok(conn_id: int, kind: str) -> None:
        execute_non_query(
            '''UPDATE transfer_sync_state
               SET last_sync_ok_at = ?, last_error = NULL
               WHERE exchange_connection_id = ? AND kind = ?''',
            (int(time.time()), int(conn_id), kind)
        )

    @staticmethod
    def mark_sync_error(conn_id: int, kind: str, message: str) -> None:
        execute_non_query(
            '''UPDATE transfer_sync_state SET last_error = ?
               WHERE exchange_connection_id = ? AND kind = ?''',
            (str(message)[:500], int(conn_id), kind)
        )

    @staticmethod
    def set_disabled(conn_id: int, kind: str, reason: str | None) -> None:
        """Flag a target as not worth retrying, or clear the flag.

        Durable rather than in-memory because the usual cause is a missing API
        key permission, which needs a human to go and fix it. Retrying that on
        every page load would just burn rate limit against a guaranteed refusal.
        """
        execute_non_query(
            '''UPDATE transfer_sync_state
               SET disabled = ?, disabled_reason = ?
               WHERE exchange_connection_id = ? AND kind = ?''',
            (1 if reason else 0, str(reason)[:500] if reason else None,
             int(conn_id), kind)
        )
