# Cyrus — Possible Features & API Feasibility

A backlog of candidate features with an honest assessment of whether they're
achievable given the current exchange/API capabilities.

## Short answer: can these be done with the API?

**Almost all of them — yes.** They fall into four buckets:

1. **App-side only** (your backend worker + DB) — no exchange API limits at all.
2. **Standard CCXT calls you already make** (`create_order`, `fetch_balance`,
   `fetch_ticker`, `fetch_ohlcv`, `fetch_open_orders/closed_orders`, `withdraw`).
3. **New CCXT history calls** that CCXT supports but the app doesn't use yet
   (`fetch_my_trades`, `fetch_deposits`, `fetch_withdrawals`, `fetch_ledger`) —
   feasible, with per-exchange history-depth caveats.
4. **External (non-exchange) services** — notifications, etc.

### Capability constraints that actually matter (from `ExchangeRegistry.py`)

| Constraint | Detail |
|---|---|
| **Withdrawals** | **Kraken only.** Coinbase Advanced and Binance are `supports_withdraw: false` in our setup, so any withdraw-based action is Kraken-only. |
| **Native stop / OCO / trailing orders** | Vary by exchange and aren't uniform in CCXT. Portable approach: **app-side price monitoring** (we already poll prices for price-threshold rules) → then a market order. Works on every exchange. |
| **Sandbox / testnet** | `has_sandbox: false` for all current exchanges, so **dry-run is best done as app-side simulation**, not real testnet orders. |
| **Robinhood** | Not CCXT (direct API, scaffolded but commented out). Robinhood-specific support depends on finishing that adapter. |

**Legend:** ✅ Ready (uses methods we already call / pure app logic) · 🟡 Needs
new (but supported) CCXT calls · 🌐 Needs an external service · ⚠️ Capability
varies by exchange.

---

## Automation power-ups (core)

| Feature | Feasible? | Notes |
|---|---|---|
| **DCA / scheduled recurring buys** | ✅ | Scheduling is app-side (worker/cron); execution uses `create_order` (market/limit buy), which we already call. |
| **Buy actions (not just convert/withdraw)** | ✅ | `create_order` already used for sells/convert; buys are the same call. |
| **Stop-loss / take-profit** | ✅ / ⚠️ | App-side monitoring + market order works everywhere. Exchange-native stop orders exist on some exchanges but aren't uniform — prefer the monitored approach. |
| **Trailing stop** | ✅ | Best done app-side: track the peak since arming, sell when price drops X% from it. Uses prices we already poll. |
| **Portfolio rebalancing** | ✅ | `fetch_balance` + `fetch_ticker` + `create_order`; all logic is app-side. |
| **Conditional triggers (AND/OR)** | ✅ | Pure app logic in the rule engine; no API dependency. |

## Safety & trust

| Feature | Feasible? | Notes |
|---|---|---|
| **Dry-run / simulation mode** | ✅ | App-side: evaluate the rule and log what *would* happen without calling `create_order`/`withdraw`. (Real testnet not available — no sandbox enabled.) |
| **Guardrails (daily caps, max withdrawal, confirmations)** | ✅ | App-side enforcement before placing orders/withdrawals. |

## Notifications

| Feature | Feasible? | Notes |
|---|---|---|
| **Alerts on rule fire / fill / error** | 🌐 | Telegram Bot API, Discord webhook, SMTP email, or Electron desktop notifications. Not an exchange API. |
| **Price alerts (notify-only)** | ✅ | Reuses the existing price polling; just don't take an action. |

## Portfolio & analytics

| Feature | Feasible? | Notes |
|---|---|---|
| **Unified portfolio (total value, allocation)** | ✅ | `fetch_balance` per connection + `fetch_ticker` for USD valuation. |
| **P&L tracking (realized/unrealized)** | 🟡 | Realized P&L needs trade history (`fetch_my_trades`) — supported by CCXT but not wired up yet. History depth varies by exchange; cost-basis across deposits/transfers is approximate. |
| **Tax / transaction CSV export** | 🟡 | Needs `fetch_my_trades` + `fetch_deposits` + `fetch_withdrawals` (`fetch_ledger` where available). Feasible, but watch pagination and per-exchange history limits. |
| **Chart indicators (MA, RSI, volume)** | ✅ | Compute from `fetch_ohlcv` candles we already pull. |

