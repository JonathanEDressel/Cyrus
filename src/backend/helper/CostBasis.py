"""Cost-basis lots and realized gains, replayed from stored history.

Pure: no database, no exchange, no clock. It takes the rows the sync stored
(``trade_history`` and ``transfer_history``) and returns disposals, the lots
still open, and warnings. That keeps it testable in isolation and means the
same engine answers both "what did I realize this year" (the Taxes page) and
"what would I realize if these orders filled" (the Limit Orders export).

Ground rules, chosen to be honest rather than clever:

* **Lots are tracked per connection.** US rules have required per-account
  tracking since 2025, and it is also simply what happened: a coin bought on
  Kraken is not available to sell on Binance until it is moved. A matched
  internal transfer carries the lots across with their original dates and
  cost, so moving coins is never a taxable event here.
* **Dollars and dollar stablecoins are cash**, not lots — the same set the
  Limit Orders page treats as dollar-priced. Other fiat (EUR, GBP, ...) is
  also treated as cash; selling a coin for EUR still realizes a gain, valued
  in USD at the time.
* **Unknown is never guessed.** A deposit from outside has no known cost, so
  its lot carries ``basis=None`` and anything later sold from it is flagged
  ``missing_basis`` rather than given a cost of zero (which would overstate
  the gain) or of the sale price (which would hide it). Selling more than the
  history accounts for is flagged the same way.
"""

from __future__ import annotations

import copy

#: Treated as cash: no lots, no gains. Mirrors the frontend's DOLLAR_QUOTES
#: plus the other fiat currencies the supported exchanges quote in.
DOLLAR_ASSETS = frozenset({
    'USD', 'ZUSD', 'USDT', 'USDC', 'USDS', 'USDD', 'USDG', 'DAI', 'TUSD',
    'PYUSD', 'FDUSD', 'BUSD', 'RLUSD', 'USDP',
})
OTHER_FIAT = frozenset({'EUR', 'ZEUR', 'GBP', 'ZGBP', 'CAD', 'ZCAD', 'AUD',
                        'JPY', 'ZJPY', 'CHF'})
CASH_ASSETS = DOLLAR_ASSETS | OTHER_FIAT

METHODS = ('fifo', 'hifo')

#: Held for MORE than one year is long-term. 365 days is the conventional
#: reading; a leap-day edge case can be off by one day and is noted as such.
LONG_TERM_SECONDS = 365 * 86400

#: Below this an amount is float dust from repeated subtraction, not a holding.
_DUST = 1e-12

#: Match sources that mean "these two legs are the same movement". 'wallet' is
#: excluded on purpose: it links a leg to a labelled wallet, not to another
#: connection, so there is no destination lot pile to carry anything into.
_CONFIRMED_MATCH = frozenset({'txid', 'heuristic', 'user'})

#: Transfer statuses that never moved funds.
_DEAD_STATUSES = frozenset({'failed', 'canceled', 'cancelled', 'rejected'})


def is_cash(asset: str | None) -> bool:
    return str(asset or '').upper() in CASH_ASSETS


# ---------------------------------------------------------------------------
# Lots
# ---------------------------------------------------------------------------

