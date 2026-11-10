"""HTTP surface for cost basis, realized gains and tax exports.

Like the transfers API, reads never touch an exchange: gains are replayed from
the stored ``trade_history`` and ``transfer_history`` on every request, so the
numbers always reflect exactly what has been synced. Only ``POST /sync`` calls
an exchange, one bounded slice at a time (see ``helper/TradeSync.py``).

Nothing here is tax advice, and the page says so. The engine's job is to be
transparent about what it knows and loud about what it doesn't.
"""

import base64
import time
from datetime import datetime, timezone

from flask import Blueprint, request

from controllers.CostBasisDbContext import CostBasisDbContext
from controllers.ExchangeConnectionDbContext import ExchangeConnectionDbContext
from controllers.TradeDbContext import TradeDbContext
from controllers.TransferDbContext import TransferDbContext
from helper.CostBasis import METHODS, compute, project_sells, summarize
from helper.ErrorHandler import handle_error, bad_request, not_found
from helper.ExchangeRegistry import (SUPPORTED_EXCHANGES, get_connection_row,
                                     supports_trade_history)
from helper.Helper import success_response
from helper.Security import token_required, active_required
from helper.Spreadsheet import write_csv

tax_bp = Blueprint('tax', __name__)

#: Disposals returned to the page per request. The export always has them all.
MAX_DISPOSALS_IN_RESPONSE = 1000

