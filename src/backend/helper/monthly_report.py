"""Composing and sending the monthly portfolio report.

One code path, two callers: the automation worker sends the scheduled report
(see ``AutomationWorker._send_due_reports``), and ``ReportController`` sends the
test report from the Profile page. Keeping both on ``send_monthly_report`` means
the test email is exactly what the scheduled one will look like.

Everything in the report is assembled here from the database and the exchanges.
It used to be assembled in the renderer, because the charts were rasterised
there and posted up as PNGs — but no chart images are sent any more, and having
the renderer as the only source meant the report could only go out while the app
was open on the Overview page, and covered only the exchange that happened to be
selected. It now covers every validated connection.
"""

import calendar
from datetime import date, datetime, timezone


# ---------------------------------------------------------------------------
# Periods ('YYYY-MM')
# ---------------------------------------------------------------------------

def previous_period(today: date | None = None) -> str:
    """The month before ``today`` — the month a report covers."""
    today = today or date.today()
    if today.month == 1:
        return f"{today.year - 1:04d}-12"
    return f"{today.year:04d}-{today.month - 1:02d}"


def period_label(period: str) -> str:
    y, m = period.split('-')
    return f"{calendar.month_name[int(m)]} {y}"


def period_bounds(period: str) -> tuple[str, str]:
    """UTC 'YYYY-MM-DD HH:MM:SS' bounds for the month, end-exclusive."""
    y, m = (int(x) for x in period.split('-'))
    ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
    return f"{y:04d}-{m:02d}-01 00:00:00", f"{ny:04d}-{nm:02d}-01 00:00:00"


def period_epoch_bounds(period: str) -> tuple[int, int]:
    """UTC epoch-second bounds for the month (for portfolio snapshots)."""
    y, m = (int(x) for x in period.split('-'))
    ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
    return (int(datetime(y, m, 1, tzinfo=timezone.utc).timestamp()),
            int(datetime(ny, nm, 1, tzinfo=timezone.utc).timestamp()))


# ---------------------------------------------------------------------------
# Rules in plain English
# ---------------------------------------------------------------------------

def describe_trigger(rule) -> str:
    """The "when …" half of a rule, for the automations table."""
    if rule.trigger_type == 'order_filled':
        if rule.trigger_pair and rule.trigger_side:
            return f"a {rule.trigger_side} order on {rule.trigger_pair} fills"
        if rule.trigger_order_id:
            return f"order {str(rule.trigger_order_id)[:10]} fills"
        return "an order fills"
    if rule.trigger_type == 'balance_threshold':
        return f"{rule.trigger_asset} balance reaches {rule.trigger_threshold}"
    if rule.trigger_type == 'price_threshold':
        quote = rule.trigger_price_quote_asset or 'USD'
        return f"{rule.trigger_asset} price reaches {rule.trigger_threshold} {quote}"
    if rule.trigger_type == 'allocation_threshold':
        asset = rule.action_asset or rule.trigger_asset
        return f"{asset} exceeds {rule.trigger_allocation_percent}% of the portfolio"
    return rule.trigger_type or '—'


def describe_action(rule) -> str:
    """The "then …" half of a rule, for the automations table."""
    if rule.action_type == 'withdraw_crypto':
        amount = 'the filled amount of' if rule.use_filled_amount else (rule.action_amount or '')
        target = rule.action_address_key or 'a saved address'
        return ' '.join(
            f"withdraw {amount} {rule.action_asset or ''} to {target}".split())

    if rule.action_type == 'convert_crypto':
        mode = (rule.action_amount_mode or '').lower()
        amount = ''
        if rule.trigger_type == 'allocation_threshold':
            amount = f"the excess above {rule.rebalance_target_percent}% of "
        elif mode == 'percent':
            amount = f"{rule.action_amount}% of "
        elif mode == 'fixed' and rule.action_amount:
            amount = f"{rule.action_amount} "
        return ' '.join(
            f"convert {amount}{rule.action_asset or ''} → {rule.convert_to_asset or ''}".split())

    return rule.action_type or '—'


# ---------------------------------------------------------------------------
# Gathering
# ---------------------------------------------------------------------------

def _automations(user_id: int) -> list[dict]:
    from controllers.AutomationDbContext import AutomationDbContext

    rules = AutomationDbContext.get_rules_by_user(user_id)
    return [{
        'name': r.rule_name or 'Automation',
        'trigger': describe_trigger(r),
        'action': describe_action(r),
        'status': 'Active' if r.is_active else 'Paused',
    } for r in rules]