class _Book:
    """Open lots per ``(connection_id, asset)``.

    A lot is a plain dict — ``amount``, ``unit_cost`` (USD per unit, or None
    when unknown), ``acquired_at`` (epoch seconds) and ``source`` — so a copy
    for a what-if projection is just ``copy.deepcopy``.
    """

    def __init__(self):
        self.lots: dict[tuple[int, str], list[dict]] = {}

    def add(self, conn_id: int, asset: str, amount: float, total_cost: float | None,
            acquired_at: int, source: str, ref: dict | None = None) -> None:
        """*ref* names the record the lot came from (``{'type': 'deposit',
        'id': 12}``), so a disposal with an unknown cost can point the user at
        exactly what to fill in."""
        if amount <= _DUST or is_cash(asset):
            return
        unit = None if total_cost is None else total_cost / amount
        self.lots.setdefault((conn_id, asset), []).append({
            'amount': amount, 'unit_cost': unit,
            'acquired_at': int(acquired_at or 0), 'source': source, 'ref': ref,
        })

    def add_lot(self, conn_id: int, asset: str, lot: dict) -> None:
        if lot['amount'] > _DUST:
            self.lots.setdefault((conn_id, asset), []).append(lot)

    def take(self, conn_id: int, asset: str, amount: float,
             method: str) -> tuple[list[dict], float]:
        """Remove *amount* using *method*'s lot order.

        Returns ``(pieces, shortfall)``: the lot slices consumed (each a lot
        dict with its own ``amount``) and how much could not be covered by any
        lot at all.
        """
        pile = self.lots.get((conn_id, asset)) or []
        if method == 'hifo':
            # Highest known cost first; unknown-cost lots last, so a known
            # expensive lot is never skipped in favour of a guess.
            order = sorted(pile, key=lambda l: (l['unit_cost'] is None,
                                                -(l['unit_cost'] or 0.0),
                                                l['acquired_at']))
        else:
            order = sorted(pile, key=lambda l: l['acquired_at'])

        pieces: list[dict] = []
        remaining = amount
        for lot in order:
            if remaining <= _DUST:
                break
            used = min(lot['amount'], remaining)
            piece = dict(lot)
            piece['amount'] = used
            pieces.append(piece)
            lot['amount'] -= used
            remaining -= used

        self.lots[(conn_id, asset)] = [l for l in pile if l['amount'] > _DUST]
        return pieces, max(remaining, 0.0) if remaining > _DUST else 0.0

    def snapshot(self) -> list[dict]:
        out = []
        for (conn_id, asset), pile in self.lots.items():
            for lot in pile:
                if lot['amount'] > _DUST:
                    out.append({'connection_id': conn_id, 'asset': asset, **lot})
        return out


# ---------------------------------------------------------------------------
# Valuation
# ---------------------------------------------------------------------------

def _quote_usd(trade: dict) -> float | None:
    if str(trade.get('quote') or '').upper() in DOLLAR_ASSETS:
        return 1.0
    value = trade.get('quote_usd_price')
    return float(value) if value else None


def _fee_usd(trade: dict, quote_usd: float | None) -> float:
    """USD value of the fill's fee; 0 when there is none or it can't be valued."""
    fee = float(trade.get('fee_amount_num') or 0.0)
    if fee <= 0:
        return 0.0
    if trade.get('fee_usd_value') is not None:
        return float(trade['fee_usd_value'])
    currency = str(trade.get('fee_currency') or '').upper()
    if currency in DOLLAR_ASSETS:
        return fee
    if quote_usd is None:
        return 0.0
    if currency == str(trade.get('quote') or '').upper():
        return fee * quote_usd
    if currency == str(trade.get('base') or '').upper():
        return fee * float(trade.get('price_num') or 0.0) * quote_usd
    return 0.0


# ---------------------------------------------------------------------------
# Replay
# ---------------------------------------------------------------------------

