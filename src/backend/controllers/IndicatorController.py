"""Custom indicators for the Charts page, written in Pine Script.

The script is the client's: the app's interpreter parses and runs it, so the
server only checks the name and size. Charts refer to a script by id.
"""

from flask import Blueprint, request

from controllers.IndicatorDbContext import IndicatorDbContext
from helper.ErrorHandler import handle_error, bad_request, not_found
from helper.Helper import success_response, created_response
from helper.Security import token_required

indicator_bp = Blueprint('indicators', __name__)

MAX_INDICATORS_PER_USER = 200
MAX_NAME_LEN = 80
MAX_SOURCE_BYTES = 64 * 1024


def _clean_name(raw) -> str | None:
    if not isinstance(raw, str):
        return None
    name = raw.strip()
    return name if 0 < len(name) <= MAX_NAME_LEN else None


def _clean_source(raw) -> tuple[str | None, str | None]:
    if not isinstance(raw, str) or not raw.strip():
        return None, 'The script is empty'
    if len(raw.encode('utf-8')) > MAX_SOURCE_BYTES:
        return None, f'Scripts can be up to {MAX_SOURCE_BYTES // 1024} KB'
    return raw.replace('\r\n', '\n'), None


@indicator_bp.route('/', methods=['GET'])
@token_required
def list_indicators():
    try:
        return success_response(data=IndicatorDbContext.list_for_user(request.user_id))
    except Exception as e:
        return handle_error(e)


@indicator_bp.route('/<int:indicator_id>', methods=['GET'])
@token_required
def get_indicator(indicator_id: int):
    try:
        row = IndicatorDbContext.get(request.user_id, indicator_id)
        if not row:
            return not_found('Indicator not found')
        return success_response(data=row)
    except Exception as e:
        return handle_error(e)


@indicator_bp.route('/', methods=['POST'])
@token_required
def create_indicator():
    try:
        body = request.get_json(silent=True) or {}
        name = _clean_name(body.get('name'))
        if name is None:
            return bad_request(f'Name is required (up to {MAX_NAME_LEN} characters)')
        source, err = _clean_source(body.get('source'))
        if err:
            return bad_request(err)
        if IndicatorDbContext.count_for_user(request.user_id) >= MAX_INDICATORS_PER_USER:
            return bad_request(f'You can keep up to {MAX_INDICATORS_PER_USER} indicators. Delete some first.')
        new_id = IndicatorDbContext.create(request.user_id, name, source)
        return created_response(data=IndicatorDbContext.get(request.user_id, new_id), message='Indicator saved')
    except Exception as e:
        return handle_error(e)


@indicator_bp.route('/<int:indicator_id>', methods=['PUT'])
@token_required
def update_indicator(indicator_id: int):
    try:
        body = request.get_json(silent=True) or {}
        name = source = None
        if 'name' in body:
            name = _clean_name(body.get('name'))
            if name is None:
                return bad_request(f'Name is required (up to {MAX_NAME_LEN} characters)')
        if 'source' in body:
            source, err = _clean_source(body.get('source'))
            if err:
                return bad_request(err)
        if name is None and source is None:
            return bad_request('Nothing to update')
        if not IndicatorDbContext.update(request.user_id, indicator_id, name, source):
            return not_found('Indicator not found')
        return success_response(data=IndicatorDbContext.get(request.user_id, indicator_id), message='Indicator saved')
    except Exception as e:
        return handle_error(e)


@indicator_bp.route('/<int:indicator_id>', methods=['DELETE'])
@token_required
def delete_indicator(indicator_id: int):
    try:
        if not IndicatorDbContext.delete(request.user_id, indicator_id):
            return not_found('Indicator not found')
        return success_response(message='Indicator deleted')
    except Exception as e:
        return handle_error(e)
