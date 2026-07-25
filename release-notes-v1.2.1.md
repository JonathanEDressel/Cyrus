## What's New in v1.2.1

A maintenance release focused on correctness fixes across the automation engine, exchange connections, and the desktop app.

### 🐛 Bug Fixes

- **Coinbase Advanced connections now work** — Coinbase connections were failing to build because of an incorrect internal exchange identifier. Coinbase Advanced (Beta) accounts connect and report balances again.
- **"Use filled amount" withdrawals fixed** — Order-filled rules set to withdraw the *filled amount* now use the confirmed fill from the completed order instead of a stale value, so these rules no longer fail or withdraw an understated amount when an order fills quickly between checks.
- **Automation execution limits are respected** — Order-filled rules could fire more than their configured maximum when several matching orders filled in the same polling cycle. Rules now stop firing as soon as their execution limit is reached.
- **Notification & donation-modal settings survive upgrades** — Upgrading from an older (Kraken-only) install could drop the notification and donation-modal preferences and cause errors when toggling them. These settings are now preserved across the upgrade.
- **Kraken Bitcoin minimum-withdrawal guard** — The built-in minimum-withdrawal safety check now correctly recognizes Bitcoin (BTC) on Kraken, so tiny BTC amounts are caught before a withdrawal is attempted.
- **Year-to-date charts** — The "YTD" chart range now uses a UTC year boundary, fixing an off-by-a-few-hours start point depending on your timezone.
- **Steadier exchange switching** — Switching the selected exchange while data was still loading could briefly show the wrong exchange's orders or mislabel them. The app now discards stale in-flight results.
- **Clearer error messages** — Backend errors that aren't JSON now surface the real status instead of a cryptic parse error, and the automation log view reports load failures instead of hanging on "Loading logs…".
- **Reliability & stability** — Fixed a backend-port startup edge case, a leaked keyboard-shortcut handler on the Automations page, and several smaller crashes on malformed data.
