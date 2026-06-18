"""Email notifications via the user's own SMTP account.

Cyrus has no mail server of its own — the local backend logs into the user's
email provider (with an app password they supply) and sends mail from their
address to their address. Uses only the standard library (``smtplib``), so
there's no extra dependency and no shared secret baked into the app.

The app password is stored Fernet-encrypted in the DB; callers decrypt it and
hand the plaintext here only at send time.
"""

import smtplib
import threading
from email.message import EmailMessage
from typing import Optional, Tuple


DEFAULT_SMTP_PORT = 587

# Common provider SMTP endpoints, inferred from the email domain so users
# rarely need to type a host/port themselves.
_SMTP_PROVIDERS: dict[str, Tuple[str, int]] = {
    'gmail.com':      ('smtp.gmail.com', 587),
    'googlemail.com': ('smtp.gmail.com', 587),
    'outlook.com':    ('smtp-mail.outlook.com', 587),
    'hotmail.com':    ('smtp-mail.outlook.com', 587),
    'live.com':       ('smtp-mail.outlook.com', 587),
    'office365.com':  ('smtp.office365.com', 587),
    'yahoo.com':      ('smtp.mail.yahoo.com', 587),
    'icloud.com':     ('smtp.mail.me.com', 587),
    'me.com':         ('smtp.mail.me.com', 587),
    'aol.com':        ('smtp.aol.com', 587),
    'proton.me':      ('smtp.protonmail.ch', 587),
    'protonmail.com': ('smtp.protonmail.ch', 587),
    'zoho.com':       ('smtp.zoho.com', 587),
}


def infer_smtp_settings(email: str) -> Tuple[Optional[str], int]:
    """Return ``(host, port)`` for an email address, host=None if unknown."""
    domain = (email or '').rsplit('@', 1)[-1].strip().lower()
    return _SMTP_PROVIDERS.get(domain, (None, DEFAULT_SMTP_PORT))


def resolve_smtp(email: str, smtp_host: Optional[str],
                 smtp_port: Optional[int]) -> Tuple[str, int]:
    """Resolve the host/port to use, preferring explicit overrides.

    Raises ``ValueError`` when no host can be determined.
    """
    host_guess, port_guess = infer_smtp_settings(email)
    host = (smtp_host or '').strip() or host_guess
    if not host:
        raise ValueError(
            f"Could not determine an SMTP server for '{email}'. "
            f"Enter the SMTP host manually."
        )
    port = int(smtp_port or port_guess or DEFAULT_SMTP_PORT)
    return host, port


def send_email(to_addr: str, subject: str, body: str,
               smtp_user: str, smtp_password: str,
               smtp_host: Optional[str] = None,
               smtp_port: Optional[int] = None,
               timeout: int = 15) -> None:
    """Send a plaintext email synchronously. Raises on failure.

    ``smtp_user`` doubles as the From/login address (the user sends to
    themselves). Credentials are never logged.
    """
    if not to_addr or not smtp_user or not smtp_password:
        raise ValueError("Email address and SMTP app password are required")

    host, port = resolve_smtp(smtp_user, smtp_host, smtp_port)

    msg = EmailMessage()
    msg['From'] = smtp_user
    msg['To'] = to_addr
    msg['Subject'] = subject
    msg.set_content(body)

    with smtplib.SMTP(host, port, timeout=timeout) as server:
        server.starttls()
        server.login(smtp_user, smtp_password)
        server.send_message(msg)


def send_email_async(to_addr: str, subject: str, body: str,
                     smtp_user: str, smtp_password: str,
                     smtp_host: Optional[str] = None,
                     smtp_port: Optional[int] = None) -> None:
    """Fire-and-forget send so a slow SMTP server never stalls the caller.

    Failures are swallowed (logged) — a notification problem must never break
    rule execution.
    """
    def _run() -> None:
        try:
            send_email(to_addr, subject, body, smtp_user, smtp_password,
                       smtp_host=smtp_host, smtp_port=smtp_port)
        except Exception as e:
            print(f"[NOTIFIER] Email send failed: {e}")

    threading.Thread(target=_run, daemon=True, name="email-notifier").start()