def _open_orders(user_id: int) -> list[dict]:
    """Resting orders across every validated connection.

    Best-effort per connection: an exchange that's unreachable leaves its orders
    out of the table rather than failing the whole email.
    """
    from controllers.ExchangeConnectionDbContext import ExchangeConnectionDbContext
    from helper.ExchangeRegistry import get_user_exchange
    from helper.ExchangeClient import get_open_orders

    rows: list[dict] = []
    for conn in ExchangeConnectionDbContext.get_validated_connections_by_user(user_id):
        label = conn.get('label')
        if not label or label == 'Default':
            label = str(conn['exchange_name']).title()
        try:
            exchange = get_user_exchange(user_id, conn['id'])
            if not exchange:
                continue
            orders = get_open_orders(exchange)
        except Exception as e:
            print(f"[REPORT] Skipping open orders for {label} (user {user_id}): {e}")
            continue

        for o in orders:
            price = o.get('price')
            rows.append({
                'pair': o.get('symbol') or '',
                'side': str(o.get('side') or '').upper(),
                'amount': str(o.get('amount') or ''),
                'price': str(price) if price and float(price) > 0 else 'Market',
                'status': o.get('status') or '',
                'exchange': label,
            })
    return rows


def build_context(user_id: int, period: str) -> dict:
    """Everything ``report_email`` needs to render the email for one month."""
    from controllers.AutomationDbContext import AutomationDbContext
    from controllers.PortfolioDbContext import PortfolioDbContext

    start, end = period_bounds(period)
    logs = AutomationDbContext.get_logs_between(user_id, start, end)

    start_ts, end_ts = period_epoch_bounds(period)
    change = PortfolioDbContext.get_month_change(user_id, start_ts, end_ts)

    automations = _automations(user_id)
    open_orders = _open_orders(user_id)

    return {
        'period_label': period_label(period),
        'generated_label': datetime.utcnow().strftime('%b %d, %Y'),
        'total_change': change['total'],
        'asset_changes': change['assets'],
        'has_baseline': change['has_baseline'],
        'automations': automations,
        'open_orders': open_orders,
        'rules_count': len(automations),
        'orders_count': len(open_orders),
        'logs': logs,
    }


# ---------------------------------------------------------------------------
# Sending
# ---------------------------------------------------------------------------

def is_enabled(user) -> bool:
    """True when this user has enough email configuration to receive reports."""
    return bool(user and user.email_notifications_enabled
                and user.notify_email and user.smtp_password_encrypted)


def send_monthly_report(user_id: int, period: str, is_test: bool = False,
                        notify_email: str | None = None,
                        smtp_password: str | None = None) -> str:
    """Compose and send one month's report. Returns the address it went to.

    Raises on a bad period, missing configuration, or an SMTP failure. The send
    is recorded (so it goes out once a month) unless ``is_test``.
    """
    import re

    from controllers.UserDbContext import UserDbContext
    from controllers.ReportDbContext import ReportDbContext
    from helper.Security import decrypt_api_key
    from helper.notifier import send_html_email
    from helper.report_email import build_monthly_report_html, build_report_text

    if not re.match(r'^\d{4}-\d{2}$', period or ''):
        raise ValueError("A valid period (YYYY-MM) is required")

    user = UserDbContext.get_user_by_id(user_id)
    if not user:
        raise ValueError("User not found")

    to_addr = (notify_email or user.notify_email or '').strip()
    if not to_addr:
        raise ValueError("No email address is configured")

    password = decrypt_api_key(user.smtp_password_encrypted) \
        if user.smtp_password_encrypted else smtp_password
    if not password:
        raise ValueError("An SMTP app password is required to send the report")

    ctx = build_context(user_id, period)
    subject = f"Cyrus — Monthly Report ({ctx['period_label']})"
    if is_test:
        subject = "[Test] " + subject

    send_html_email(
        to_addr=to_addr,
        subject=subject,
        html_body=build_monthly_report_html(ctx),
        text_body=build_report_text(ctx),
        inline_images={},
        smtp_user=to_addr,
        smtp_password=password,
        smtp_host=user.smtp_host,
        smtp_port=user.smtp_port,
    )

    if not is_test:
        ReportDbContext.mark_sent(user_id, period)

    return to_addr
