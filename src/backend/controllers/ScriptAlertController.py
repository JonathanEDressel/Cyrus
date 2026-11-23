"""Alerts on a custom indicator's alertcondition() or alert() calls.

The backend can't run Pine Script, so the app does the watching: its alert
monitor runs each armed alert's script on fresh candles once a minute and
reports a hit with POST /<id>/fire. This side stores the alerts (with the
script and inputs copied in when the alert was made, as TradingView does),
makes each fire idempotent per bar, and sends the email.
"""

import json

from flask import Blueprint, request

from controllers.ScriptAlertDbContext import ScriptAlertDbContext
from helper.alert_email import alert_when, send_alert_email
from helper.ErrorHandler import handle_error, bad_request, not_found
from helper.ExchangeRegistry import CHART_SOURCES, source_name
from helper.Helper import success_response, created_response
from helper.Security import token_required

script_alert_bp = Blueprint('script_alerts', __name__)

MAX_ACTIVE_ALERTS = 50
MAX_SOURCE_BYTES = 64 * 1024
MAX_MESSAGE_LEN = 500
MAX_INPUTS_BYTES = 16 * 1024
TIMEFRAMES = ('1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w')
FREQUENCIES = ('bar_close', 'bar', 'once')


def _public(row: dict) -> dict:
    out = dict(row)
    out.pop('user_id', None)
    try:
        out['inputs'] = json.loads(row.get('inputs') or '{}')
    except (TypeError, ValueError):
        out['inputs'] = {}
    return out


def _text(raw, limit: int) -> str | None:
    if not isinstance(raw, str):
        return None
    s = raw.strip()
    return s[:limit] if s else None


def _script_fields(body: dict, required: bool) -> tuple[dict, str | None]:
    """The script snapshot: source, inputs, names. All or nothing."""
    keys = ('script_source', 'inputs', 'indicator_name', 'condition_key', 'condition_title')
    if not required and not any(k in body for k in keys):
        return {}, None
    src = body.get('script_source')
    if not isinstance(src, str) or not src.strip():
        return {}, 'script_source is required'
    if len(src.encode('utf-8')) > MAX_SOURCE_BYTES:
        return {}, 'The script is too large'
    inputs = body.get('inputs') or {}
    if not isinstance(inputs, dict):
        return {}, 'inputs must be an object'
    enc_inputs = json.dumps(inputs, separators=(',', ':'))
    if len(enc_inputs) > MAX_INPUTS_BYTES:
        return {}, 'inputs are too large'
    name = _text(body.get('indicator_name'), 80)
    key = _text(body.get('condition_key'), 80)
    title = _text(body.get('condition_title'), 120)
    if not name or not key or not title:
        return {}, 'indicator_name, condition_key and condition_title are required'
    return {'script_source': src, 'inputs': enc_inputs, 'indicator_name': name,
            'condition_key': key, 'condition_title': title}, None


@script_alert_bp.route('/', methods=['GET'])
@token_required
def list_script_alerts():
    try:
        return success_response(data=[_public(r) for r in ScriptAlertDbContext.list_for_user(request.user_id)])
    except Exception as e:
        return handle_error(e)


@script_alert_bp.route('/', methods=['POST'])
@token_required
def create_script_alert():
    try:
        body = request.get_json(silent=True) or {}
        source = str(body.get('source') or '').lower()
        symbol = str(body.get('symbol') or '').strip()
        timeframe = body.get('timeframe')
        frequency = body.get('frequency') or 'bar_close'
        if source not in CHART_SOURCES:
            return bad_request('Unknown source')
        if not symbol or len(symbol) > 40:
            return bad_request('symbol is required')
        if timeframe not in TIMEFRAMES:
            return bad_request('Unknown timeframe')
        if frequency not in FREQUENCIES:
            return bad_request('Unknown frequency')
        script, err = _script_fields(body, True)
        if err:
            return bad_request(err)
        if ScriptAlertDbContext.count_active(request.user_id) >= MAX_ACTIVE_ALERTS:
            return bad_request(f'You can have up to {MAX_ACTIVE_ALERTS} active indicator alerts. Pause or remove some first.')
        ind_id, chart_id = body.get('indicator_id'), body.get('chart_id')
        new_id = ScriptAlertDbContext.create(request.user_id, {
            **script, 'source': source, 'symbol': symbol, 'timeframe': timeframe, 'frequency': frequency,
            'message': _text(body.get('message'), MAX_MESSAGE_LEN),
            'indicator_id': ind_id if isinstance(ind_id, int) else None,
            'chart_id': chart_id if isinstance(chart_id, int) else None,
        })
        return created_response(data=_public(ScriptAlertDbContext.get(request.user_id, new_id)), message='Alert created')
    except Exception as e:
        return handle_error(e)


