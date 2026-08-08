"""Chunked backfill of exchange transfer history into ``transfer_history``.

Full history is thousands of rows behind dozens of rate-limited, windowed API
calls — far too much for one HTTP request. So a sync call does a *bounded slice*
of work: it fetches until it runs out of budget, commits what it got, advances
the durable watermark, and reports back that it is not finished. The caller
loops. Nothing is lost if the loop stops early, because progress lives in
``transfer_sync_state`` rather than in the request.

Deliberately not on the automation worker. That thread evaluates rules that move
real money on a 60-second cadence, and a slow backfill sharing it would delay
them. Being request-driven instead means the cost lands only on the user who
opened the page.

The concurrency guard in :func:`sync_connection` is load-bearing rather than
defensive. ``get_user_exchange`` builds a **fresh ccxt client per call** and
``enableRateLimit`` throttles per instance, so two concurrent syncs share no
token bucket at all. Werkzeug serves threaded, so without the lock a double
click is two uncoordinated backfills racing on the same API key — the key the
automation worker also uses to trade.
"""

import json
import threading
import time
import traceback

import ccxt

from controllers.TransferDbContext import TransferDbContext
from helper.ExchangeClient import (can_fetch_transfers, fetch_ledger_transfers,
                                   fetch_transfer_window, list_transfer_accounts)
from helper.ExchangeRegistry import (get_connection_row, get_transfer_history_config,
                                     get_user_exchange, supports_transfer_history)
from helper.robinhood.errors import RobinhoodError

#: Wall-clock ceiling for one sync call, checked before every page. Well under
#: any sane HTTP timeout, so a request returns promptly however much history is
#: left; the remainder is picked up by the next call.
BUDGET_SECONDS = 12

#: How far to rewind past the watermark on an incremental sync. Covers rows that
#: land slightly out of order and exchanges whose `since` is exclusive.
OVERLAP_SECONDS = 86400

#: Once the backfill is complete, never rewind further than this — otherwise a
#: single ancient pending row would drag every future sync back years.
MAX_REWIND_SECONDS = 30 * 86400

#: A window returning at least its page cap has almost certainly been truncated
#: by the exchange, so it is halved and retried rather than advanced past.
MIN_BISECT_SECONDS = 3600

KINDS = ('deposit', 'withdrawal')

