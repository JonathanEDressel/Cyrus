"""Monthly portfolio report email endpoints.

The report itself is composed in ``helper/monthly_report.py`` — from the DB and
the exchanges, not from anything the client sends — and the scheduled send is
driven by the automation worker. What's left here is the Profile page's test
send, plus a status endpoint so the UI can say when the next report is due.
"""

from flask import Blueprint, request
from helper.Security import token_required
from helper.ErrorHandler import handle_error, bad_request, not_found
from helper.Helper import success_response
from helper import monthly_report

report_bp = Blueprint('report', __name__)


@report_bp.route('/monthly/status', methods=['GET'])
@token_required
def monthly_status():
    """Whether last month's report is configured for, and still owed to, this user."""
    try:
        from controllers.UserDbContext import UserDbContext
        from controllers.ReportDbContext import ReportDbContext

        user = UserDbContext.get_user_by_id(request.user_id)
        if not user:
            return not_found("User not found")

        enabled = monthly_report.is_enabled(user)
        period = monthly_report.previous_period()
        due = enabled and not ReportDbContext.was_sent(request.user_id, period)

        return success_response(data={
            'enabled': enabled,
            'period': period,
            'period_label': monthly_report.period_label(period),
            'due': due,
        })
    except Exception as e:
        return handle_error(e)


@report_bp.route('/monthly/send', methods=['POST'])
@token_required
def send_monthly():
    """Send a report on demand. ``test`` sends without recording it as the month's."""
    try:
        data = request.get_json() or {}
        period = (data.get('period') or '').strip()
        is_test = bool(data.get('test'))

        try:
            to_addr = monthly_report.send_monthly_report(
                request.user_id, period, is_test=is_test,
                # A test send can name an address / password that isn't saved yet,
                # so the Profile page can check its settings before storing them.
                notify_email=data.get('notify_email'),
                smtp_password=data.get('smtp_password'),
            )
        except ValueError as e:
            return bad_request(str(e))

        return success_response(message=f"Report sent to {to_addr}")
    except Exception as e:
        return handle_error(e)