class _Ledger:
    def __init__(self, method: str):
        if method not in METHODS:
            raise ValueError(f"method must be one of {METHODS}")
        self.method = method
        self.book = _Book()
        self.disposals: list[dict] = []
        self.unknown_deposits: dict[str, float] = {}
        self.shortfalls: dict[str, float] = {}
        self.unpriced_fills = 0

    def dispose(self, conn_id: int, exchange_name: str, asset: str, amount: float,
                proceeds: float | None, sold_at: int, kind: str, ref: dict) -> None:
        """Book a disposal of *amount* of *asset*, split across the lots consumed."""
        if amount <= _DUST or is_cash(asset):
            return
        pieces, shortfall = self.book.take(conn_id, asset, amount, self.method)
        if shortfall > _DUST:
            self.shortfalls[asset] = self.shortfalls.get(asset, 0.0) + shortfall
            pieces.append({'amount': shortfall, 'unit_cost': None,
                           'acquired_at': None, 'source': 'no_history', 'ref': None})

        for piece in pieces:
            share = piece['amount'] / amount
            piece_proceeds = None if proceeds is None else proceeds * share
            cost = None if piece['unit_cost'] is None else piece['unit_cost'] * piece['amount']
            acquired = piece['acquired_at']
            term = None
            if acquired:
                term = 'long' if sold_at - acquired > LONG_TERM_SECONDS else 'short'
            gain = None
            if cost is not None and piece_proceeds is not None:
                gain = piece_proceeds - cost
            self.disposals.append({
                'asset': asset,
                'amount': piece['amount'],
                'acquired_at': acquired,
                'sold_at': int(sold_at),
                'proceeds_usd': piece_proceeds,
                'cost_usd': cost,
                'gain_usd': gain,
                'term': term,
                'missing_basis': cost is None,
                'unpriced': proceeds is None,
                'basis_source': piece['source'],
                'basis_ref': piece.get('ref'),
                'connection_id': conn_id,
                'exchange_name': exchange_name,
                'kind': kind,
                **ref,
            })

    def trade(self, t: dict) -> None:
        conn_id = int(t['exchange_connection_id'])
        exchange_name = t.get('exchange_name') or ''
        base = str(t['base']).upper()
        quote = str(t['quote']).upper()
        side = t['side']
        amount = float(t.get('amount_num') or 0.0)
        cost = float(t.get('cost_num') or 0.0)
        when = int(t.get('occurred_at') or 0)
        fee = float(t.get('fee_amount_num') or 0.0)
        fee_ccy = str(t.get('fee_currency') or '').upper()

        quote_usd = _quote_usd(t)
        if quote_usd is None:
            self.unpriced_fills += 1
        value = None if quote_usd is None else cost * quote_usd
        fee_usd = _fee_usd(t, quote_usd)
        ref = {'trade_id': t.get('id'), 'pair': f"{base}/{quote}"}

        # A fee charged in some third asset (BNB on Binance) is itself a small
        # disposal of that asset, worth fee_usd.
        if fee > 0 and fee_ccy and fee_ccy not in (base, quote):
            self.dispose(conn_id, exchange_name, fee_ccy, fee, fee_usd, when, 'fee', ref)

        if side == 'buy':
            received = amount - fee if fee_ccy == base else amount
            basis = None if value is None else value + (0.0 if fee_ccy == base else fee_usd)
            given = cost + (fee if fee_ccy == quote else 0.0)
            # Paying with crypto disposes of it at what was received for it.
            self.dispose(conn_id, exchange_name, quote, given,
                         None if value is None else value + (fee_usd if fee_ccy == quote else 0.0),
                         when, 'trade', ref)
            self.book.add(conn_id, base, received, basis, when, 'trade',
                          {'type': 'trade', 'id': t.get('id')})
        else:
            # A fee taken in the base asset means those coins left too, with
            # nothing received for them: more disposed, same proceeds. Any
            # other fee is a selling expense and comes off the proceeds.
            given = amount + (fee if fee_ccy == base else 0.0)
            proceeds = None if value is None else value - (0.0 if fee_ccy == base else fee_usd)
            self.dispose(conn_id, exchange_name, base, given, proceeds, when, 'trade', ref)
            received_quote = cost - (fee if fee_ccy == quote else 0.0)
            self.book.add(conn_id, quote, received_quote,
                          None if quote_usd is None else received_quote * quote_usd,
                          when, 'trade', {'type': 'trade', 'id': t.get('id')})

    def move(self, out_leg: dict, in_leg: dict) -> None:
        """Carry lots from one connection to another, dates and cost intact.

        The amount that arrives is usually a little less than the amount that
        left (the network fee). Its cost is folded into the lots that arrive,
        so the fee raises their basis rather than vanishing.
        """
        asset = str(out_leg['asset']).upper()
        sent = float(out_leg.get('amount_num') or 0.0)
        got = float(in_leg.get('amount_num') or 0.0) or sent
        pieces, shortfall = self.book.take(int(out_leg['exchange_connection_id']),
                                           asset, sent, self.method)
        if shortfall > _DUST:
            pieces.append({'amount': shortfall, 'unit_cost': None,
                           'acquired_at': int(out_leg.get('occurred_at') or 0),
                           'source': 'no_history', 'ref': None})
        scale = got / sent if sent > 0 else 1.0
        dest = int(in_leg['exchange_connection_id'])
        for piece in pieces:
            moved = dict(piece)
            moved['amount'] = piece['amount'] * scale
            if piece['unit_cost'] is not None and scale > 0:
                moved['unit_cost'] = piece['unit_cost'] / scale
            if piece['source'] == 'no_history':
                self.unknown_deposits[asset] = self.unknown_deposits.get(asset, 0.0) + moved['amount']
            self.book.add_lot(dest, asset, moved)


def _is_live(transfer: dict) -> bool:
    return str(transfer.get('status') or '').lower() not in _DEAD_STATUSES


