"""Saved charts for the Charts page.

A chart's `state` is the client's own JSON document (panes, timeframe,
indicators, drawings). Like the dashboard layout, the server checks only its
shape and size, so adding a drawing tool or indicator never needs a backend
change.
"""

import json

from flask import Blueprint, request
from helper.Security import token_required
from helper.ErrorHandler import handle_error, bad_request, not_found
from helper.Helper import success_response, created_response
from controllers.ChartDbContext import ChartDbContext

chart_bp = Blueprint('charts', __name__)

MAX_CHART_STATE_BYTES = 256 * 1024
MAX_PANES = 4
MAX_DRAWINGS = 500
MAX_NAME_LEN = 80


def _clean_name(raw) -> str | None:
    if not isinstance(raw, str):
        return None
    name = raw.strip()
    return name if 0 < len(name) <= MAX_NAME_LEN else None


def _encode_state(state) -> tuple[str | None, str | None]:
    """Validate a chart state's shape; return (encoded, error)."""
    if not isinstance(state, dict):
        return None, "state must be an object"
    panes = state.get('panes')
    if not isinstance(panes, list) or not 1 <= len(panes) <= MAX_PANES:
        return None, f"a chart needs 1 to {MAX_PANES} panes"
    if not isinstance(state.get('timeframe'), str):
        return None, "state.timeframe is required"
    drawings = 0
    for pane in panes:
        if not isinstance(pane, dict) or not isinstance(pane.get('symbol'), str) or not pane['symbol']:
            return None, "every pane needs a symbol"
        d = pane.get('drawings', [])
        if not isinstance(d, list):
            return None, "pane drawings must be a list"
        drawings += len(d)
    if drawings > MAX_DRAWINGS:
        return None, f"a chart can hold at most {MAX_DRAWINGS} drawings"
    encoded = json.dumps(state, separators=(',', ':'))
    if len(encoded.encode('utf-8')) > MAX_CHART_STATE_BYTES:
        return None, "chart is too large"
    return encoded, None


def _decode(row: dict, include_state: bool) -> dict:
    try:
        state = json.loads(row['state'])
    except (ValueError, TypeError):
        state = None
    out = {
        'id': row['id'],
        'name': row['name'],
        'created_at': row['created_at'],
        'updated_at': row['updated_at'],
    }
    if include_state:
        out['state'] = state
    else:
        panes = (state or {}).get('panes') or []
        out['symbols'] = [p.get('symbol') for p in panes if isinstance(p, dict)]
        out['timeframe'] = (state or {}).get('timeframe')
    return out


@chart_bp.route('/', methods=['GET'])
@token_required
def list_charts():
    try:
        rows = ChartDbContext.list_for_user(request.user_id)
        return success_response(data=[_decode(r, False) for r in rows])
    except Exception as e:
        return handle_error(e)


@chart_bp.route('/<int:chart_id>', methods=['GET'])
@token_required
def get_chart(chart_id: int):
    try:
        row = ChartDbContext.get(request.user_id, chart_id)
        if not row:
            return not_found("Chart not found")
        return success_response(data=_decode(row, True))
    except Exception as e:
        return handle_error(e)


@chart_bp.route('/', methods=['POST'])
@token_required
def create_chart():
    try:
        body = request.get_json(silent=True) or {}
        name = _clean_name(body.get('name'))
        if name is None:
            return bad_request(f"Name is required (up to {MAX_NAME_LEN} characters)")
        encoded, err = _encode_state(body.get('state'))
        if err:
            return bad_request(err)
        new_id = ChartDbContext.create(request.user_id, name, encoded)
        row = ChartDbContext.get(request.user_id, new_id)
        return created_response(data=_decode(row, True), message="Chart saved")
    except Exception as e:
        return handle_error(e)


@chart_bp.route('/<int:chart_id>', methods=['PUT'])
@token_required
def update_chart(chart_id: int):
    try:
        body = request.get_json(silent=True) or {}
        name = None
        encoded = None
        if 'name' in body:
            name = _clean_name(body.get('name'))
            if name is None:
                return bad_request(f"Name is required (up to {MAX_NAME_LEN} characters)")
        if 'state' in body:
            encoded, err = _encode_state(body.get('state'))
            if err:
                return bad_request(err)
        if name is None and encoded is None:
            return bad_request("Nothing to update")
        if not ChartDbContext.update(request.user_id, chart_id, name, encoded):
            return not_found("Chart not found")
        row = ChartDbContext.get(request.user_id, chart_id)
        return success_response(data=_decode(row, True), message="Chart saved")
    except Exception as e:
        return handle_error(e)


@chart_bp.route('/<int:chart_id>', methods=['DELETE'])
@token_required
def delete_chart(chart_id: int):
    try:
        if not ChartDbContext.delete(request.user_id, chart_id):
            return not_found("Chart not found")
        return success_response(message="Chart deleted")
    except Exception as e:
        return handle_error(e)
