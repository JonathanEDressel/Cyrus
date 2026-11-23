"""The worker's price-alert check (alerts set from lines on the Charts page).

Runs once per worker cycle. Alerts are grouped by feed (source + symbol) so
each market is read once, from 1m candles covering the time since the group
was last checked; that catches a wick that touched the line between cycles.
An alert is flipped to 'triggered' before anyone is told, so it can never fire
twice. The email is best-effort and never affects the check.
"""

import time
from collections import defaultdict

from controllers.AlertDbContext import AlertDbContext, alert_price_at
from helper.alert_email import alert_when, send_alert_email
from helper.ExchangeRegistry import CHART_SOURCES, source_name
from helper.PublicMarket import recent_range
from helper.StockMarket import StockKeyError


def _fmt(p: float) -> str:
    a = abs(p)
    return f"{p:,.2f}" if a >= 1 else f"{p:,.6f}".rstrip('0')


def check_price_alerts(stop_event=None) -> int:
    """Check every armed alert once; returns how many fired."""
    alerts = AlertDbContext.active_alerts()
    if not alerts:
        return 0
    # Keyed feeds (Stocks) are read with each user's own key, so they group
    # per user; keyless feeds are shared across users.
    groups: dict[tuple[str, str, int | None], list[dict]] = defaultdict(list)
    for a in alerts:
        keyed = (CHART_SOURCES.get(a['source']) or {}).get('requires_key')
        groups[(a['source'], a['symbol'], a['user_id'] if keyed else None)].append(a)

    fired = 0
    for (source, symbol, user_id), group in groups.items():
        if stop_event is not None and stop_event.is_set():
            break
        now = int(time.time())
        since = min((a['last_checked_at'] or a['created_at']) for a in group)
        try:
            rng = recent_range(source, symbol, since, user_id)
        except StockKeyError:
            # No key on file (removed, or locked by a new SECRET_KEY): the
            # alert stays armed for when one is added.
            print(f"[ALERTS] {source} {symbol}: skipped, user {user_id} has no usable key")
            continue
        except Exception as e:
            # A feed that's down is simply tried again next cycle.
            print(f"[ALERTS] {source} {symbol}: price unavailable ({e})")
            continue
        if not rng:
            continue
        for a in group:
            target = alert_price_at(a, now)
            if target is None:
                continue
            hit = rng['high'] >= target if a['direction'] == 'above' else rng['low'] <= target
            if not hit:
                continue
            if AlertDbContext.mark_triggered(a['id'], now, target):
                fired += 1
                print(f"[ALERTS] Alert {a['id']} fired: {symbol} {a['direction']} {target}")
                _email(a, target, rng['last'])
        AlertDbContext.mark_checked([a['id'] for a in group], now)
    return fired


def _email(alert: dict, target: float, last: float) -> None:
    """Email the user, if they set email notifications up. Never raises."""
    verb = 'rose to' if alert['direction'] == 'above' else 'fell to'
    line = 'trend line' if alert['kind'] == 'line' else 'line'
    source = source_name(alert['source'])
    send_alert_email(alert['user_id'], f"Cyrus: {alert['symbol']} {verb} {_fmt(target)}", {
        'rule_name': f"{alert['symbol']} price alert",
        'when': alert_when(),
        'trigger': f"{alert['symbol']} {verb} your {line} at {_fmt(target)} (now {_fmt(last)})",
        'action': 'Price alert from your chart',
        'result': alert.get('note') or 'The alert is now off. Move the line or re-arm it on the Charts page to watch again.',
        'reference': f"{source} public price",
    })