def compute(trades: list[dict], transfers: list[dict], method: str = 'fifo',
            as_of: int | None = None, manual_lots: list[dict] | None = None,
            deposit_overrides: dict | None = None) -> dict:
    """Replay history and return ``{disposals, open_lots, warnings}``.

    *trades* are ``trade_history`` rows; *transfers* are ``transfer_history``
    rows (with ``internal_match_id`` / ``match_source``). Events after *as_of*
    are ignored, so a past year can be recomputed without later history.

    The user's own answers fill the gaps the history leaves:

    * *manual_lots* (``cost_basis_manual_lots`` rows) are purchases Cyrus never
      saw, added as acquisitions at their own date on their own connection.
    * *deposit_overrides* (``{transfer_id: {total_cost_usd, acquired_at}}``)
      give an outside deposit its original cost and purchase date, so its lot
      is no longer unknown — and is long-term from when it was BOUGHT, not
      from when it happened to arrive.
    """
    ledger = _Ledger(method)
    by_id = {t['id']: t for t in transfers if t.get('id') is not None}
    deposit_overrides = deposit_overrides or {}

    events: list[tuple[int, int, int, str, dict]] = []
    for t in trades:
        events.append((int(t.get('occurred_at') or 0), 1, int(t.get('id') or 0), 'trade', t))
    for lot in manual_lots or []:
        events.append((int(lot.get('acquired_at') or 0), 0, int(lot.get('id') or 0), 'manual', lot))
    for t in transfers:
        if not _is_live(t):
            continue
        # Deposits before trades before withdrawals at the same second, so a
        # coin that arrives and is sold in one tick has a lot to sell from.
        prio = 0 if t['kind'] == 'deposit' else 2
        events.append((int(t.get('occurred_at') or 0), prio, int(t.get('id') or 0), 'transfer', t))
    events.sort(key=lambda e: (e[0], e[1], e[2]))

    handled: set[int] = set()
    for when, _prio, _id, kind, row in events:
        if as_of is not None and when > as_of:
            break
        if kind == 'trade':
            ledger.trade(row)
            continue
        if kind == 'manual':
            ledger.book.add(int(row['exchange_connection_id']), str(row['asset']).upper(),
                            float(row.get('amount') or 0.0), float(row.get('total_cost_usd') or 0.0),
                            when, 'manual', {'type': 'manual_lot', 'id': row.get('id')})
            continue

        if row.get('id') in handled:
            continue
        asset = str(row.get('asset') or '').upper()
        if is_cash(asset):
            continue
        conn_id = int(row['exchange_connection_id'])
        amount = float(row.get('amount_num') or 0.0)

        partner = by_id.get(row.get('internal_match_id')) if row.get('internal_match_id') else None
        paired = (partner is not None
                  and row.get('match_source') in _CONFIRMED_MATCH
                  and partner.get('kind') != row['kind']
                  and _is_live(partner))
        if paired:
            out_leg = row if row['kind'] == 'withdrawal' else partner
            in_leg = partner if row['kind'] == 'withdrawal' else row
            handled.add(out_leg.get('id'))
            handled.add(in_leg.get('id'))
            ledger.move(out_leg, in_leg)
            continue

        if row.get('is_internal') == 1:
            # Known to be between the user's own accounts but with no partner
            # leg on record (Coinbase <-> Coinbase Pro shows up this way, both
            # inside one connection). Nothing changes hands, so nothing to do.
            continue

        if row['kind'] == 'deposit':
            ref = {'type': 'deposit', 'id': row.get('id')}
            override = deposit_overrides.get(row.get('id'))
            if override:
                ledger.book.add(conn_id, asset, amount, float(override['total_cost_usd']),
                                int(override.get('acquired_at') or when), 'manual_deposit', ref)
            else:
                ledger.book.add(conn_id, asset, amount, None, when, 'deposit', ref)
                ledger.unknown_deposits[asset] = ledger.unknown_deposits.get(asset, 0.0) + amount
        else:
            # Coins leaving to somewhere unknown: out of this ledger, but not
            # a sale. Whatever the history can't cover is simply gone.
            ledger.book.take(conn_id, asset, amount, method)

    return {
        'disposals': ledger.disposals,
        'open_lots': ledger.book.snapshot(),
        'warnings': _warnings(ledger),
    }