#: One lock per connection id. Held for the duration of a sync call; a second
#: caller is turned away rather than queued, since queueing would just move the
#: pile-up rather than prevent it.
_locks: dict[int, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(conn_id: int) -> threading.Lock:
    with _locks_guard:
        if conn_id not in _locks:
            _locks[conn_id] = threading.Lock()
        return _locks[conn_id]


class _Disabled(Exception):
    """A failure that will recur until a human intervenes (usually a key scope)."""


def _classify(exc: Exception, exchange_name: str) -> tuple[bool, str]:
    """``(is_permanent, message)`` for an exception raised while fetching.

    The clause order tracks ccxt's real hierarchy rather than the intuitive one:
    ``RateLimitExceeded`` is a *sibling* of ``DDoSProtection`` beneath
    ``NetworkError`` (not a child), and ``NetworkError`` and ``ExchangeError``
    are disjoint trees, so a single ``except ccxt.ExchangeError`` catches
    neither. ``AttributeError`` is in here because the Robinhood adapter simply
    does not define these methods, and that miss is not a ccxt error at all.
    """
    if isinstance(exc, (ccxt.DDoSProtection, ccxt.RateLimitExceeded)):
        return False, f"{exchange_name} is rate-limiting requests; will resume shortly."
    if isinstance(exc, (ccxt.ExchangeNotAvailable, ccxt.RequestTimeout)):
        return False, f"Could not reach {exchange_name}; will retry."
    if isinstance(exc, ccxt.AuthenticationError):
        # Covers PermissionDenied, which is the single most likely failure on a
        # first sync: existing keys were only ever validated against
        # fetch_balance, and transfer history needs a funding/read scope on top.
        return True, (
            f"Your {exchange_name} API key was rejected for transfer history. "
            f"This usually means the key lacks the funding-history permission "
            f"(Kraken: \"Query Funds\", Binance: \"Enable Reading\"). Regenerate "
            f"the key with that permission and re-validate it in your profile.")
    if isinstance(exc, (ccxt.NotSupported, ccxt.ArgumentsRequired, ccxt.BadRequest)):
        return True, f"{exchange_name} does not expose this transfer history ({exc})."
    if isinstance(exc, ccxt.NetworkError):
        return False, f"Network error talking to {exchange_name}; will retry."
    if isinstance(exc, (RobinhoodError, AttributeError)):
        return True, f"{exchange_name} has no transfer-history API."
    return False, str(exc)


def _resume_point(state: dict, config: dict, now: int) -> int:
    """Where this target's next fetch should start, in epoch seconds.

    A plain high-water mark is wrong here. ``occurred_at`` is a transfer's
    creation time and never moves, but its *status* does — a withdrawal can sit
    pending for days — so a watermark parked at ``now`` would freeze those rows
    as pending forever. Hence: rewind past the mark, rewind further if anything
    is still unsettled, and only once the backfill is finished apply a floor so
    one stuck ancient row cannot drag every sync back to the epoch.
    """
    epoch = int(state.get('history_epoch') or config.get('history_epoch') or 0)
    base = int(state.get('synced_through') or epoch) - OVERLAP_SECONDS

    oldest_unsettled = TransferDbContext.get_oldest_unsettled(
        state['exchange_connection_id'], state['kind'])
    if oldest_unsettled:
        base = min(base, int(oldest_unsettled) - 3600)

    if state.get('backfill_complete'):
        base = max(base, now - MAX_REWIND_SECONDS)

    return max(base, epoch)


def _sync_windowed(exchange, user_id: int, conn_id: int, exchange_name: str,
                   kind: str, config: dict, state: dict, deadline: float) -> dict:
    """Walk fixed time windows forward for one kind (Kraken, Binance).

    Returns ``{'complete': bool, 'new_rows': int, 'synced_through': int}``.
    """
    now = int(time.time())
    cursor = _resume_point(state, config, now)
    window = int(config['window_seconds'])
    page_cap = int(config['page_cap'])
    pacing = config.get('page_pacing_ms', 1000) / 1000.0
    new_rows = 0

    while cursor < now:
        if time.time() >= deadline:
            return {'complete': False, 'new_rows': new_rows, 'synced_through': cursor}

        window_end = min(cursor + window, now)
        rows = fetch_transfer_window(exchange, kind, cursor * 1000, window_end * 1000,
                                     limit=page_cap)

        # A full page means the exchange probably truncated the window, so halve
        # it and retry instead of advancing past data we never saw. Bisecting
        # rather than paging with an offset keeps this exchange-agnostic.
        if len(rows) >= page_cap:
            half = (window_end - cursor) // 2
            if half >= MIN_BISECT_SECONDS:
                window = half
                continue

        new_rows += TransferDbContext.save_window(
            conn_id, user_id, exchange_name, rows,
            kind=kind, synced_through=window_end)
        cursor = window_end

        # Restore the configured width after a successful narrowed window, so
        # one dense month doesn't slow the rest of the backfill to a crawl.
        window = int(config['window_seconds'])

        if cursor < now:
            time.sleep(pacing)

    return {'complete': True, 'new_rows': new_rows, 'synced_through': cursor}


def _sync_ledger(exchange, user_id: int, conn_id: int, exchange_name: str,
                 config: dict, state: dict, deadline: float) -> dict:
    """Walk Coinbase's per-account ledger.

    Coinbase's transactions endpoint has no server-side time filter, so this is
    a whole-tail pass per account rather than a window walk, and the unit of
    resumption is the account rather than the window: the remaining queue is
    persisted so the next call picks up where this one ran out of budget.

    The watermark moves to ``pass_started_at`` and only once the queue drains.
    Advancing to ``now()`` instead would skip anything created while the pass
    was running, and advancing per-account would strand the unwalked ones.
    """
    now = int(time.time())
    pass_started_at = int(state.get('pass_started_at') or now)

    queue = state.get('account_queue')
    if queue:
        try:
            queue = json.loads(queue)
        except (TypeError, ValueError):
            queue = None
    if not queue:
        queue = list_transfer_accounts(exchange)
        pass_started_at = now

    since_ts = _resume_point(state, config, now)
    pacing = config.get('page_pacing_ms', 350) / 1000.0
    new_rows = 0

    while queue:
        if time.time() >= deadline:
            # Persist the remainder without touching the watermark; the pass is
            # only meaningful once every account has been walked.
            TransferDbContext.save_window(
                conn_id, user_id, exchange_name, [], kind='deposit',
                account_queue=queue, pass_started_at=pass_started_at)
            TransferDbContext.save_window(
                conn_id, user_id, exchange_name, [], kind='withdrawal',
                account_queue=queue, pass_started_at=pass_started_at)
            return {'complete': False, 'new_rows': new_rows, 'synced_through': since_ts}

        account_id = queue.pop(0)
        rows = fetch_ledger_transfers(exchange, account_id, since_ts * 1000,
                                      limit=int(config['page_cap']))

        # One fetch yields both directions — the sign of the amount decides —
        # so rows are split by kind and each half booked against its own state
        # row. save_window reads each row's own 'kind' for the insert.
        for target_kind in KINDS:
            subset = [r for r in rows if r['kind'] == target_kind]
            if subset:
                new_rows += TransferDbContext.save_window(
                    conn_id, user_id, exchange_name, subset, kind=None)

        if queue:
            time.sleep(pacing)

    for target_kind in KINDS:
        TransferDbContext.finish_pass(conn_id, target_kind, pass_started_at)
    return {'complete': True, 'new_rows': new_rows, 'synced_through': pass_started_at}


def _sync_target(exchange, user_id: int, conn_id: int, exchange_name: str,
                 kind: str, config: dict, deadline: float) -> dict:
    """One (connection, kind) target, with the full error net around it."""
    state = TransferDbContext.ensure_sync_state(conn_id, kind, config['history_epoch'])
    if state.get('disabled'):
        return {'complete': True, 'new_rows': 0, 'skipped': 'disabled'}

    try:
        if not can_fetch_transfers(exchange, kind, config['source']):
            raise _Disabled(f"{exchange_name} does not expose {kind} history.")

        result = _sync_windowed(exchange, user_id, conn_id, exchange_name,
                                kind, config, state, deadline)
        if result['complete']:
            TransferDbContext.finish_pass(conn_id, kind, result['synced_through'])
        else:
            TransferDbContext.mark_sync_ok(conn_id, kind)
        return result

    except _Disabled as e:
        TransferDbContext.set_disabled(conn_id, kind, str(e))
        return {'complete': True, 'new_rows': 0, 'skipped': 'unsupported'}
    except Exception as e:
        permanent, message = _classify(e, exchange_name)
        if permanent:
            TransferDbContext.set_disabled(conn_id, kind, message)
        else:
            TransferDbContext.mark_sync_error(conn_id, kind, message)
            traceback.print_exc()
        print(f"[TRANSFERS] conn {conn_id} {kind}: {message}")
        return {'complete': False, 'new_rows': 0, 'error': message}


def sync_connection(user_id: int, conn_id: int,
                    budget_seconds: int = BUDGET_SECONDS) -> dict:
    """Run one bounded slice of sync for a connection.

    Returns ``{'complete', 'new_rows', 'already_running', 'error'}``.
    ``complete`` is False when there is more history left — the caller is
    expected to call again rather than treat it as a failure.
    """
    row = get_connection_row(user_id, conn_id)
    if not row:
        return {'complete': True, 'new_rows': 0, 'error': 'Connection not found'}

    exchange_name = row['exchange_name']
    if not supports_transfer_history(exchange_name):
        return {'complete': True, 'new_rows': 0, 'unsupported': True}
    if not row.get('is_validated'):
        return {'complete': True, 'new_rows': 0,
                'error': 'API keys have not been validated.'}

    config = get_transfer_history_config(exchange_name)
    if not config:
        return {'complete': True, 'new_rows': 0, 'unsupported': True}

    lock = _lock_for(conn_id)
    if not lock.acquire(blocking=False):
        return {'complete': False, 'new_rows': 0, 'already_running': True}

    deadline = time.time() + budget_seconds
    try:
        try:
            exchange = get_user_exchange(user_id, conn_id)
        except Exception as e:
            _, message = _classify(e, exchange_name)
            return {'complete': False, 'new_rows': 0, 'error': message}

        # One client for every target on this connection, so ccxt's own rate
        # limiter stays meaningful across deposits and withdrawals instead of
        # each getting a fresh, empty token bucket.
        if config['source'] == 'ledger':
            for kind in KINDS:
                TransferDbContext.ensure_sync_state(conn_id, kind, config['history_epoch'])
            state = TransferDbContext.get_sync_state(conn_id, 'deposit') or {}
            if state.get('disabled'):
                return {'complete': True, 'new_rows': 0, 'skipped': 'disabled'}
            try:
                if not can_fetch_transfers(exchange, 'deposit', 'ledger'):
                    raise _Disabled(f"{exchange_name} does not expose a ledger.")
                result = _sync_ledger(exchange, user_id, conn_id, exchange_name,
                                      config, state, deadline)
                return {'complete': result['complete'], 'new_rows': result['new_rows']}
            except _Disabled as e:
                for kind in KINDS:
                    TransferDbContext.set_disabled(conn_id, kind, str(e))
                return {'complete': True, 'new_rows': 0, 'skipped': 'unsupported'}
            except Exception as e:
                permanent, message = _classify(e, exchange_name)
                for kind in KINDS:
                    if permanent:
                        TransferDbContext.set_disabled(conn_id, kind, message)
                    else:
                        TransferDbContext.mark_sync_error(conn_id, kind, message)
                if not permanent:
                    traceback.print_exc()
                print(f"[TRANSFERS] conn {conn_id} ledger: {message}")
                return {'complete': False, 'new_rows': 0, 'error': message}

        total_new, complete, error = 0, True, None
        for kind in KINDS:
            result = _sync_target(exchange, user_id, conn_id, exchange_name,
                                  kind, config, deadline)
            total_new += result.get('new_rows', 0)
            complete = complete and result.get('complete', False)
            error = error or result.get('error')
        return {'complete': complete, 'new_rows': total_new, 'error': error}

    finally:
        lock.release()