## Platform & growth

| Feature | Feasible? | Notes |
|---|---|---|
| **Finish Robinhood** | ⚠️ | Direct API adapter (already scaffolded), not CCXT. |
| **More exchanges (KuCoin, Kraken Futures, …)** | ✅ | CCXT-supported; add to `SUPPORTED_EXCHANGES` + capability flags. |
| **Rule templates library (import/share)** | ✅ | App-side; extends the wizard's starter templates. |
| **Onboarding tutorial** | ✅ | App-side / UI only. |

---

## Suggested build order

1. **Notifications** (🌐) — fastest path to "my automations feel trustworthy"; closes the loop on silent rule execution.
2. **DCA / scheduled recurring buys** (✅) — broadens who the app is for; reuses `create_order`.
3. **Dry-run / simulation mode** (✅) — removes the fear of automating real funds.
4. **Unified portfolio view** (✅) — makes the Overview a real dashboard.
5. **Trailing stop / take-profit** (✅) — high-value risk management on top of price triggers.

> Only **P&L** and **tax export** need genuinely new exchange calls (trade/ledger
> history); everything else is either app-side logic, CCXT methods we already
> use, or an external notification service.

---

## Implementation note: email notifications (no hosted server)

A desktop app doesn't need its own mail server to send email. The **local Python
backend** (`CyrusServer`, which already executes rules in `worker.py`) can talk
**directly** to an email provider over the internet — the provider's servers do
the actual sending, we just call them. Requires an internet connection, not a
server of ours.

### Recommended way: local backend → transactional email API over HTTPS

When a rule fires in `worker.py`, POST to a transactional email service (Resend,
SendGrid, Brevo, Postmark — all have free tiers). One HTTPS call, great
deliverability, nothing to host.

```python
# helper/notifier.py
import requests

def send_email(to_addr: str, subject: str, body: str, api_key: str) -> None:
    requests.post(
        "https://api.resend.com/emails",
        headers={"Authorization": f"Bearer {api_key}"},
        json={
            "from": "Cyrus <alerts@yourdomain.com>",
            "to": [to_addr],
            "subject": subject,
            "text": body,
        },
        timeout=10,
    )
```

Called from the rule-execution path:

```python
send_email(user_email, "Automation executed",
           f"Rule '{rule.name}' converted 5,000 USDT -> FIDD.", api_key)
```

### The one real decision — where the API key lives

There's no server of ours to hold a secret, so:

1. **One shared provider account** — simplest, but the key ships inside the app
   and can be extracted/abused. Only viable with a **rate-limited,
   domain-restricted** key, and still risky.
2. **Each user supplies their own** (recommended) — an "Email notifications"
   section in Profile where the user enters their address and their own provider
   key (or SMTP credentials). More setup, but secure and abuse-proof for a
   distributed desktop app.

### Even-simpler alternative: SMTP with the user's existing email

No third-party signup — the user generates an app password on Gmail/Outlook and
the backend sends via `smtplib`:

```python
import smtplib
from email.message import EmailMessage

msg = EmailMessage()
msg["From"], msg["To"], msg["Subject"] = user_email, user_email, "Cyrus alert"
msg.set_content(body)
with smtplib.SMTP("smtp.gmail.com", 587) as s:
    s.starttls(); s.login(user_email, app_password); s.send_message(msg)
```

Trade-off: app-password setup friction and weaker deliverability/spam handling
than a transactional API.

### Limitation

Because the sender is the **local** backend, emails only go out **while the app
is running** — fine, since rules only execute while it's running anyway. Alerts
while the app is closed would require a hosted server.

