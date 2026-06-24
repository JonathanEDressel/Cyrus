"""Builds the HTML body for the monthly portfolio report email.

Table-based, inline-styled, dark-themed markup so it renders consistently in
Gmail/Outlook/Apple Mail. Charts are referenced as ``cid:`` inline images that
the caller attaches (portfolio doughnut, automation flow, open-order flow).
"""

from html import escape


# Brand palette (mirrors the app).
BG = "#0b1220"
PANEL = "#161f33"
PANEL_ALT = "#1e293b"
BORDER = "#26324a"
TEXT = "#e2e8f0"
MUTED = "#94a3b8"
CYAN = "#06b6d4"
PURPLE = "#818cf8"

MAX_LOG_ROWS = 100


def _fmt_usd(n: float) -> str:
    try:
        n = float(n)
    except (TypeError, ValueError):
        return "$0.00"
    digits = 0 if abs(n) >= 1000 else 2 if abs(n) >= 1 else 4
    return "$" + f"{n:,.{digits}f}"


def _fmt_amount(n: float) -> str:
    try:
        return f"{float(n):,.6f}".rstrip("0").rstrip(".")
    except (TypeError, ValueError):
        return str(n)


def _status_color(status: str) -> str:
    return {
        "success": "#22c55e",
        "error": "#ef4444",
        "skipped": "#f59e0b",
    }.get((status or "").lower(), "#64748b")


def _chip(text: str, color: str) -> str:
    """A status pill: coloured text + border on a solid dark fill (no hex-alpha,
    so it never collapses to colour-on-colour in clients without rgba support)."""
    return (
        f'<span style="display:inline-block;padding:2px 9px;border-radius:999px;'
        f'font-size:11px;font-weight:700;color:{color};background:{BG};'
        f'border:1px solid {color};">{escape(text)}</span>'
    )


def _section_title(text: str) -> str:
    return (
        f'<tr><td style="padding:28px 28px 8px;">'
        f'<h2 style="margin:0;font-size:17px;font-weight:700;color:{TEXT};'
        f'letter-spacing:.2px;">{escape(text)}</h2></td></tr>'
    )


POS = "#22c55e"
NEG = "#ef4444"


