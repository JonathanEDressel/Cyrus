"""Report how much transfer *origin* is actually recoverable from synced data.

Run this after syncing the Transfers page against live keys. It answers the one
question that decides whether a self-transfer matcher is worth building, and how
it should be weighted:

    Of the transfers we stored, how many can be traced to their counterparty?

The tiers it measures, strongest first:

    Tier 1  a withdrawal and a deposit on two different connections sharing one
            on-chain txid. Exact - same transaction, so both ends are yours.
    Tier 2  no shared txid, but an amount/time pairing that looks like the same
            movement. Inferable, needs confirmation.
    Tier 3  a withdrawal to an address you could label as your own. Needs an
            address to exist on the row at all.
    Tier 4  neither. Unresolvable from exchange data - the "was this 10k XLM
            income, or my own coins?" case.

Usage (from src/backend, venv active):

    python transfer_diagnostic.py
    python transfer_diagnostic.py --db "%APPDATA%\\Cyrus\\kraking.db"

Read-only: it opens the database, runs SELECTs, and writes nothing.
"""

import argparse
import os
import sqlite3
import sys
from collections import Counter


# Kept loose on purpose. Two exchanges reporting the same transaction can
# disagree on case and on the 0x prefix, and a matcher that compares raw strings
# would miss every cross-exchange pair for that reason alone. This is the
# normalisation any real matcher would have to apply, so measuring with it is
# the honest measurement.
def normalize_txid(txid: str | None) -> str | None:
    if not txid:
        return None
    value = str(txid).strip().lower()
    if value.startswith('0x'):
        value = value[2:]
    return value or None


def default_db_path() -> str:
    env = os.getenv('DATABASE_PATH')
    if env:
        return env
    local = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'kraking.db')
    if os.path.exists(local):
        return local
    appdata = os.getenv('APPDATA')
    if appdata:
        packaged = os.path.join(appdata, 'Cyrus', 'kraking.db')
        if os.path.exists(packaged):
            return packaged
    return local


def pct(part: int, whole: int) -> str:
    if not whole:
        return '  n/a'
    return f'{(part / whole * 100):5.1f}%'


# ASCII only throughout. The Windows console this ships on defaults to cp1252,
# which cannot encode box-drawing or block characters - a diagnostic that dies
# on its own output would be a poor diagnostic.
def bar(fraction: float, width: int = 24) -> str:
    filled = int(round(max(0.0, min(1.0, fraction)) * width))
    return '#' * filled + '.' * (width - filled)