#: Ceiling on hypothetical sells in one projection request.
MAX_PROJECTED_SELLS = 2000


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _owned_conn_id(user_id: int, raw):
    """``(conn_id, error_response)``; blank/``all`` means every connection.

    Ownership is re-checked rather than trusted from the request body.
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


def _method(raw) -> str | None:
    method = str(raw or 'fifo').strip().lower()
    return method if method in METHODS else None


def _year_bounds(year: int) -> tuple[int, int]:
    """``[start, end)`` of a calendar year in UTC epoch seconds."""
    start = int(datetime(year, 1, 1, tzinfo=timezone.utc).timestamp())
    end = int(datetime(year + 1, 1, 1, tzinfo=timezone.utc).timestamp())
    return start, end


def _year_of(ts: int) -> int:
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).year


def _exchange_display(name: str) -> str:
    return SUPPORTED_EXCHANGES.get(name, {}).get('name', name or '').replace(' (Beta)', '')


def _connection_names(user_id: int) -> dict[int, str]:
    """``{conn_id: "Kraken (Main)"}`` for labelling rows."""
    out = {}
    for c in ExchangeConnectionDbContext.get_connections_by_user(user_id) or []:
        name = _exchange_display(c.get('exchange_name'))
        out[int(c['id'])] = f"{name} ({c['label']})" if c.get('label') else name
    return out


def _replay(user_id: int, method: str) -> tuple[dict, list[dict], list[dict]]:
    trades = TradeDbContext.get_trades(user_id)
    transfers = TransferDbContext.list_for_cost_basis(user_id)
    overrides = {o['transfer_id']: o for o in CostBasisDbContext.list_deposit_overrides(user_id)}
    result = compute(trades, transfers, method,
                     manual_lots=CostBasisDbContext.list_lots(user_id),
                     deposit_overrides=overrides)
    return result, trades, transfers


def _round(value, places: int = 2):
    return None if value is None else round(float(value), places)


def _fix_for(d: dict, transfers_by_id: dict, trades_by_id: dict) -> dict | None:
    """What the user can enter to resolve this row, with what the form needs.

    ``unpriced`` wins over a missing basis: without the sale's USD value no
    cost would produce a gain anyway, and the price is usually the quicker fix.
    """
    if d['unpriced'] and d.get('trade_id') in trades_by_id:
        t = trades_by_id[d['trade_id']]
        return {'kind': 'price', 'trade_id': t['id'], 'symbol': t['symbol'],
                'quote': t['quote'], 'side': t['side'], 'amount': t['amount_num'],
                'price': t['price_num'], 'occurred_at': t['occurred_at']}
    if not d['missing_basis']:
        return None
    ref = d.get('basis_ref') or {}
    if ref.get('type') == 'deposit' and ref.get('id') in transfers_by_id:
        dep = transfers_by_id[ref['id']]
        return {'kind': 'deposit', 'transfer_id': dep['id'], 'asset': dep['asset'],
                'amount': dep['amount_num'], 'occurred_at': dep['occurred_at'],
                'connection_id': dep['exchange_connection_id']}
    return {'kind': 'lot', 'asset': d['asset'], 'amount': d['amount'],
            'connection_id': d['connection_id'], 'before': d['sold_at']}


def _public_disposal(d: dict, names: dict[int, str], fix: dict | None = None) -> dict:
    return {
        'fix': fix,
        'trade_id': d.get('trade_id'),
        'asset': d['asset'],
        'amount': d['amount'],
        'acquired_at': d['acquired_at'],
        'sold_at': d['sold_at'],
        'proceeds_usd': _round(d['proceeds_usd']),
        'cost_usd': _round(d['cost_usd']),
        'gain_usd': _round(d['gain_usd']),
        'term': d['term'],
        'missing_basis': d['missing_basis'],
        'unpriced': d['unpriced'],
        'basis_source': d['basis_source'],
        'kind': d['kind'],
        'pair': d.get('pair'),
        'connection_id': d['connection_id'],
        'connection': names.get(d['connection_id'], _exchange_display(d['exchange_name'])),
    }


# ---------------------------------------------------------------------------
# Sync status
# ---------------------------------------------------------------------------

def _trade_state(rows: list[dict], exchange_name: str, now: int) -> dict:
    """Render the trade sync for one connection, from its state rows."""
    if not supports_trade_history(exchange_name):
        return {'state': 'unsupported'}
    meta = next((r for r in rows if r.get('scope') == '*'), None)
    if not meta or meta.get('synced_through') is None:
        return {'state': 'not_started'}
    if meta.get('disabled'):
        return {'state': 'disabled', 'disabled_reason': meta.get('disabled_reason')}

    complete = bool(meta.get('backfill_complete'))
    last_ok = meta.get('last_sync_ok_at')
    # Binance markets the account isn't allowed to read are disabled one by
    # one; surfacing the count keeps a partial history from looking complete.
    skipped = sum(1 for r in rows if r.get('scope') not in (None, '*') and r.get('disabled'))
    return {
        'state': 'idle' if complete else ('error' if meta.get('last_error') else 'backfilling'),
        'backfill_complete': complete,
        'synced_through': meta.get('synced_through'),
        'last_sync_ok_at': last_ok,
        'age_seconds': (now - int(last_ok)) if last_ok else None,
        'last_error': meta.get('last_error'),
        'skipped_markets': skipped,
    }


def _build_status(user_id: int) -> dict:
    now = int(time.time())
    counts = TradeDbContext.count_by_connection(user_id)
    by_conn: dict[int, dict] = {}
    for row in TradeDbContext.get_sync_states_by_user(user_id):
        conn_id = int(row['exchange_connection_id'])
        entry = by_conn.setdefault(conn_id, {
            'connection_id': conn_id,
            'exchange': row['exchange_name'],
            'label': row.get('label'),
            '_rows': [],
        })
        if row.get('scope'):
            entry['_rows'].append(row)

    connections, any_pending = [], False
    for entry in by_conn.values():
        rows = entry.pop('_rows')
        entry['trades'] = _trade_state(rows, entry['exchange'], now)
        entry['trade_count'] = counts.get(entry['connection_id'], 0)
        if entry['trades']['state'] in ('not_started', 'backfilling'):
            any_pending = True
        connections.append(entry)
    return {'connections': connections, 'any_pending': any_pending}


@tax_bp.route('/status', methods=['GET'])
@token_required
@active_required
def status():
    try:
        return success_response(data=_build_status(request.user_id))
    except Exception as e:
        return handle_error(e)


@tax_bp.route('/sync', methods=['POST'])
@token_required
@active_required
def run_sync():
    """One bounded slice of trade sync. ``complete: false`` means "call again"."""
    try:
        from helper.TradeSync import sync_connection

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
                if supports_trade_history(c['exchange_name'])
            ]

        complete, new_rows, already_running, errors = True, 0, False, []
        for target in targets:
            result = sync_connection(user_id, target)
            new_rows += result.get('new_rows', 0)
            already_running = already_running or bool(result.get('already_running'))
            if not result.get('complete', True):
                complete = False
            if result.get('error'):
                errors.append(result['error'])

        return success_response(data={
            'complete': complete,
            'new_rows': new_rows,
            'already_running': already_running,
            'errors': errors,
            'sync': _build_status(user_id),
        })
    except Exception as e:
        return handle_error(e)


# ---------------------------------------------------------------------------
# Gains
# ---------------------------------------------------------------------------

@tax_bp.route('/gains', methods=['GET'])
@token_required
@active_required
def gains():
    try:
        user_id = request.user_id
        method = _method(request.args.get('method'))
        if not method:
            return bad_request(f"method must be one of {', '.join(METHODS)}")

        result, trades, transfers = _replay(user_id, method)
        disposals = result['disposals']
        current_year = datetime.now(timezone.utc).year
        needs_info_only = str(request.args.get('needs_info') or '').lower() in ('1', 'true', 'yes')
        years = sorted({_year_of(d['sold_at']) for d in disposals} | {current_year},
                       reverse=True)

        try:
            year = int(request.args.get('year') or years[0])
        except (TypeError, ValueError):
            return bad_request('year must be an integer')

        start, end = _year_bounds(year)
        in_year = [d for d in disposals if start <= d['sold_at'] < end]
        in_year.sort(key=lambda d: d['sold_at'], reverse=True)
        names = _connection_names(user_id)
        transfers_by_id = {t['id']: t for t in transfers}
        trades_by_id = {t['id']: t for t in trades}

        # The summary always covers the whole year; the filter only narrows
        # the table, so fixing rows one by one shows the totals move.
        shown = [d for d in in_year if d['missing_basis'] or d['unpriced']] \
            if needs_info_only else in_year
        needs_info = sum(1 for d in in_year if d['missing_basis'] or d['unpriced'])

        return success_response(data={
            'method': method,
            'year': year,
            'years': years,
            'summary': {k: (_round(v) if isinstance(v, float) else v)
                        for k, v in summarize(in_year).items()},
            'disposals': [_public_disposal(d, names, _fix_for(d, transfers_by_id, trades_by_id))
                          for d in shown[:MAX_DISPOSALS_IN_RESPONSE]],
            'disposals_total': len(shown),
            'needs_info': needs_info,
            'needs_info_only': needs_info_only,
            'warnings': result['warnings'],
            'trade_count': len(trades),
            'sync': _build_status(user_id),
        })
    except Exception as e:
        return handle_error(e)


@tax_bp.route('/project-sells', methods=['POST'])
@token_required
@active_required
def project():
    """What a set of hypothetical sells would realize against today's lots.

    Used by the Limit Orders export for its "gain if filled" column. The client
    sends USD prices already converted (only dollar-quoted orders qualify).
    """
    try:
        body = request.get_json(silent=True) or {}
        method = _method(body.get('method'))
        if not method:
            return bad_request(f"method must be one of {', '.join(METHODS)}")
        sells = body.get('sells') or []
        if not isinstance(sells, list):
            return bad_request('sells must be a list')
        if len(sells) > MAX_PROJECTED_SELLS:
            return bad_request(f'At most {MAX_PROJECTED_SELLS} sells per request')

        result, trades, _ = _replay(request.user_id, method)
        projected = project_sells(result['open_lots'], sells, method)
        return success_response(data={
            'method': method,
            'results': {k: {f: (_round(v) if isinstance(v, float) and f.endswith('usd') else v)
                            for f, v in r.items()}
                        for k, r in projected.items()},
            'has_history': bool(trades),
        })
    except Exception as e:
        return handle_error(e)


# ---------------------------------------------------------------------------
# Manual cost basis — the user's answers for what the history can't supply
# ---------------------------------------------------------------------------

#: Bitcoin's genesis block. A purchase date before it is a typo, not a trade.
_EARLIEST_ACQUISITION = 1231006505


def _number(value, name: str, allow_zero: bool = True) -> tuple[float | None, object]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None, bad_request(f'{name} must be a number')
    if number != number or number in (float('inf'), float('-inf')):
        return None, bad_request(f'{name} must be a number')
    if number < 0 or (number == 0 and not allow_zero):
        return None, bad_request(f'{name} must be {"zero or more" if allow_zero else "more than zero"}')
    return number, None


def _timestamp(value, name: str, latest: int,
               too_late: str | None = None) -> tuple[int | None, object]:
    try:
        ts = int(value)
    except (TypeError, ValueError):
        return None, bad_request(f'{name} must be a date')
    if ts < _EARLIEST_ACQUISITION:
        return None, bad_request(f'{name} is before Bitcoin existed. Check the date.')
    if ts > latest:
        return None, bad_request(too_late or f'{name} can\'t be in the future.')
    return ts, None


def _note(value) -> str | None:
    text = str(value or '').strip()
    return text[:200] or None


@tax_bp.route('/manual', methods=['GET'])
@token_required
@active_required
def list_manual():
    """Every hand-entered figure, so they can be reviewed and undone."""
    try:
        user_id = request.user_id
        names = _connection_names(user_id)

        def label(conn_id):
            return names.get(int(conn_id), '') if conn_id is not None else ''

        lots = CostBasisDbContext.list_lots(user_id)
        deposits = CostBasisDbContext.list_deposit_overrides(user_id)
        prices = CostBasisDbContext.list_manual_prices(user_id)
        for row in lots + deposits + prices:
            row['connection'] = label(row.get('exchange_connection_id'))
        return success_response(data={'lots': lots, 'deposits': deposits, 'prices': prices})
    except Exception as e:
        return handle_error(e)


@tax_bp.route('/manual/lots', methods=['POST'])
@token_required
@active_required
def add_manual_lot():
    """A purchase Cyrus has no record of. Fixes "sold beyond history"."""
    try:
        user_id = request.user_id
        body = request.get_json(silent=True) or {}
        conn_id, err = _owned_conn_id(user_id, body.get('connection_id'))
        if err:
            return err
        if conn_id is None:
            return bad_request('Choose the exchange the coins were held on')

        asset = str(body.get('asset') or '').strip().upper()
        if not asset or len(asset) > 20 or not asset.replace('.', '').isalnum():
            return bad_request('asset must be a ticker such as BTC')
        amount, err = _number(body.get('amount'), 'amount', allow_zero=False)
        if err:
            return err
        cost, err = _number(body.get('total_cost_usd'), 'total cost')
        if err:
            return err
        acquired_at, err = _timestamp(body.get('acquired_at'), 'Purchase date', int(time.time()))
        if err:
            return err

        lot_id = CostBasisDbContext.add_lot(user_id, conn_id, asset, amount, cost,
                                            acquired_at, _note(body.get('note')))
        return success_response(data={'id': lot_id}, message='Purchase added')
    except Exception as e:
        return handle_error(e)


@tax_bp.route('/manual/lots/<int:lot_id>', methods=['DELETE'])
@token_required
@active_required
def delete_manual_lot(lot_id: int):
    try:
        if not CostBasisDbContext.delete_lot(request.user_id, lot_id):
            return not_found('Manual purchase not found')
        return success_response(message='Purchase removed')
    except Exception as e:
        return handle_error(e)


@tax_bp.route('/manual/deposits/<int:transfer_id>', methods=['PUT'])
@token_required
@active_required
def set_deposit_cost(transfer_id: int):
    """The original cost and purchase date of coins deposited from outside."""
    try:
        user_id = request.user_id
        deposit = CostBasisDbContext.get_deposit(user_id, transfer_id)
        if not deposit:
            return not_found('Deposit not found')
        if deposit['kind'] != 'deposit':
            return bad_request('Only a deposit can be given an original cost')

        body = request.get_json(silent=True) or {}
        cost, err = _number(body.get('total_cost_usd'), 'total cost')
        if err:
            return err
        # Bought no later than it arrived: a purchase date after the deposit
        # would mean the coins were spent before they existed.
        arrived = int(deposit['occurred_at'] or time.time())
        acquired_at, err = _timestamp(
            body.get('acquired_at'), 'Purchase date', arrived,
            too_late=(f"The purchase date must be on or before the day the deposit "
                      f"arrived ({_us_date(arrived)})."))
        if err:
            return err

        CostBasisDbContext.set_deposit_override(user_id, transfer_id, cost, acquired_at,
                                                _note(body.get('note')))
        return success_response(message='Deposit cost saved')
    except Exception as e:
        return handle_error(e)


@tax_bp.route('/manual/deposits/<int:transfer_id>', methods=['DELETE'])
@token_required
@active_required
def delete_deposit_cost(transfer_id: int):
    try:
        if not CostBasisDbContext.delete_deposit_override(request.user_id, transfer_id):
            return not_found('No saved cost for that deposit')
        return success_response(message='Deposit cost removed')
    except Exception as e:
        return handle_error(e)


@tax_bp.route('/manual/trades/<int:trade_id>/price', methods=['PUT'])
@token_required
@active_required
def set_trade_price(trade_id: int):
    """USD value of one unit of a fill's quote asset (e.g. BTC on an ETH/BTC sale)."""
    try:
        user_id = request.user_id
        trade = CostBasisDbContext.get_trade(user_id, trade_id)
        if not trade:
            return not_found('Trade not found')
        body = request.get_json(silent=True) or {}
        price, err = _number(body.get('quote_usd_price'), 'USD price', allow_zero=False)
        if err:
            return err
        CostBasisDbContext.set_manual_price(user_id, trade_id, price)
        return success_response(message='Price saved')
    except Exception as e:
        return handle_error(e)


