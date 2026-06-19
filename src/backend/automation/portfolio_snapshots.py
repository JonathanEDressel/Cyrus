"""Periodic portfolio-value snapshots for the Overview line chart.

Runs inside the AutomationWorker loop. Every 30-minute wall-clock bucket it
values each validated connection's holdings (total + per asset) and stores a
snapshot. Snapshots are idempotent per (user, connection, bucket).

Gap handling: the app only runs while it's open, so closing it leaves holes in
the series. When we take a snapshot and find the previous one is older than a
single bucket, we backfill the missing buckets by valuing the *last known
holdings* at historical market prices (``fetch_ohlcv``). Those filled points are
flagged ``is_estimated`` so the chart can render them as clearly-estimated
(dashed) segments — they assume holdings didn't change while the app was closed.
"""

import time
import traceback


# TEMP (testing): snapshot every 10 seconds. Switch back to 1800 (30 minutes)
# for normal use.
BUCKET_SECONDS = 10
MAX_BACKFILL_BUCKETS = 14 * 24 * 2        # cap gap-fill at ~14 days
_STABLE = {'USD', 'USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDP', 'FDUSD', 'PYUSD', 'USDD'}


def current_bucket(now: float | None = None) -> int:
    now = now if now is not None else time.time()
    return int(now // BUCKET_SECONDS) * BUCKET_SECONDS


def _price_at(price_map: dict, bucket: int, fallback: float) -> float:
    """Closest known price at or before ``bucket``, else ``fallback``."""
    if not price_map:
        return fallback
    if bucket in price_map:
        return price_map[bucket]
    earlier = [t for t in price_map if t <= bucket]
    if earlier:
        return price_map[max(earlier)]
    return fallback


class PortfolioSnapshotter:
    """Takes one pass per 30-min bucket; cheap to call every worker cycle."""

    def __init__(self):
        self._last_done_bucket: int | None = None

    def run(self, stop_event) -> None:
        bucket = current_bucket()
        if self._last_done_bucket == bucket:
            return  # already handled this window
        try:
            self._snapshot_all(bucket, stop_event)
            if not stop_event.is_set():
                self._last_done_bucket = bucket
        except Exception as e:
            print(f"[SNAPSHOT] cycle error: {e}")
            traceback.print_exc()

    def _snapshot_all(self, bucket: int, stop_event) -> None:
        from controllers.PortfolioDbContext import PortfolioDbContext
        from controllers.AuthDbContext import AuthDbContext
        from controllers.ExchangeConnectionDbContext import ExchangeConnectionDbContext
        from helper.ExchangeRegistry import get_user_exchange
        from helper.ExchangeClient import get_portfolio

        for user_id in PortfolioDbContext.get_users_with_validated_connections():
            if stop_event.is_set():
                return
            if not AuthDbContext.is_user_active(user_id):
                continue

            for conn in ExchangeConnectionDbContext.get_validated_connections_by_user(user_id):
                if stop_event.is_set():
                    return
                conn_id = conn['id']
                try:
                    last = PortfolioDbContext.get_last_snapshot_time(user_id, conn_id)
                    if last is not None and last >= bucket:
                        continue  # already snapshotted this bucket

                    exchange = get_user_exchange(user_id, conn_id)
                    if not exchange:
                        continue

                    data = get_portfolio(exchange)
                    positions = data.get('positions', [])
                    total = float(data.get('total_usd', 0) or 0)
                    PortfolioDbContext.insert_snapshot(
                        user_id, conn_id, bucket, total, positions, is_estimated=False)

                    # If the app was closed, fill the gap behind this snapshot.
                    if last is not None and (bucket - last) > BUCKET_SECONDS:
                        self._backfill_gap(user_id, conn_id, last, bucket, exchange)

                except Exception as e:
                    print(f"[SNAPSHOT] user {user_id} conn {conn_id} failed: {e}")

    def _backfill_gap(self, user_id: int, conn_id: int, last_ts: int,
                      current: int, exchange) -> None:
        from controllers.PortfolioDbContext import PortfolioDbContext
        from helper.ExchangeClient import get_ohlcv_price_map

        snap = PortfolioDbContext.get_snapshot_with_assets(user_id, conn_id, last_ts)
        if not snap or not snap.get('assets'):
            return

        assets = [a for a in snap['assets'] if (a.get('amount') or 0) > 0]
        buckets = list(range(last_ts + BUCKET_SECONDS, current, BUCKET_SECONDS))
        if not buckets:
            return
        if len(buckets) > MAX_BACKFILL_BUCKETS:
            buckets = buckets[-MAX_BACKFILL_BUCKETS:]

        # One OHLCV pull per asset over the gap window; carry the last known
        # price forward where candles are missing.
        price_maps: dict[str, tuple] = {}
        for a in assets:
            sym = a['asset']
            if sym in _STABLE:
                continue
            amount = a['amount'] or 0
            last_price = (a['usd_value'] / amount) if amount else 0.0
            try:
                pm = get_ohlcv_price_map(exchange, sym, buckets[0], '30m')
            except Exception:
                pm = {}
            price_maps[sym] = (pm, last_price)

        for b in buckets:
            positions = []
            total = 0.0
            for a in assets:
                sym = a['asset']
                amount = a['amount'] or 0
                if amount <= 0:
                    continue
                if sym in _STABLE:
                    price = 1.0
                else:
                    pm, last_price = price_maps.get(sym, ({}, 0.0))
                    price = _price_at(pm, b, last_price)
                value = amount * price
                positions.append({'asset': sym, 'amount': amount, 'usd_value': value})
                total += value
            PortfolioDbContext.insert_snapshot(
                user_id, conn_id, b, total, positions, is_estimated=True)

        print(f"[SNAPSHOT] backfilled {len(buckets)} estimated point(s) "
              f"for user {user_id} conn {conn_id}")