def _delta_span(value: float, kind: str) -> str:
    """A coloured +/- delta string. kind: 'usd' | 'amount' | 'pp' | 'pct'."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        v = 0.0
    color = MUTED if abs(v) < 1e-9 else (POS if v > 0 else NEG)
    sign = "+" if v > 0 else ("−" if v < 0 else "")
    mag = abs(v)
    if kind == "usd":
        body = _fmt_usd(mag).lstrip("$")
        text = f"{sign}${body}"
    elif kind == "amount":
        text = f"{sign}{_fmt_amount(mag)}"
    elif kind == "pp":
        text = f"{sign}{mag:.1f} pp"
    else:  # pct
        text = f"{sign}{mag:.1f}%"
    return f'<span style="color:{color};font-weight:700;">{text}</span>'


def _total_change_banner(total: dict, has_baseline: bool) -> str:
    total = total or {}
    current = _fmt_usd(total.get("current", 0))

    def col(label, value, align):
        return (
            f'<td align="{align}" style="vertical-align:top;">'
            f'<div style="color:{MUTED};font-size:11px;text-transform:uppercase;'
            f'letter-spacing:.5px;margin-bottom:3px;">{escape(label)}</div>'
            f'<div style="color:{TEXT};font-size:19px;font-weight:800;">{value}</div>'
            f'</td>'
        )

    if not has_baseline:
        body = (
            f'<td colspan="3" style="vertical-align:top;">'
            f'<div style="color:{MUTED};font-size:11px;text-transform:uppercase;'
            f'letter-spacing:.5px;margin-bottom:3px;">Current total value</div>'
            f'<div style="color:{TEXT};font-size:19px;font-weight:800;">{current}</div>'
            f'<div style="color:{MUTED};font-size:12px;margin-top:8px;">'
            f'No earlier snapshot is on record yet, so there\'s nothing to compare '
            f'against this month.</div></td>'
        )
    else:
        previous = _fmt_usd(total.get("previous", 0))
        delta = (f'{_delta_span(total.get("change_usd", 0), "usd")} '
                 f'({_delta_span(total.get("change_pct", 0), "pct")})')
        body = (
            col("Value at start of month", previous, "left")
            + f'<td align="center" style="color:{MUTED};font-size:22px;'
            f'font-weight:600;padding:0 10px;vertical-align:middle;">&rarr;</td>'
            + col("Value at end of month", current, "right")
            + f'</tr><tr><td colspan="3" style="font-size:13px;padding-top:10px;'
            f'color:{MUTED};">{delta} <span style="color:{MUTED};">this month</span></td>'
        )

    return (
        f'<tr><td style="padding:4px 28px 10px;">'
        f'<table role="presentation" cellpadding="0" cellspacing="0" bgcolor="{PANEL}" '
        f'style="width:100%;background:{PANEL};border:1px solid {BORDER};'
        f'border-radius:12px;"><tr><td style="padding:16px 18px;">'
        f'<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">'
        f'<tr>{body}</tr></table>'
        f'</td></tr></table></td></tr>'
    )


def _holdings_change_table(assets: list, has_baseline: bool) -> str:
    if not assets:
        return _empty_row("No portfolio snapshots recorded yet.")

    rows = []
    for a in assets:
        asset = escape(str(a.get("asset", "")))
        amount = _fmt_amount(a.get("amount", 0))
        value = _fmt_usd(a.get("usd_value", 0))
        pct = float(a.get("pct", 0) or 0)
        amt_d = _delta_span(a.get("amount_change", 0), "amount") if has_baseline else ""
        usd_d = _delta_span(a.get("usd_change", 0), "usd") if has_baseline else ""
        pct_d = _delta_span(a.get("pct_change", 0), "pp") if has_baseline else ""
        rows.append(
            f'<tr>'
            f'<td style="padding:9px 10px;border-top:1px solid {BORDER};color:{TEXT};'
            f'font-size:13px;font-weight:600;vertical-align:top;">{asset}</td>'
            f'<td style="padding:9px 10px;border-top:1px solid {BORDER};color:{TEXT};'
            f'font-size:13px;text-align:right;vertical-align:top;">{amount}'
            f'<div style="font-size:11px;margin-top:2px;">{amt_d}</div></td>'
            f'<td style="padding:9px 10px;border-top:1px solid {BORDER};color:{TEXT};'
            f'font-size:13px;text-align:right;vertical-align:top;">{value}'
            f'<div style="font-size:11px;margin-top:2px;">{usd_d}</div></td>'
            f'<td style="padding:9px 10px;border-top:1px solid {BORDER};color:{TEXT};'
            f'font-size:13px;text-align:right;vertical-align:top;">{pct:.1f}%'
            f'<div style="font-size:11px;margin-top:2px;">{pct_d}</div></td>'
            f'</tr>'
        )

    return _grid(
        [("Asset", "left"), ("Amount", "right"), ("Value", "right"), ("Allocation", "right")],
        "".join(rows),
    )


def _logs_table(logs: list) -> str:
    if not logs:
        return (
            f'<tr><td style="padding:4px 28px 8px;color:{MUTED};font-size:13px;">'
            f'No automations executed this month.</td></tr>'
        )

    truncated = len(logs) > MAX_LOG_ROWS
    shown = logs[:MAX_LOG_ROWS]
    rows = []
    for l in shown:
        when = escape(str(l.get("created_at", ""))[:16])
        name = escape(str(l.get("rule_name") or "—"))
        action = escape(str(l.get("action_executed", "")))
        result = escape(str(l.get("action_result", ""))[:140])
        status = (l.get("status") or "").lower()
        color = _status_color(status)
        rows.append(
            f'<tr>'
            f'<td style="padding:9px 10px;border-top:1px solid {BORDER};color:{MUTED};'
            f'font-size:12px;white-space:nowrap;vertical-align:top;">{when}</td>'
            f'<td style="padding:9px 10px;border-top:1px solid {BORDER};color:{TEXT};'
            f'font-size:12px;vertical-align:top;">{name}'
            f'<div style="color:{MUTED};font-size:11px;margin-top:2px;">{action}</div>'
            f'<div style="color:{MUTED};font-size:11px;margin-top:2px;">{result}</div></td>'
            f'<td style="padding:9px 10px;border-top:1px solid {BORDER};text-align:right;'
            f'vertical-align:top;">{_chip(status or "—", color)}</td>'
            f'</tr>'
        )

    note = ""
    if truncated:
        note = (
            f'<tr><td colspan="3" style="padding:10px;border-top:1px solid {BORDER};'
            f'color:{MUTED};font-size:12px;text-align:center;">'
            f'Showing the most recent {MAX_LOG_ROWS} of {len(logs)} executions.</td></tr>'
        )

    return (
        f'<tr><td style="padding:4px 28px 8px;">'
        f'<table role="presentation" cellpadding="0" cellspacing="0" '
        f'style="width:100%;border-collapse:collapse;background:{PANEL};'
        f'border:1px solid {BORDER};border-radius:12px;overflow:hidden;">'
        f'<tr>'
        f'<th align="left" style="padding:10px;color:{MUTED};font-size:11px;'
        f'text-transform:uppercase;letter-spacing:.6px;">When</th>'
        f'<th align="left" style="padding:10px;color:{MUTED};font-size:11px;'
        f'text-transform:uppercase;letter-spacing:.6px;">Automation</th>'
        f'<th align="right" style="padding:10px;color:{MUTED};font-size:11px;'
        f'text-transform:uppercase;letter-spacing:.6px;">Status</th>'
        f'</tr>{"".join(rows)}{note}</table></td></tr>'
    )


def _grid(headers: list, rows_html: str) -> str:
    head = "".join(
        f'<th align="{a}" style="padding:10px;color:{MUTED};font-size:11px;'
        f'text-transform:uppercase;letter-spacing:.6px;">{escape(h)}</th>'
        for h, a in headers
    )
    return (
        f'<tr><td style="padding:4px 28px 8px;">'
        f'<table role="presentation" cellpadding="0" cellspacing="0" bgcolor="{PANEL}" '
        f'style="width:100%;border-collapse:collapse;background:{PANEL};'
        f'border:1px solid {BORDER};border-radius:12px;overflow:hidden;">'
        f'<tr>{head}</tr>{rows_html}</table></td></tr>'
    )


def _empty_row(text: str) -> str:
    return (
        f'<tr><td style="padding:4px 28px 8px;color:{MUTED};font-size:13px;">'
        f'{escape(text)}</td></tr>'
    )


def _automations_table(automations: list) -> str:
    if not automations:
        return _empty_row("No automations set up.")

    rows = []
    for a in automations:
        name = escape(str(a.get("name", "")))
        trigger = escape(str(a.get("trigger", "")))
        action = escape(str(a.get("action", "")))
        status = (a.get("status") or "").lower()
        color = "#22c55e" if status == "active" else "#f59e0b"
        rows.append(
            f'<tr>'
            f'<td style="padding:9px 10px;border-top:1px solid {BORDER};color:{TEXT};'
            f'font-size:12px;font-weight:600;vertical-align:top;">{name}</td>'
            f'<td style="padding:9px 10px;border-top:1px solid {BORDER};color:{MUTED};'
            f'font-size:12px;vertical-align:top;"><span style="color:{CYAN};">When</span> {trigger}</td>'
            f'<td style="padding:9px 10px;border-top:1px solid {BORDER};color:{MUTED};'
            f'font-size:12px;vertical-align:top;"><span style="color:{PURPLE};">Then</span> {action}</td>'
            f'<td style="padding:9px 10px;border-top:1px solid {BORDER};text-align:right;'
            f'vertical-align:top;">{_chip(status or "—", color)}</td>'
            f'</tr>'
        )
    return _grid(
        [("Name", "left"), ("When", "left"), ("Then", "left"), ("Status", "right")],
        "".join(rows),
    )


def _orders_table(orders: list) -> str:
    if not orders:
        return _empty_row("No open orders.")

    rows = []
    for o in orders:
        pair = escape(str(o.get("pair", "")))
        side = (o.get("side") or "").upper()
        side_color = "#22c55e" if side == "BUY" else "#ef4444" if side == "SELL" else MUTED
        amount = escape(str(o.get("amount", "")))
        price = escape(str(o.get("price", "")))
        status = escape(str(o.get("status", "") or "—"))
        rows.append(
            f'<tr>'
            f'<td style="padding:9px 10px;border-top:1px solid {BORDER};color:{TEXT};'
            f'font-size:12px;font-weight:600;">{pair}</td>'
            f'<td style="padding:9px 10px;border-top:1px solid {BORDER};font-size:12px;'
            f'font-weight:700;color:{side_color};">{escape(side or "—")}</td>'
            f'<td style="padding:9px 10px;border-top:1px solid {BORDER};color:{MUTED};'
            f'font-size:12px;text-align:right;">{amount}</td>'
            f'<td style="padding:9px 10px;border-top:1px solid {BORDER};color:{TEXT};'
            f'font-size:12px;text-align:right;">{price}</td>'
            f'<td style="padding:9px 10px;border-top:1px solid {BORDER};color:{MUTED};'
            f'font-size:12px;text-align:right;">{status}</td>'
            f'</tr>'
        )
    return _grid(
        [("Pair", "left"), ("Side", "left"), ("Amount", "right"),
         ("Price", "right"), ("Status", "right")],
        "".join(rows),
    )


def _stat_cards(total_change, rules_count, orders_count, holdings_count, has_baseline) -> str:
    def card(label, value, accent, sub=""):
        sub_html = (f'<div style="font-size:11px;margin-top:3px;">{sub}</div>'
                    if sub else "")
        return (
            f'<td style="padding:6px;" width="25%">'
            f'<table role="presentation" cellpadding="0" cellspacing="0" bgcolor="{PANEL}" '
            f'style="width:100%;background:{PANEL};border:1px solid {BORDER};'
            f'border-radius:12px;">'
            f'<tr><td style="padding:14px 12px;">'
            f'<div style="color:{accent};font-size:19px;font-weight:800;">{value}</div>'
            f'{sub_html}'
            f'<div style="color:{MUTED};font-size:11px;margin-top:3px;'
            f'text-transform:uppercase;letter-spacing:.5px;">{escape(label)}</div>'
            f'</td></tr></table></td>'
        )

    total_change = total_change or {}

    return (
        f'<tr><td style="padding:8px 22px 4px;">'
        f'<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">'
        f'<tr>'
        + card("Total Value", _fmt_usd(total_change.get("current", 0)), CYAN)
        + card("Holdings", str(holdings_count), TEXT)
        + card("Automations", str(rules_count), PURPLE)
        + card("Open Orders", str(orders_count), TEXT)
        + f'</tr></table></td></tr>'
    )


def build_monthly_report_html(ctx: dict) -> str:
    period_label = escape(ctx.get("period_label", ""))
    asset_changes = ctx.get("asset_changes", []) or []
    has_baseline = bool(ctx.get("has_baseline"))
    total_change = ctx.get("total_change", {}) or {}
    logs = ctx.get("logs", []) or []

    parts = [
        f'<!doctype html><html><body style="margin:0;padding:0;background:{BG};">',
        f'<div style="display:none;max-height:0;overflow:hidden;">'
        f'Your Cyrus portfolio report for {period_label}.</div>',
        f'<table role="presentation" cellpadding="0" cellspacing="0" bgcolor="{BG}" '
        f'style="width:100%;background:{BG};padding:24px 0;">'
        f'<tr><td align="center">',
        f'<table role="presentation" cellpadding="0" cellspacing="0" bgcolor="{BG}" '
        f'style="width:640px;max-width:92%;background:{BG};'
        f'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">',

        # Header
        f'<tr><td style="padding:8px 28px 0;">'
        f'<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">'
        f'<tr><td style="color:{CYAN};font-size:13px;font-weight:700;'
        f'letter-spacing:3px;text-transform:uppercase;">CYRUS</td>'
        f'<td align="right" style="color:{MUTED};font-size:12px;">'
        f'{escape(ctx.get("generated_label",""))}</td></tr></table>'
        f'<h1 style="margin:10px 0 2px;color:{TEXT};font-size:24px;font-weight:800;">'
        f'Monthly Portfolio Report</h1>'
        f'<div style="color:{MUTED};font-size:14px;">{period_label}</div></td></tr>',

        _stat_cards(total_change, ctx.get("rules_count", 0),
                    ctx.get("orders_count", 0), len(asset_changes), has_baseline),
    ]

    # Portfolio change (vs start of month)
    parts.append(_section_title("Portfolio — Change This Month"))
    parts.append(_total_change_banner(total_change, has_baseline))
    parts.append(_holdings_change_table(asset_changes, has_baseline))

    # Automations (English grid)
    parts.append(_section_title("Automations"))
    parts.append(_automations_table(ctx.get("automations", []) or []))

    # Open orders (English grid)
    parts.append(_section_title("Open Orders"))
    parts.append(_orders_table(ctx.get("open_orders", []) or []))

    # Execution logs
    parts.append(_section_title("Execution Log"))
    parts.append(_logs_table(logs))

    # Footer
    parts.append(
        f'<tr><td style="padding:24px 28px 8px;">'
        f'<div style="border-top:1px solid {BORDER};padding-top:16px;color:{MUTED};'
        f'font-size:11px;line-height:1.6;">'
        f'You\'re receiving this because monthly reports are enabled in Cyrus. '
        f'All data stays on your device; this email was sent from your own '
        f'configured email account.<br>&copy; 2026 Cyrus.'
        f'</div></td></tr>'
    )

    parts.append('</table></td></tr></table></body></html>')
    return "".join(parts)


def build_report_text(ctx: dict) -> str:
    """Plaintext fallback."""
    total = ctx.get("total_change", {}) or {}
    lines = [
        f"Cyrus — Monthly Portfolio Report ({ctx.get('period_label','')})",
        "",
        f"Total value: {_fmt_usd(total.get('current', 0))} "
        f"(change {_fmt_usd(total.get('change_usd', 0))})",
        f"Holdings: {len(ctx.get('asset_changes', []) or [])}",
        f"Automations: {ctx.get('rules_count', 0)}",
        f"Open orders: {ctx.get('orders_count', 0)}",
        "",
        "Open Cyrus to view the full report.",
    ]
    return "\n".join(lines)
