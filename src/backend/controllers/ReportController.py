"""Monthly portfolio report email endpoints.

Charts are rendered and captured in the renderer (where the chart code lives)
and POSTed here as PNG data URLs; this controller fetches the month's execution
logs from the DB, composes the HTML email, and sends it via the user's own SMTP
account (same credentials used for automation notifications).
"""

import re
import base64
import calendar
from datetime import datetime, date

from flask import Blueprint, request
from helper.Security import token_required
from helper.ErrorHandler import handle_error, bad_request, not_found
from helper.Helper import success_response

report_bp = Blueprint('report', __name__)


def _period_bounds(period: str):
    y, m = (int(x) for x in period.split('-'))
    start = f"{y:04d}-{m:02d}-01 00:00:00"
    ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
    end = f"{ny:04d}-{nm:02d}-01 00:00:00"
    return start, end


def _period_epoch_bounds(period: str):
    """UTC epoch-second bounds for the month (for portfolio snapshots)."""
    from datetime import datetime, timezone
    y, m = (int(x) for x in period.split('-'))
    start = datetime(y, m, 1, tzinfo=timezone.utc)
    ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
    end = datetime(ny, nm, 1, tzinfo=timezone.utc)
    return int(start.timestamp()), int(end.timestamp())


def _period_label(period: str) -> str:
    y, m = period.split('-')
    return f"{calendar.month_name[int(m)]} {y}"


def _prev_period(today: date | None = None) -> str:
    today = today or date.today()
    if today.month == 1:
        return f"{today.year - 1:04d}-12"
    return f"{today.year:04d}-{today.month - 1:02d}"


def _decode_data_url(s):
    if not s:
        return None
    if ',' in s:
        s = s.split(',', 1)[1]
    try:
        return base64.b64decode(s)
    except Exception:
        return None


@report_bp.route('/monthly/status', methods=['GET'])
@token_required
def monthly_status():
    """Whether last month's report is still owed (used by the auto-scheduler)."""
    try:
        from controllers.UserDbContext import UserDbContext
        from controllers.ReportDbContext import ReportDbContext

        user = UserDbContext.get_user_by_id(request.user_id)
        if not user:
            return not_found("User not found")

        enabled = bool(user.email_notifications_enabled and user.notify_email
                       and user.smtp_password_encrypted)
        period = _prev_period()
        due = enabled and not ReportDbContext.was_sent(request.user_id, period)

        return success_response(data={
            'enabled': enabled,
            'period': period,
            'period_label': _period_label(period),
            'due': due,
        })
    except Exception as e:
        return handle_error(e)


@report_bp.route('/monthly/send', methods=['POST'])
@token_required
def send_monthly():
    """Compose and send the monthly report. ``test`` sends without recording it."""
    try:
        from controllers.UserDbContext import UserDbContext
        from controllers.AutomationDbContext import AutomationDbContext
        from controllers.PortfolioDbContext import PortfolioDbContext
        from controllers.ReportDbContext import ReportDbContext
        from helper.Security import decrypt_api_key
        from helper.notifier import send_html_email
        from helper.report_email import build_monthly_report_html, build_report_text

        data = request.get_json() or {}
        period = (data.get('period') or '').strip()
        is_test = bool(data.get('test'))
        if not re.match(r'^\d{4}-\d{2}$', period):
            return bad_request("A valid period (YYYY-MM) is required")

        user = UserDbContext.get_user_by_id(request.user_id)
        if not user:
            return not_found("User not found")

        notify_email = (data.get('notify_email') or user.notify_email or '').strip()
        if not notify_email:
            return bad_request("No email address is configured")

        if user.smtp_password_encrypted:
            password = decrypt_api_key(user.smtp_password_encrypted)
        else:
            password = data.get('smtp_password')
        if not password:
            return bad_request("An SMTP app password is required to send the report")

        start, end = _period_bounds(period)
        logs = AutomationDbContext.get_logs_between(request.user_id, start, end)

        start_ts, end_ts = _period_epoch_bounds(period)
        change = PortfolioDbContext.get_month_change(request.user_id, start_ts, end_ts)

        images = {}
        ctx = {
            'period_label': _period_label(period),
            'generated_label': datetime.utcnow().strftime('%b %d, %Y'),
            'total_change': change['total'],
            'asset_changes': change['assets'],
            'has_baseline': change['has_baseline'],
            'automations': data.get('automations') or [],
            'open_orders': data.get('open_orders') or [],
            'rules_count': data.get('rules_count', 0) or 0,
            'orders_count': data.get('orders_count', 0) or 0,
            'logs': logs,
        }

        subject = f"Cyrus — Monthly Report ({ctx['period_label']})"
        if is_test:
            subject = "[Test] " + subject

        send_html_email(
            to_addr=notify_email,
            subject=subject,
            html_body=build_monthly_report_html(ctx),
            text_body=build_report_text(ctx),
            inline_images=images,
            smtp_user=notify_email,
            smtp_password=password,
            smtp_host=user.smtp_host,
            smtp_port=user.smtp_port,
        )

        if not is_test:
            ReportDbContext.mark_sent(request.user_id, period)

        return success_response(message=f"Report sent to {notify_email}")
    except Exception as e:
        return handle_error(e)