def section(title: str) -> None:
    print()
    print(title)
    print('-' * max(len(title), 60))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--db', default=None, help='Path to kraking.db')
    args = parser.parse_args()

    db_path = args.db or default_db_path()
    if not os.path.exists(db_path):
        print(f'No database at {db_path}')
        print('Pass --db, or set DATABASE_PATH.')
        return 1

    conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row

    try:
        exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='transfer_history'"
        ).fetchone()
        if not exists:
            print('No transfer_history table - start the backend once to create it.')
            return 1

        rows = conn.execute('''
            SELECT t.id, t.exchange_connection_id, t.exchange_name, t.kind,
                   t.external_id, t.dedupe_key, t.txid, t.network, t.asset,
                   t.amount_num, t.status, t.address, t.tag, t.occurred_at,
                   t.is_internal
            FROM transfer_history t
        ''').fetchall()

        print(f'Database : {db_path}')
        print(f'Rows     : {len(rows)}')
        if not rows:
            print()
            print('Nothing synced yet. Open the Transfers page and let the backfill run,')
            print('then re-run this.')
            return 0

        # ---- coverage per exchange -------------------------------------
        section('COVERAGE BY EXCHANGE')
        print(f'{"exchange":<12} {"rows":>6} {"txid":>7} {"address":>8} {"ext_id":>7} '
              f'{"internal":>9}  {"dedupe fallback":<22}')

        by_exchange: dict[str, list] = {}
        for row in rows:
            by_exchange.setdefault(row['exchange_name'], []).append(row)

        for name, group in sorted(by_exchange.items()):
            total = len(group)
            with_txid = sum(1 for r in group if r['txid'])
            with_addr = sum(1 for r in group if r['address'])
            with_ext = sum(1 for r in group if r['external_id'])
            internal = sum(1 for r in group if r['is_internal'] == 1)
            # Which branch of transfer_dedupe_key produced the key. A high 'syn'
            # count means the exchange gave us neither an id nor a hash, so
            # identity rests on a content hash - the weakest case, and the one
            # most at risk of colliding or re-inserting.
            kinds = Counter(
                'syn' if r['dedupe_key'].startswith('syn:')
                else 'tx' if r['dedupe_key'].startswith('tx:')
                else 'id'
                for r in group
            )
            fallback = ' '.join(f'{k}={kinds[k]}' for k in ('id', 'tx', 'syn') if kinds[k])
            print(f'{name:<12} {total:>6} {pct(with_txid, total):>7} {pct(with_addr, total):>8} '
                  f'{pct(with_ext, total):>7} {pct(internal, total):>9}  {fallback:<22}')

        # ---- tier 1: exact cross-connection txid pairs -----------------
        section('TIER 1 - EXACT (shared txid across two connections)')

        by_txid: dict[str, list] = {}
        for row in rows:
            key = normalize_txid(row['txid'])
            if key:
                by_txid.setdefault(key, []).append(row)

        exact_pairs = []
        for key, group in by_txid.items():
            if len(group) < 2:
                continue
            withdrawals = [r for r in group if r['kind'] == 'withdrawal']
            deposits = [r for r in group if r['kind'] == 'deposit']
            for w in withdrawals:
                for d in deposits:
                    if w['exchange_connection_id'] != d['exchange_connection_id']:
                        exact_pairs.append((w, d))

        matched_rows = {r['id'] for pair in exact_pairs for r in pair}
        print(f'transfers carrying a txid  : {len(by_txid)} distinct hashes')
        print(f'exact withdrawal->deposit  : {len(exact_pairs)} '
              f'{"pair" if len(exact_pairs) == 1 else "pairs"} '
              f'({len(matched_rows)} rows, {pct(len(matched_rows), len(rows))} of all)')
        for w, d in exact_pairs[:10]:
            print(f'    {w["exchange_name"]:>9} -{w["amount_num"]:<14.8g} {w["asset"]:<6}'
                  f' ->  {d["exchange_name"]:<9} +{d["amount_num"]:<14.8g}  {(w["txid"] or "")[:20]}')
        if len(exact_pairs) > 10:
            print(f'    ... and {len(exact_pairs) - 10} more')

        # ---- tier 2: amount/time candidates ----------------------------
        section('TIER 2 - INFERABLE (amount + time, no shared txid)')

        WINDOW_SECONDS = 6 * 3600
        TOLERANCE = 0.02  # fees mean the two legs never match to the cent

        unmatched = [r for r in rows if r['id'] not in matched_rows]
        withdrawals = [r for r in unmatched if r['kind'] == 'withdrawal']
        deposits = [r for r in unmatched if r['kind'] == 'deposit']

        candidates = []
        for w in withdrawals:
            for d in deposits:
                if w['exchange_connection_id'] == d['exchange_connection_id']:
                    continue
                if w['asset'] != d['asset']:
                    continue
                gap = d['occurred_at'] - w['occurred_at']
                if not (0 <= gap <= WINDOW_SECONDS):
                    continue
                if w['amount_num'] <= 0:
                    continue
                drift = abs(w['amount_num'] - d['amount_num']) / w['amount_num']
                if drift <= TOLERANCE:
                    candidates.append((w, d, gap, drift))

        # A leg appearing in several candidate pairs is ambiguous, which is
        # exactly why this tier cannot be auto-applied without confirmation.
        leg_counts = Counter()
        for w, d, _, _ in candidates:
            leg_counts[w['id']] += 1
            leg_counts[d['id']] += 1
        ambiguous = sum(1 for count in leg_counts.values() if count > 1)

        print(f'candidate pairs (<={WINDOW_SECONDS // 3600}h, +/-{TOLERANCE:.0%})  : {len(candidates)}')
        print(f'legs appearing in >1 pair    : {ambiguous}  '
              f'{"(would need user confirmation)" if ambiguous else "(all unambiguous)"}')
        for w, d, gap, drift in candidates[:8]:
            print(f'    {w["exchange_name"]:>9} -> {d["exchange_name"]:<9} '
                  f'{w["amount_num"]:<12.8g} {w["asset"]:<6} gap {gap // 60:>4}m  drift {drift:.2%}')

        # ---- tier 3 / 4 -------------------------------------------------
        section('TIER 3 / 4 - WHAT IS LEFT')

        tier2_rows = {r['id'] for w, d, _, _ in candidates for r in (w, d)}
        resolved = matched_rows | tier2_rows

        remaining = [r for r in rows if r['id'] not in resolved]
        already_internal = [r for r in remaining if r['is_internal'] == 1]
        addressable = [r for r in remaining
                       if r['is_internal'] != 1 and r['address']]
        opaque = [r for r in remaining
                  if r['is_internal'] != 1 and not r['address']]

        print(f'tagged internal by exchange  : {len(already_internal):>5}  {pct(len(already_internal), len(rows))}')
        print(f'has an address to label      : {len(addressable):>5}  {pct(len(addressable), len(rows))}   <- Tier 3 reachable')
        print(f'no counterparty at all       : {len(opaque):>5}  {pct(len(opaque), len(rows))}   <- Tier 4, unresolvable')

        if opaque:
            print()
            print('  Unresolvable deposits are the tax-ambiguous ones - income vs. your')
            print('  own coins arriving. Largest few:')
            for row in sorted([r for r in opaque if r['kind'] == 'deposit'],
                              key=lambda r: r['amount_num'], reverse=True)[:5]:
                print(f'    {row["exchange_name"]:>9}  +{row["amount_num"]:<14.8g} {row["asset"]:<6}'
                      f'  {row["network"] or "?"}')

        # ---- verdict -----------------------------------------------------
        section('VERDICT')

        total = len(rows)
        t1, t2 = len(matched_rows), len(tier2_rows)
        t3, t4 = len(addressable), len(opaque)
        t_int = len(already_internal)

        for label, count in (('Tier 1 exact      ', t1), ('Tier 2 inferable  ', t2),
                             ('exchange-tagged   ', t_int), ('Tier 3 labelable  ', t3),
                             ('Tier 4 opaque     ', t4)):
            print(f'  {label} {bar(count / total if total else 0)} {count:>5}  {pct(count, total)}')

        print()
        txid_coverage = sum(1 for r in rows if r['txid']) / total
        if txid_coverage < 0.4:
            print(f'  txid coverage is {txid_coverage:.0%} - too thin for exact matching to carry')
            print('  the feature. An address book (Tier 3) is the better investment.')
        elif t1 == 0 and txid_coverage >= 0.4:
            print(f'  txid coverage is {txid_coverage:.0%} but produced no cross-exchange pairs.')
            print('  Either you have not moved funds between two connected exchanges, or the')
            print('  two sides format the hash differently - worth eyeballing before building.')
        else:
            plural = 'pair' if len(exact_pairs) == 1 else 'pairs'
            print(f'  Exact matching works on your data ({len(exact_pairs)} {plural}). Build Tier 1')
            print('  first; it needs no confirmation UI because it cannot produce a false positive.')

        if t4 / total > 0.5:
            print(f'  {t4 / total:.0%} of rows have no counterparty at all. Whatever gets built,')
            print('  most of this history will still need you to declare it by hand.')

        return 0
    finally:
        conn.close()


if __name__ == '__main__':
    sys.exit(main())