@tax_bp.route('/manual/trades/<int:trade_id>/price', methods=['DELETE'])
@token_required
@active_required
def delete_trade_price(trade_id: int):
    try:
        if not CostBasisDbContext.clear_manual_price(request.user_id, trade_id):
            return not_found('No manual price on that trade')
        return success_response(message='Price removed')
    except Exception as e:
        return handle_error(e)


# ---------------------------------------------------------------------------
# Exports
# ---------------------------------------------------------------------------

def _us_date(ts) -> str:
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime('%m/%d/%Y') if ts else ''


def _koinly_date(ts) -> str:
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime('%Y-%m-%d %H:%M UTC')


def _amount_text(value) -> str:
    """An amount without float noise or exponent notation."""
    text = f"{float(value or 0):.10f}".rstrip('0').rstrip('.')
    return text or '0'


def _form_8949(disposals: list[dict], names: dict[int, str]) -> tuple[list, list]:
    headers = ['Description of Property', 'Date Acquired', 'Date Sold or Disposed',
               'Proceeds (USD)', 'Cost or Other Basis (USD)', 'Gain or (Loss) (USD)',
               'Term', 'Exchange', 'Notes']
    rows = []
    for d in sorted(disposals, key=lambda x: (x['sold_at'], x['asset'])):
        notes = []
        if d['missing_basis']:
            notes.append('Missing cost basis - no purchase history in Cyrus'
                         if d['basis_source'] == 'no_history'
                         else 'Missing cost basis - arrived by deposit from outside Cyrus')
        if d['basis_source'] in ('manual', 'manual_deposit'):
            notes.append('Cost basis entered manually')
        if d['unpriced']:
            notes.append('Proceeds could not be valued in USD')
        if d['kind'] == 'fee':
            notes.append('Fee paid in this asset')
        rows.append([
            f"{_amount_text(d['amount'])} {d['asset']}",
            _us_date(d['acquired_at']) if d['acquired_at'] else '',
            _us_date(d['sold_at']),
            _round(d['proceeds_usd']),
            _round(d['cost_usd']),
            _round(d['gain_usd']),
            {'long': 'Long-term', 'short': 'Short-term'}.get(d['term'] or '', ''),
            names.get(d['connection_id'], _exchange_display(d['exchange_name'])),
            '; '.join(notes),
        ])
    return headers, rows


