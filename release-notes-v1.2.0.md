## What's New in v1.2.0

### ✨ New Features
- **Robinhood support (Beta)** — You can now connect your Robinhood crypto account(s) to Cyrus alongside your other exchanges. Runs on Robinhood's direct crypto API. (Beta — some capabilities like historical candles aren't available from Robinhood, so charts fall back to public market data.)
- **Email notifications on automation execution** — Cyrus can now email you whenever an automation fires, including the trigger that matched, the action it took, and the result. Set it up on the Profile page: toggle notifications on, enter your email address and SMTP details (host, port, app password), and send a test email to confirm it's working.
- **Monthly portfolio report emails** — Get an automated monthly email summarizing your portfolio. Cyrus records daily portfolio snapshots in the background and sends the report automatically once a new month's report is due. A **Send Test Report** button on the Profile page lets you preview it on demand.
- **Supported Automations by Exchange table** — A new reference table in the automation builder shows at a glance which automation types each connected exchange supports, so you know what's available before you build a rule.
- **Demo mode** — A hidden showcase toggle (Ctrl+Shift+double-click the sidebar logo) swaps in one internally-consistent set of sample data across every page — balances, open orders, automations, execution log, watchlist, and charts all line up — for clean screenshots and demos without touching your real accounts. Toggle again to restore live data.

### 🛠 Improvements
- **Email & SMTP settings on the Profile page** — A new settings section for your notification email, SMTP host/port, and app password. Credentials are stored securely; once saved, the password field shows "Saved — leave blank to keep" so you never have to re-enter it.

### 🐛 Bug Fixes
- **Backend port 5000 already in use** — If port 5000 is taken, Cyrus now detects it up front and falls back to an OS-assigned free port instead of the backend silently exiting. The frontend reads the actual port so it always connects.
- **Backend build script** — Fixed the `build:backend` script to use `Server.py` as the PyInstaller entry point so packaged builds start the backend correctly.
