"""Data access for portfolio value history (the time-series line chart).

Snapshots are stored per (user, exchange connection) at 30-minute aligned
``captured_at`` epoch seconds. ``get_history`` aggregates across the user's
connections (or a single one) and pivots into a total series plus a per-asset
series, grouping all but the top holdings into an "Other" line so the chart
never turns into spaghetti.
"""

from helper.Helper import execute_query_all, execute_query_one, execute_scalar
from helper.InitiateConnection import get_db_connection


# How many individual asset lines to surface; the rest collapse into "Other".
TOP_ASSETS = 8


class PortfolioDbContext:

    @staticmethod
    def get_users_with_validated_connections() -> list[int]:
        rows = execute_query_all(
            'SELECT DISTINCT user_id FROM exchange_connections WHERE is_validated = 1'
        )
        return [r['user_id'] for r in rows]

    @staticmethod
    def get_last_snapshot_time(user_id: int, conn_id: int) -> int | None:
        return execute_scalar(
            '''SELECT MAX(captured_at) FROM portfolio_snapshots
               WHERE user_id = ? AND exchange_connection_id = ?''',
            (user_id, conn_id)
        )

    @staticmethod
    def get_snapshot_with_assets(user_id: int, conn_id: int, captured_at: int) -> dict | None:
        row = execute_query_one(
            '''SELECT id, total_usd, is_estimated FROM portfolio_snapshots
               WHERE user_id = ? AND exchange_connection_id = ? AND captured_at = ?''',
            (user_id, conn_id, int(captured_at))
        )
        if not row:
            return None
        assets = execute_query_all(
            'SELECT asset, amount, usd_value FROM portfolio_snapshot_assets WHERE snapshot_id = ?',
            (row['id'],)
        )
        return {'total_usd': row['total_usd'], 'is_estimated': row['is_estimated'], 'assets': assets}

    @staticmethod
    def insert_snapshot(user_id: int, conn_id: int, captured_at: int,
                        total_usd: float, positions: list,
                        is_estimated: bool = False) -> bool:
        """Insert one snapshot (header + per-asset detail) atomically.

        Idempotent: if a snapshot already exists for this (user, connection,
        bucket) the insert is ignored and ``False`` is returned.
        """
        conn = get_db_connection()
        try:
            cur = conn.execute(
                '''INSERT OR IGNORE INTO portfolio_snapshots
                   (user_id, exchange_connection_id, captured_at, total_usd, is_estimated)
                   VALUES (?, ?, ?, ?, ?)''',
                (user_id, conn_id, int(captured_at), float(total_usd), 1 if is_estimated else 0)
            )
            if cur.rowcount == 0:
                conn.commit()
                return False

            snap_id = cur.lastrowid
            for p in positions or []:
                try:
                    amount = float(p.get('amount', 0) or 0)
                    usd_value = float(p.get('usd_value', 0) or 0)
                except (TypeError, ValueError):
                    continue
                asset = str(p.get('asset', '') or '')
                if not asset:
                    continue
                conn.execute(
                    '''INSERT INTO portfolio_snapshot_assets (snapshot_id, asset, amount, usd_value)
                       VALUES (?, ?, ?, ?)''',
                    (snap_id, asset, amount, usd_value)
                )
            conn.commit()
            return True
        finally:
            conn.close()

    @staticmethod
    def get_earliest_time(user_id: int, conn_id: int | None = None) -> int | None:
        if conn_id is not None:
            return execute_scalar(
                '''SELECT MIN(captured_at) FROM portfolio_snapshots
                   WHERE user_id = ? AND exchange_connection_id = ?''',
                (user_id, conn_id)
            )
        return execute_scalar(
            'SELECT MIN(captured_at) FROM portfolio_snapshots WHERE user_id = ?',
            (user_id,)
        )

    @staticmethod
    def get_history(user_id: int, since_ts: int | None = None,
                    conn_id: int | None = None) -> dict:
        """Return ``{total, assets, earliest}`` for the requested window.

        ``total`` is ``[{time, value, estimated}, ...]`` aggregated across the
        selected connection(s). ``assets`` is a list of ``{asset, points}`` for
        the top holdings plus an aggregated "Other" line. ``earliest`` is the
        oldest snapshot the user has (ignoring ``since_ts``) so the UI can gate
        range buttons to what's actually been recorded.
        """
        # Build a shared WHERE for the snapshots table.
        clauses = ['user_id = ?']
        params: list = [user_id]
        if conn_id is not None:
            clauses.append('exchange_connection_id = ?')
            params.append(conn_id)
        if since_ts is not None:
            clauses.append('captured_at >= ?')
            params.append(int(since_ts))
        where = ' AND '.join(clauses)

        total_rows = execute_query_all(
            f'''SELECT captured_at AS t, SUM(total_usd) AS v, MAX(is_estimated) AS est
                FROM portfolio_snapshots
                WHERE {where}
                GROUP BY captured_at
                ORDER BY captured_at''',
            tuple(params)
        )

        # Same WHERE, but qualified for the joined assets query.
        s_clauses = ['s.user_id = ?']
        s_params: list = [user_id]
        if conn_id is not None:
            s_clauses.append('s.exchange_connection_id = ?')
            s_params.append(conn_id)
        if since_ts is not None:
            s_clauses.append('s.captured_at >= ?')
            s_params.append(int(since_ts))
        s_where = ' AND '.join(s_clauses)

        asset_rows = execute_query_all(
            f'''SELECT s.captured_at AS t, a.asset AS asset, SUM(a.usd_value) AS v
                FROM portfolio_snapshots s
                JOIN portfolio_snapshot_assets a ON a.snapshot_id = s.id
                WHERE {s_where}
                GROUP BY s.captured_at, a.asset
                ORDER BY s.captured_at''',
            tuple(s_params)
        )

        total = [
            {'time': int(r['t']), 'value': round(r['v'] or 0, 2), 'estimated': int(r['est'] or 0)}
            for r in total_rows
        ]

        # Pivot per-asset rows into series, ranking by most-recent value.
        per_asset: dict[str, list] = {}
        for r in asset_rows:
            per_asset.setdefault(r['asset'], []).append(
                {'time': int(r['t']), 'value': round(r['v'] or 0, 2)}
            )

        latest_val: dict[str, float] = {}
        if total_rows:
            latest_t = total_rows[-1]['t']
            for r in asset_rows:
                if r['t'] == latest_t:
                    latest_val[r['asset']] = r['v'] or 0

        ranked = sorted(per_asset.keys(),
                        key=lambda a: latest_val.get(a, 0), reverse=True)
        top = ranked[:TOP_ASSETS]
        others = set(ranked[TOP_ASSETS:])

        assets_out = [{'asset': a, 'points': per_asset[a]} for a in top]
        if others:
            combined: dict[int, float] = {}
            for r in asset_rows:
                if r['asset'] in others:
                    t = int(r['t'])
                    combined[t] = combined.get(t, 0) + (r['v'] or 0)
            pts = [{'time': t, 'value': round(v, 2)} for t, v in sorted(combined.items())]
            assets_out.append({'asset': 'Other', 'points': pts})

        # Total recorded snapshot buckets (ignores the range window) so the UI
        # can withhold the chart until enough history exists.
        if conn_id is not None:
            count = execute_scalar(
                '''SELECT COUNT(DISTINCT captured_at) FROM portfolio_snapshots
                   WHERE user_id = ? AND exchange_connection_id = ?''',
                (user_id, conn_id)
            )
        else:
            count = execute_scalar(
                'SELECT COUNT(DISTINCT captured_at) FROM portfolio_snapshots WHERE user_id = ?',
                (user_id,)
            )

        return {
            'total': total,
            'assets': assets_out,
            'earliest': PortfolioDbContext.get_earliest_time(user_id, conn_id),
            'count': count or 0,
        }

    @staticmethod
    def _snapshot_at(user_id: int, captured_at: int, conn_id: int | None):
        """Aggregate total + per-asset holdings at one captured_at (across conns)."""
        params: list = [user_id, captured_at]
        extra = ''
        if conn_id is not None:
            extra = ' AND exchange_connection_id = ?'
            params.append(conn_id)
        total = execute_scalar(
            f'SELECT SUM(total_usd) FROM portfolio_snapshots '
            f'WHERE user_id = ? AND captured_at = ?{extra}',
            tuple(params)
        ) or 0.0

        a_params: list = [user_id, captured_at]
        a_extra = ''
        if conn_id is not None:
            a_extra = ' AND s.exchange_connection_id = ?'
            a_params.append(conn_id)
        rows = execute_query_all(
            f'''SELECT a.asset AS asset, SUM(a.amount) AS amount, SUM(a.usd_value) AS usd_value
                FROM portfolio_snapshots s
                JOIN portfolio_snapshot_assets a ON a.snapshot_id = s.id
                WHERE s.user_id = ? AND s.captured_at = ?{a_extra}
                GROUP BY a.asset''',
            tuple(a_params)
        )
        assets = {r['asset']: {'amount': r['amount'] or 0, 'usd_value': r['usd_value'] or 0}
                  for r in rows}
        return float(total), assets

    @staticmethod
    def _pick_time(user_id: int, conn_id: int | None, op: str, ts: int) -> int | None:
        """Latest (op='<') or earliest (op='>=') captured_at relative to ts."""
        params: list = [user_id, ts]
        extra = ''
        if conn_id is not None:
            extra = ' AND exchange_connection_id = ?'
            params.append(conn_id)
        agg = 'MAX' if op == '<' else 'MIN'
        return execute_scalar(
            f'SELECT {agg}(captured_at) FROM portfolio_snapshots '
            f'WHERE user_id = ? AND captured_at {op} ?{extra}',
            tuple(params)
        )

    @staticmethod
    def get_month_change(user_id: int, start_ts: int, end_ts: int,
                         conn_id: int | None = None) -> dict:
        """Month-over-month change in holdings, value, and allocation.

        Baseline = the snapshot entering the month (latest before ``start_ts``,
        else the earliest within the month). Final = the latest snapshot before
        ``end_ts``. Returns per-asset deltas (amount, USD, allocation pp) plus
        the total-value change.
        """
        final_ts = PortfolioDbContext._pick_time(user_id, conn_id, '<', end_ts)
        base_ts = PortfolioDbContext._pick_time(user_id, conn_id, '<', start_ts)
        if base_ts is None:
            base_ts = PortfolioDbContext._pick_time(user_id, conn_id, '>=', start_ts)

        if final_ts is None:
            return {'total': {'current': 0, 'previous': 0, 'change_usd': 0, 'change_pct': 0},
                    'assets': [], 'has_baseline': False}

        final_total, final_assets = PortfolioDbContext._snapshot_at(user_id, final_ts, conn_id)
        has_baseline = base_ts is not None and base_ts != final_ts
        if has_baseline:
            base_total, base_assets = PortfolioDbContext._snapshot_at(user_id, base_ts, conn_id)
        else:
            base_total, base_assets = 0.0, {}

        def alloc(value: float, total: float) -> float:
            return (value / total * 100) if total > 0 else 0.0

        out_assets = []
        for asset in set(final_assets) | set(base_assets):
            f = final_assets.get(asset, {'amount': 0, 'usd_value': 0})
            b = base_assets.get(asset, {'amount': 0, 'usd_value': 0})
            f_pct = alloc(f['usd_value'], final_total)
            b_pct = alloc(b['usd_value'], base_total) if has_baseline else f_pct
            out_assets.append({
                'asset': asset,
                'amount': round(f['amount'], 8),
                'amount_change': round(f['amount'] - b['amount'], 8),
                'usd_value': round(f['usd_value'], 2),
                'usd_change': round(f['usd_value'] - b['usd_value'], 2),
                'pct': round(f_pct, 1),
                'pct_change': round(f_pct - b_pct, 1),
            })
        out_assets.sort(key=lambda a: a['usd_value'], reverse=True)

        change_usd = final_total - base_total if has_baseline else 0.0
        change_pct = (change_usd / base_total * 100) if (has_baseline and base_total > 0) else 0.0

        return {
            'total': {
                'current': round(final_total, 2),
                'previous': round(base_total, 2),
                'change_usd': round(change_usd, 2),
                'change_pct': round(change_pct, 1),
            },
            'assets': out_assets,
            'has_baseline': has_baseline,
        }
