"""Best-effort alert emails, shared by chart price alerts and script alerts.

Uses the user's own email settings (Profile → Notifications). Never raises:
an email that can't be sent must not affect the alert itself.
"""

import traceback
from datetime import datetime


def alert_when() -> str:
    """'Nov 22, 2026 at 3:04 PM'"""
    now = datetime.now()
    return f"{now:%b} {now.day}, {now.year} at {now.hour % 12 or 12}:{now:%M} {now:%p}"


def send_alert_email(user_id: int, subject: str, details: dict) -> None:
    """Email an alert if the user set email notifications up.

    ``details`` holds the execution-email fields: rule_name, when, trigger,
    action, result, reference.
    """
    try:
        from controllers.UserDbContext import UserDbContext
        settings = UserDbContext.get_email_settings(user_id)
        if not settings or not settings.get('email_notifications_enabled'):
            return
        to_addr = settings.get('notify_email')
        enc_pw = settings.get('smtp_password_encrypted')
        if not to_addr or not enc_pw:
            return
        from helper.Security import decrypt_api_key
        from helper.notifier import send_html_email_async
        from helper.report_email import build_execution_email_html, build_execution_email_text

        send_html_email_async(
            to_addr=to_addr,
            subject=subject,
            html_body=build_execution_email_html(**details),
            text_body=build_execution_email_text(**details),
            smtp_user=to_addr, smtp_password=decrypt_api_key(enc_pw),
            smtp_host=settings.get('smtp_host'), smtp_port=settings.get('smtp_port'),
        )
    except Exception as e:
        print(f"[ALERTS] Couldn't email user {user_id}: {e}")
        traceback.print_exc()