@script_alert_bp.route('/<int:alert_id>', methods=['PUT'])
@token_required
def update_script_alert(alert_id: int):
    """Pause / resume / re-arm, change the message or frequency, or swap in a newer script."""
    try:
        row = ScriptAlertDbContext.get(request.user_id, alert_id)
        if not row:
            return not_found('Alert not found')
        body = request.get_json(silent=True) or {}
        fields, err = _script_fields(body, False)
        if err:
            return bad_request(err)
        if 'status' in body:
            if body['status'] not in ('active', 'paused'):
                return bad_request("status must be 'active' or 'paused'")
            if body['status'] == 'active' and row['status'] != 'active' and \
                    ScriptAlertDbContext.count_active(request.user_id) >= MAX_ACTIVE_ALERTS:
                return bad_request(f'You can have up to {MAX_ACTIVE_ALERTS} active indicator alerts.')
            fields['status'] = body['status']
        if 'frequency' in body:
            if body['frequency'] not in FREQUENCIES:
                return bad_request('Unknown frequency')
            fields['frequency'] = body['frequency']
        if 'message' in body:
            fields['message'] = _text(body.get('message'), MAX_MESSAGE_LEN)
        if not fields:
            return bad_request('Nothing to update')
        ScriptAlertDbContext.update(request.user_id, alert_id, fields)
        return success_response(data=_public(ScriptAlertDbContext.get(request.user_id, alert_id)), message='Alert updated')
    except Exception as e:
        return handle_error(e)


@script_alert_bp.route('/<int:alert_id>', methods=['DELETE'])
@token_required
def delete_script_alert(alert_id: int):
    try:
        if not ScriptAlertDbContext.delete(request.user_id, alert_id):
            return not_found('Alert not found')
        return success_response(message='Alert removed')
    except Exception as e:
        return handle_error(e)


@script_alert_bp.route('/<int:alert_id>/fire', methods=['POST'])
@token_required
def fire_script_alert(alert_id: int):
    """Record a hit on one bar. ``created`` is false if that bar already fired."""
    try:
        row = ScriptAlertDbContext.get(request.user_id, alert_id)
        if not row:
            return not_found('Alert not found')
        body = request.get_json(silent=True) or {}
        try:
            bar_time = int(body.get('bar_time'))
        except (TypeError, ValueError):
            return bad_request('bar_time is required')
        message = _text(body.get('message'), MAX_MESSAGE_LEN)
        created = ScriptAlertDbContext.record_fire(request.user_id, row, bar_time, message)
        if created:
            print(f"[ALERTS] Script alert {alert_id} fired: {row['indicator_name']} / {row['condition_title']} on {row['symbol']}")
            exch = source_name(row['source'])
            title = f"{row['indicator_name']}: {row['condition_title']}"
            send_alert_email(request.user_id, f"Cyrus: {title} on {row['symbol']}", {
                'rule_name': title,
                'when': alert_when(),
                'trigger': f"{row['condition_title']} on {row['symbol']} {row['timeframe']} ({exch})",
                'action': 'Indicator alert from your chart',
                'result': message or row.get('message') or 'The condition was met.',
                'reference': f"{exch} public price",
            })
        return success_response(data={'created': created, 'alert': _public(ScriptAlertDbContext.get(request.user_id, alert_id))})
    except Exception as e:
        return handle_error(e)


@script_alert_bp.route('/events', methods=['GET'])
@token_required
def script_alert_events():
    """Hits recorded after ``since`` (epoch s)."""
    try:
        try:
            since = int(request.args.get('since') or 0)
        except ValueError:
            return bad_request('since must be an integer')
        return success_response(data=ScriptAlertDbContext.events_since(request.user_id, since))
    except Exception as e:
        return handle_error(e)
