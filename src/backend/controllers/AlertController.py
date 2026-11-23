"""Price alerts set from lines on the Charts page.

An alert watches a public chart feed (``CHART_SOURCES``), so it needs no
exchange connection. A horizontal line alerts at its price; a trend line
alerts where the line is at that moment. The direction (rise to / fall to) is
fixed when the alert is made or moved, from where price is then, and the
worker (``automation/price_alerts.py``) fires it once.
"""

import time

import ccxt
from flask import Blueprint, request

from controllers.AlertDbContext import AlertDbContext, alert_price_at
from helper.ErrorHandler import handle_error, bad_request, not_found
from helper.ExchangeRegistry import CHART_SOURCES
from helper.Helper import success_response, created_response
from helper.PublicMarket import get_public
from helper.StockMarket import StockKeyError
from helper.Security import token_required

alert_bp = Blueprint('alerts', __name__)

MAX_ALERTS_PER_USER = 200
MAX_NOTE_LEN = 140


def _public(row: dict) -> dict:
    out = {k: row[k] for k in ('id', 'chart_id', 'drawing_id', 'source', 'symbol', 'kind', 'price',
                               't1', 'p1', 't2', 'p2', 'direction', 'note', 'status', 'created_at',
                               'triggered_at', 'triggered_price')}
    out['price_now'] = alert_price_at(row, int(time.time()))
    return out


def _geometry(body: dict) -> tuple[dict | None, str | None]:
    """Validate the alert's shape from the request body."""
    kind = body.get('kind')
    try:
        if kind == 'level':
            price = float(body.get('price'))
            if not price > 0:
                return None, 'price must be above zero'
            return {'kind': 'level', 'price': price}, None
        if kind == 'line':
            pts = body.get('points')
            if not isinstance(pts, list) or len(pts) != 2:
                return None, 'a line alert needs two points'
            (t1, p1), (t2, p2) = [(int(p['time']), float(p['price'])) for p in pts]
            if t1 == t2:
                return None, 'a line alert needs two different times'
            return {'kind': 'line', 't1': t1, 'p1': p1, 't2': t2, 'p2': p2}, None
    except (TypeError, ValueError, KeyError):
        return None, 'invalid alert price'
    return None, "kind must be 'level' or 'line'"


def _direction(source: str, symbol: str, geom: dict, fallback,
               user_id: int | None = None) -> tuple[str | None, str | None]:
    """'above' when the target is over the current price (fires on a rise), else 'below'."""
    target = alert_price_at(geom, int(time.time()))
    if target is None:
        return None, 'invalid alert price'
    try:
        last = get_public(source, user_id).fetch_ticker(symbol).get('last')
    except ccxt.BadSymbol:
        return None, f'{symbol} is not traded on that exchange'
    except StockKeyError as e:
        return None, str(e)
    except Exception:
        last = None
    if last is None:
        if fallback in ('above', 'below'):
            return fallback, None
        return None, 'Couldn’t read the current price to set the alert'
    return ('above' if target > last else 'below'), None


@alert_bp.route('/', methods=['GET'])
@token_required
def list_alerts():
    try:
        return success_response(data=[_public(r) for r in AlertDbContext.list_for_user(request.user_id)])
    except Exception as e:
        return handle_error(e)


@alert_bp.route('/', methods=['POST'])
@token_required
def create_alert():
    try:
        body = request.get_json(silent=True) or {}
        source = str(body.get('source') or '').lower()
        symbol = str(body.get('symbol') or '').strip()
        if source not in CHART_SOURCES:
            return bad_request('Unknown source')
        if not symbol:
            return bad_request('symbol is required')
        if AlertDbContext.count_for_user(request.user_id) >= MAX_ALERTS_PER_USER:
            return bad_request(f'You can have up to {MAX_ALERTS_PER_USER} alerts. Remove some first.')
        geom, err = _geometry(body)
        if err:
            return bad_request(err)
        direction, err = _direction(source, symbol, geom, body.get('direction'), request.user_id)
        if err:
            return bad_request(err)
        chart_id = body.get('chart_id')
        fields = {
            **geom, 'source': source, 'symbol': symbol, 'direction': direction,
            'note': (str(body.get('note') or '').strip()[:MAX_NOTE_LEN] or None),
            'chart_id': int(chart_id) if isinstance(chart_id, int) else None,
            'drawing_id': str(body.get('drawing_id'))[:64] if body.get('drawing_id') else None,
        }
        new_id = AlertDbContext.create(request.user_id, fields)
        return created_response(data=_public(AlertDbContext.get(request.user_id, new_id)), message='Alert set')
    except Exception as e:
        return handle_error(e)


@alert_bp.route('/<int:alert_id>', methods=['PUT'])
@token_required
def update_alert(alert_id: int):
    """Move an alert to a new price or line (re-arms it)."""
    try:
        row = AlertDbContext.get(request.user_id, alert_id)
        if not row:
            return not_found('Alert not found')
        body = request.get_json(silent=True) or {}
        geom, err = _geometry(body)
        if err:
            return bad_request(err)
        direction, err = _direction(row['source'], row['symbol'], geom, body.get('direction'), request.user_id)
        if err:
            return bad_request(err)
        note = body.get('note')
        AlertDbContext.update_geometry(request.user_id, alert_id, {
            **geom, 'direction': direction,
            'note': str(note).strip()[:MAX_NOTE_LEN] if isinstance(note, str) else None,
        })
        return success_response(data=_public(AlertDbContext.get(request.user_id, alert_id)), message='Alert updated')
    except Exception as e:
        return handle_error(e)


@alert_bp.route('/<int:alert_id>', methods=['DELETE'])
@token_required
def delete_alert(alert_id: int):
    try:
        if not AlertDbContext.delete(request.user_id, alert_id):
            return not_found('Alert not found')
        return success_response(message='Alert removed')
    except Exception as e:
        return handle_error(e)


@alert_bp.route('/events', methods=['GET'])
@token_required
def alert_events():
    """Alerts that fired after ``since`` (epoch s), for desktop notifications."""
    try:
        try:
            since = int(request.args.get('since') or 0)
        except ValueError:
            return bad_request('since must be an integer')
        rows = AlertDbContext.triggered_since(request.user_id, since)
        return success_response(data=[_public(r) for r in rows])
    except Exception as e:
        return handle_error(e)
