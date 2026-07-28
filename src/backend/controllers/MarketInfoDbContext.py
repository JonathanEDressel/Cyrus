"""Cache for third-party asset fundamentals (see helper/coingecko.py).

Keyed by ticker rather than by user: market cap and supply are the same numbers
for every account, so one cache serves the whole install and keeps the number of
outbound requests down.
"""

import json
import time

from helper.Helper import execute_query_one, execute_query_all, execute_non_query


class MarketInfoDbContext:

    @staticmethod
    def get_coin_id(symbol: str) -> str | None:
        row = execute_query_one(
            'SELECT coin_id FROM asset_market_info WHERE symbol = ?',
            (symbol.upper(),)
        )
        return row['coin_id'] if row and row.get('coin_id') else None

    @staticmethod
    def is_unresolvable(symbol: str, retry_after: int = 86400) -> bool:
        """True when a recent lookup already failed to identify this ticker.

        Without this, an asset CoinGecko doesn't list would trigger a search
        request on every page load, forever.
        """
        row = execute_query_one(
            'SELECT coin_id, resolved_at FROM asset_market_info WHERE symbol = ?',
            (symbol.upper(),)
        )
        if not row or row.get('coin_id'):
            return False
        return (time.time() - int(row.get('resolved_at') or 0)) < retry_after

    @staticmethod
    def set_coin_id(symbol: str, coin_id: str | None) -> None:
        execute_non_query(
            '''INSERT INTO asset_market_info (symbol, coin_id, resolved_at)
               VALUES (?, ?, ?)
               ON CONFLICT(symbol) DO UPDATE SET
                 coin_id = excluded.coin_id,
                 resolved_at = excluded.resolved_at''',
            (symbol.upper(), coin_id, int(time.time()))
        )

    @staticmethod
    def get_snapshot(symbol: str, max_age_seconds: int) -> dict | None:
        """Return cached fundamentals if they're fresh enough, else None."""
        row = execute_query_one(
            'SELECT payload, fetched_at FROM asset_market_info WHERE symbol = ?',
            (symbol.upper(),)
        )
        if not row or not row.get('payload'):
            return None
        if (time.time() - int(row.get('fetched_at') or 0)) > max_age_seconds:
            return None
        try:
            return json.loads(row['payload'])
        except (ValueError, TypeError):
            return None

    @staticmethod
    def get_snapshot_any_age(symbol: str) -> tuple[dict | None, int]:
        """Return ``(payload, age_seconds)`` regardless of age.

        Used when the provider is unreachable: stale fundamentals labelled with
        their age beat empty cells.
        """
        row = execute_query_one(
            'SELECT payload, fetched_at FROM asset_market_info WHERE symbol = ?',
            (symbol.upper(),)
        )
        if not row or not row.get('payload'):
            return None, 0
        try:
            return json.loads(row['payload']), int(time.time() - int(row.get('fetched_at') or 0))
        except (ValueError, TypeError):
            return None, 0

    @staticmethod
    def set_snapshot(symbol: str, coin_id: str, payload: dict) -> None:
        now = int(time.time())
        execute_non_query(
            '''INSERT INTO asset_market_info (symbol, coin_id, payload, fetched_at, resolved_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(symbol) DO UPDATE SET
                 coin_id = excluded.coin_id,
                 payload = excluded.payload,
                 fetched_at = excluded.fetched_at''',
            (symbol.upper(), coin_id, json.dumps(payload), now, now)
        )

    @staticmethod
    def get_all_cached() -> list:
        return execute_query_all('SELECT symbol, coin_id, fetched_at FROM asset_market_info', ())