def _koinly(trades: list[dict], transfers: list[dict], names: dict[int, str]) -> tuple[list, list]:
    """Koinly's "universal" import format, one row per fill or transfer.

    The whole file is imported as ONE Koinly wallet, so a transfer matched
    between two of the user's own connections would appear as a withdrawal and
    a deposit inside the same wallet — noise at best, a phantom disposal at
    worst. Those pairs are left out; every other leg goes in.
    """
    headers = ['Date', 'Sent Amount', 'Sent Currency', 'Received Amount',
               'Received Currency', 'Fee Amount', 'Fee Currency',
               'Net Worth Amount', 'Net Worth Currency', 'Label', 'Description',
               'TxHash']
    events = []
    for t in trades:
        quote_usd = t.get('quote_usd_price')
        worth = _round(t['cost_num'] * quote_usd) if quote_usd else None
        if t['side'] == 'buy':
            sent = (_amount_text(t['cost_num']), t['quote'])
            got = (_amount_text(t['amount_num']), t['base'])
        else:
            sent = (_amount_text(t['amount_num']), t['base'])
            got = (_amount_text(t['cost_num']), t['quote'])
        conn = names.get(int(t['exchange_connection_id']), _exchange_display(t['exchange_name']))
        events.append((t['occurred_at'], [
            _koinly_date(t['occurred_at']), sent[0], sent[1], got[0], got[1],
            _amount_text(t['fee_amount_num']) if t.get('fee_amount_num') else '',
            t.get('fee_currency') or '',
            worth if worth is not None else '', 'USD' if worth is not None else '',
            '', f"{conn} {t['side']} {t['symbol']} (trade {t.get('external_id') or t['id']})", '',
        ]))

    by_id = {t['id']: t for t in transfers}
    for t in transfers:
        if str(t.get('status') or '').lower() in ('failed', 'canceled', 'cancelled', 'rejected'):
            continue
        partner = by_id.get(t.get('internal_match_id'))
        if partner and t.get('match_source') in ('txid', 'heuristic', 'user'):
            continue
        if t.get('is_internal') == 1 and not partner:
            continue
        conn = names.get(int(t['exchange_connection_id']), _exchange_display(t['exchange_name']))
        amount = _amount_text(t['amount_num'])
        deposit = t['kind'] == 'deposit'
        events.append((t['occurred_at'], [
            _koinly_date(t['occurred_at']),
            '' if deposit else amount, '' if deposit else t['asset'],
            amount if deposit else '', t['asset'] if deposit else '',
            t.get('fee_amount') or '', t.get('fee_currency') or '',
            '', '', '', f"{conn} {t['kind']}", t.get('txid') or '',
        ]))

    events.sort(key=lambda e: e[0] or 0)
    return headers, [row for _, row in events]


