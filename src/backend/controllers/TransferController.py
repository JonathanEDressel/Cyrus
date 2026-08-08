"""HTTP surface for exchange transfer history.

Reads and writes are strictly separated. ``GET /`` and ``GET /status`` never
touch an exchange — they serve whatever the last sync persisted, so opening the
page is a couple of indexed queries regardless of how much history exists. Only
``POST /sync`` talks to an exchange, and it does one bounded slice of work per
call (see ``helper/TransferSync.py``) so the request always returns promptly
even when years of backfill remain.
"""

import time

from flask import Blueprint, request

from controllers.ExchangeConnectionDbContext import ExchangeConnectionDbContext
from controllers.TransferDbContext import TransferDbContext
from helper.ErrorHandler import handle_error, bad_request, not_found
from helper.Helper import success_response
from helper.Security import token_required, active_required
from helper.ExchangeRegistry import get_connection_row, supports_transfer_history

transfer_bp = Blueprint('transfers', __name__)

KINDS = ('deposit', 'withdrawal')

MAX_PAGE_SIZE = 500
DEFAULT_PAGE_SIZE = 100


def _clamp_int(value, default: int, low: int, high: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


def _optional_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _owned_conn_id(user_id: int, raw):
    """``(conn_id, error_response)``. A blank/``all`` value means every connection.

    Ownership is re-checked here rather than trusted from the query string —
    otherwise ``?conn_id=`` would read another user's transfer history.
    """
    if raw is None or str(raw).strip() == '' or str(raw).lower() == 'all':
        return None, None
    try:
        conn_id = int(raw)
    except (TypeError, ValueError):
        return None, bad_request('conn_id must be an integer')
    if not get_connection_row(user_id, conn_id):
        return None, not_found('Exchange connection not found')
    return conn_id, None


def _target_state(rows_by_kind: dict, kind: str, exchange_name: str,
                  now: int) -> dict:
    """Render one (connection, kind) sync-state row for the API."""
    if not supports_transfer_history(exchange_name):
        return {'state': 'unsupported', 'progress_pct': 0}

    state = rows_by_kind.get(kind)
    if not state or not state.get('synced_through'):
        return {'state': 'not_started', 'progress_pct': 0}

    if state.get('disabled'):
        return {
            'state': 'disabled',
            'progress_pct': 0,
            'disabled_reason': state.get('disabled_reason'),
        }

    epoch = int(state.get('history_epoch') or 0)
    synced_through = int(state.get('synced_through') or 0)
    complete = bool(state.get('backfill_complete'))

    span = max(now - epoch, 1)
    progress = 100 if complete else max(0, min(100, int((synced_through - epoch) / span * 100)))

    last_ok = state.get('last_sync_ok_at')
    return {
        # 'error' only when nothing is in flight — a transient failure part-way
        # through a backfill is still progress, not a dead end.
        'state': 'error' if (state.get('last_error') and not complete and progress == 0)
                 else ('idle' if complete else 'backfilling'),
        'progress_pct': progress,
        'synced_through': synced_through,
        'backfill_complete': complete,
        'last_sync_ok_at': last_ok,
        # Computed server-side: the client's clock cannot be trusted to agree.
        'age_seconds': (now - int(last_ok)) if last_ok else None,
        'last_error': state.get('last_error'),
    }


def _build_status(user_id: int) -> dict:
    """Per-connection sync status for the whole user."""
    now = int(time.time())
    rows = TransferDbContext.get_sync_states_by_user(user_id)

    connections: dict[int, dict] = {}
    for row in rows:
        conn_id = row['exchange_connection_id']
        entry = connections.get(conn_id)
        if entry is None:
            exchange_name = row['exchange_name']
            entry = connections[conn_id] = {
                'connection_id': conn_id,
                'exchange': exchange_name,
                'label': row.get('label'),
                'supported': supports_transfer_history(exchange_name),
                '_by_kind': {},
            }
        if row.get('kind'):
            entry['_by_kind'][row['kind']] = row

    out = []
    any_pending = False
    for entry in connections.values():
        by_kind = entry.pop('_by_kind')
        entry['kinds'] = {
            kind: _target_state(by_kind, kind, entry['exchange'], now)
            for kind in KINDS
        }
        if any(k['state'] in ('not_started', 'backfilling')
               for k in entry['kinds'].values()):
            any_pending = True
        out.append(entry)

    return {'connections': out, 'any_pending': any_pending}


@transfer_bp.route('/', methods=['GET'])
@token_required
@active_required
def list_transfers():
    try:
        user_id = request.user_id
        conn_id, err = _owned_conn_id(user_id, request.args.get('conn_id'))
        if err:
            return err

        kind = (request.args.get('kind') or '').strip().lower() or None
        if kind and kind not in KINDS:
            return bad_request("kind must be 'deposit' or 'withdrawal'")

        asset = (request.args.get('asset') or '').strip().upper() or None
        status = (request.args.get('status') or '').strip().lower() or None
        since_ts = _optional_int(request.args.get('from'))
        until_ts = _optional_int(request.args.get('to'))
        limit = _clamp_int(request.args.get('limit'), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE)
        offset = _clamp_int(request.args.get('offset'), 0, 0, 10_000_000)

        filters = dict(conn_id=conn_id, kind=kind, asset=asset, status=status,
                       since_ts=since_ts, until_ts=until_ts)
        items = TransferDbContext.list_transfers(user_id, limit=limit, offset=offset,
                                                 **filters)
        total = TransferDbContext.count_transfers(user_id, **filters)

        # The sync block rides along so the page renders in one round-trip and
        # still knows whether to show a "syncing" affordance.
        return success_response(data={
            'items': items,
            'total': total,
            'limit': limit,
            'offset': offset,
            'sync': _build_status(user_id),
        })
    except Exception as e:
        return handle_error(e)


@transfer_bp.route('/status', methods=['GET'])
@token_required
@active_required
def sync_status():
    try:
        return success_response(data=_build_status(request.user_id))
    except Exception as e:
        return handle_error(e)


@transfer_bp.route('/sync', methods=['POST'])
@token_required
@active_required
def run_sync():
    """Run one bounded slice of sync and report progress.

    ``complete: false`` is the normal case mid-backfill, not an error — the
    caller loops until it flips. A connection already syncing in another request
    reports ``already_running`` rather than starting a second, competing walk
    against the same API key.
    """
    try:
        from helper.TransferSync import sync_connection

        user_id = request.user_id
        body = request.get_json(silent=True) or {}
        conn_id, err = _owned_conn_id(user_id, body.get('conn_id'))
        if err:
            return err

        if conn_id is not None:
            targets = [conn_id]
        else:
            targets = [
                c['id'] for c in
                ExchangeConnectionDbContext.get_validated_connections_by_user(user_id)
                if supports_transfer_history(c['exchange_name'])
            ]

        complete, new_rows, already_running = True, 0, False
        for target in targets:
            result = sync_connection(user_id, target)
            new_rows += result.get('new_rows', 0)
            if result.get('already_running'):
                already_running = True
            if not result.get('complete', True):
                complete = False

        return success_response(data={
            'complete': complete,
            'new_rows': new_rows,
            'already_running': already_running,
            'sync': _build_status(user_id),
        })
    except Exception as e:
        return handle_error(e)


@transfer_bp.route('/assets', methods=['GET'])
@token_required
@active_required
def transfer_assets():
    try:
        return success_response(data=TransferDbContext.get_distinct_assets(request.user_id))
    except Exception as e:
        return handle_error(e)