def _warnings(ledger: _Ledger) -> list[dict]:
    out = []
    for asset, amount in sorted(ledger.unknown_deposits.items()):
        out.append({
            'code': 'unknown_deposit', 'asset': asset, 'amount': amount,
            'message': (f"{_fmt(amount)} {asset} arrived by deposit from outside Cyrus's "
                        f"connected exchanges, so its cost is unknown. Use Fix on its sales "
                        f"to enter what you originally paid."),
        })
    for asset, amount in sorted(ledger.shortfalls.items()):
        out.append({
            'code': 'sold_beyond_history', 'asset': asset, 'amount': amount,
            'message': (f"{_fmt(amount)} more {asset} was sold than Cyrus has purchase "
                        f"history for. Sync every exchange it came from, or use Fix on the "
                        f"sale to add the purchase it came from."),
        })
    if ledger.unpriced_fills:
        out.append({
            'code': 'unpriced_fills', 'count': ledger.unpriced_fills,
            'message': (f"{ledger.unpriced_fills} fill(s) on non-USD pairs couldn't be "
                        f"valued in USD, so their proceeds and cost are left blank. Use "
                        f"Add price on the sale to enter it."),
        })
    return out


def _fmt(amount: float) -> str:
    return f"{amount:,.8f}".rstrip('0').rstrip('.')


# ---------------------------------------------------------------------------
# Reporting helpers
# ---------------------------------------------------------------------------

def summarize(disposals: list[dict]) -> dict:
    """Totals for a set of disposals. Missing-basis rows count toward proceeds
    but not toward cost or gain, and are counted separately so the page can
    say how much of the total is incomplete."""
    out = {'proceeds_usd': 0.0, 'cost_usd': 0.0, 'gain_usd': 0.0,
           'short_term_gain_usd': 0.0, 'long_term_gain_usd': 0.0,
           'disposals': len(disposals), 'missing_basis': 0, 'unpriced': 0}
    for d in disposals:
        if d['proceeds_usd'] is not None:
            out['proceeds_usd'] += d['proceeds_usd']
        else:
            out['unpriced'] += 1
        if d['missing_basis']:
            out['missing_basis'] += 1
            continue
        out['cost_usd'] += d['cost_usd'] or 0.0
        if d['gain_usd'] is not None:
            out['gain_usd'] += d['gain_usd']
            if d['term'] == 'long':
                out['long_term_gain_usd'] += d['gain_usd']
            else:
                out['short_term_gain_usd'] += d['gain_usd']
    return out


def project_sells(open_lots: list[dict], sells: list[dict], method: str = 'fifo') -> dict:
    """What each hypothetical sell would realize, against the lots open now.

    *sells* are ``{key, connection_id, asset, amount, price_usd}``. They are
    consumed in ascending price order — the order a rising market would fill
    a ladder — against ONE shared copy of the lots, so two orders on the same
    coin can never both claim the same cheap lot (which averaging would).

    Returns ``{key: {cost_usd, gain_usd, proceeds_usd, missing_basis,
    known_amount, known_cost_usd, known_gain_usd}}``. ``gain_usd`` is None
    when any part of the order's cost is unknown; the ``known_*`` fields carry
    the part that IS known, for a partial figure.
    """
    if method not in METHODS:
        raise ValueError(f"method must be one of {METHODS}")
    book = _Book()
    for lot in copy.deepcopy(open_lots):
        conn_id, asset = int(lot.pop('connection_id')), str(lot.pop('asset')).upper()
        book.add_lot(conn_id, asset, lot)

    def price_of(s: dict) -> float:
        try:
            return float(s.get('price_usd') or 0.0)
        except (TypeError, ValueError):
            return 0.0

    results: dict = {}
    for sell in sorted(sells, key=price_of):
        key = str(sell.get('key'))
        try:
            amount = float(sell.get('amount') or 0.0)
            conn_id = int(sell.get('connection_id'))
        except (TypeError, ValueError):
            continue
        asset = str(sell.get('asset') or '').upper()
        price = price_of(sell)
        proceeds = amount * price
        pieces, shortfall = book.take(conn_id, asset, amount, method)

        known_amount = sum(p['amount'] for p in pieces if p['unit_cost'] is not None)
        known_cost = sum(p['amount'] * p['unit_cost'] for p in pieces if p['unit_cost'] is not None)
        missing = shortfall > _DUST or any(p['unit_cost'] is None for p in pieces)
        results[key] = {
            'proceeds_usd': proceeds,
            'cost_usd': None if missing else known_cost,
            'gain_usd': None if missing else proceeds - known_cost,
            'missing_basis': missing,
            'known_amount': known_amount,
            'known_cost_usd': known_cost,
            'known_gain_usd': known_amount * price - known_cost,
        }
    return results