@tax_bp.route('/export', methods=['GET'])
@token_required
@active_required
def export():
    """``{filename, content_base64, rows}`` — the same envelope as the wallet export."""
    try:
        user_id = request.user_id
        fmt = (request.args.get('format') or '8949').strip().lower()
        if fmt not in ('8949', 'koinly'):
            return bad_request("format must be '8949' or 'koinly'")
        method = _method(request.args.get('method'))
        if not method:
            return bad_request(f"method must be one of {', '.join(METHODS)}")

        names = _connection_names(user_id)
        result, trades, transfers = _replay(user_id, method)
        stamp = datetime.now(timezone.utc).strftime('%Y-%m-%d')

        if fmt == 'koinly':
            # Koinly computes its own gains, so it gets the full history, not a year.
            headers, rows = _koinly(trades, transfers, names)
            filename = f"cyrus-koinly-{stamp}.csv"
        else:
            try:
                year = int(request.args.get('year') or datetime.now(timezone.utc).year)
            except (TypeError, ValueError):
                return bad_request('year must be an integer')
            start, end = _year_bounds(year)
            in_year = [d for d in result['disposals'] if start <= d['sold_at'] < end]
            headers, rows = _form_8949(in_year, names)
            filename = f"cyrus-form8949-{year}-{method}.csv"

        if not rows:
            return bad_request('There is nothing to export yet. Sync your trade '
                               'history first, or pick a year with sales in it.')

        content = write_csv(headers, rows)
        return success_response(data={
            'filename': filename,
            'content_base64': base64.b64encode(content).decode('ascii'),
            'bytes': len(content),
            'rows': len(rows),
        })
    except Exception as e:
        return handle_error(e)
