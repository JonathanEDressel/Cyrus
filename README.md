# Cyrus

A Windows desktop app for automating and monitoring cryptocurrency trading across multiple exchanges. Electron + TypeScript frontend, local Python Flask backend, SQLite storage. Your API keys never leave your machine.

---

## Supported Exchanges

Cyrus talks to exchanges through [CCXT](https://github.com/ccxt/ccxt). Capabilities differ per exchange, and that determines which automations are available.

| Feature | Kraken | Coinbase Advanced | Binance | Robinhood |
|---|:---:|:---:|:---:|:---:|
| View open orders | ✅ | ✅ | ✅ | 🧪 |
| View account balances | ✅ | ✅ | ✅ | 🧪 |
| Portfolio valuation & charts | ✅ | ✅ | ✅ | 🧪 |
| Trigger: Order filled | ✅ | ✅ | ✅ | 🧪 |
| Trigger: Balance threshold | ✅ | ✅ | ✅ | 🧪 |
| Trigger: Price threshold | ✅ | ✅ | ✅ | 🧪 |
| Action: Convert crypto | ✅ | ✅ | ✅ | 🧪 |
| Action: Withdraw to address | ✅ | ❌ | ❌ | ❌ |
| Whitelisted withdrawal addresses | ✅ | ❌ | ❌ | ❌ |

✅ supported · ❌ not available · 🧪 experimental

> **Withdrawals are Kraken-only.** Coinbase Advanced and Binance don't expose a withdrawal address book or crypto withdrawal endpoint through CCXT, so any withdraw-based rule is unavailable there. Convert actions work everywhere.
>
> **Coinbase Advanced (Beta)** — served through CCXT's `coinbase` class (the Advanced Trade API). Connect with keys from Coinbase Advanced, not the standard app.
>
> **Binance (Beta)** — no withdrawal whitelist API via CCXT.
>
> **Robinhood (Experimental)** — uses a direct API adapter rather than CCXT and is still in progress. Treat it as unfinished.

Capability flags live in `src/backend/helper/ExchangeRegistry.py` and are enforced in code — the automation wizard flags unsupported combinations as you build a rule, and the backend rejects them on save regardless.

---

## Features

**Automation**
- Three trigger types — an order fills, a balance crosses a threshold, or a price hits a target
- Two actions — convert one asset into another, or withdraw to a whitelisted address
- Per-rule cooldowns and optional execution limits (auto-pauses when reached)
- Three-step creation wizard with starter templates and a plain-English summary before you commit
- Execution log recording every outcome: success, error, or skipped — with the reason
- Flow chart view showing where your automations move funds

**Monitoring**
- Portfolio overview with value history charts
- Open orders across every connected exchange
- Watchlist with price data
- Optional monthly email report
- Desktop notifications and optional email alerts when a rule executes

**Reliability**
- Live engine heartbeat on the Automations page — shows when rules were last checked, so a stalled worker can't hide
- Runs in the system tray; closing the window keeps automations going
- Optional start-at-login
- Rotating log file at `%APPDATA%\Cyrus\logs\cyrus.log`

**Security**
- Exchange API keys Fernet-encrypted at rest
- Backend binds to loopback only; nothing is sent to a third-party server
- Light and dark themes

---

## How automations work

A rule is a **trigger** plus an **action**, scoped to one exchange connection.

A background worker thread inside the backend wakes every 60 seconds and, for each active rule, checks whether the trigger is satisfied. If it is, the rule is marked as triggered *before* the action runs (so a slow exchange call can't cause a double-fire), the action executes, and the outcome is written to the execution log.

Rules only run while Cyrus is running. Closing the window keeps it alive in the tray; quitting from the tray stops everything. The heartbeat indicator on the Automations page tells you which state you're actually in — if it says anything other than *Automations running*, nothing is being evaluated.

Every non-execution is logged too — below threshold, below the exchange's minimum withdrawal, cooling down — so "nothing happened" always has a visible reason.

---

## Tech Stack

**Frontend** — Electron, TypeScript, vanilla JS/HTML/CSS (no framework, no bundler)
**Backend** — Python 3.11+, Flask, SQLite, CCXT

---

## Prerequisites

- **Node.js** v18+ — [download](https://nodejs.org/)
- **Python** 3.11+ — [download](https://www.python.org/downloads/)
- **Git** — [download](https://git-scm.com/)

SQLite ships with Python; there's no separate database to install.

---

## Install (end users)

1. Click **Releases** on the right of this page
2. Download `Cyrus.Setup.X.X.X.exe`
3. Run it and follow the installer

---

## Install (from source)

### 1. Clone

```bash
git clone <repository-url>
cd Cyrus
```

### 2. Backend

```bash
cd src/backend

# Windows
python -m venv venv
venv\Scripts\activate

# macOS/Linux
python3 -m venv venv
source venv/bin/activate

pip install -r requirements.txt
pip install pyinstaller     # needed later to build the installer
```

> Install PyInstaller **inside the Cyrus venv**, not globally — otherwise it won't resolve `ccxt` and friends when you build.

Start it:

```bash
python Server.py
```

You should see:

```
[DATABASE] Tables created/verified successfully
CYRUS_PORT=5000
```

That `CYRUS_PORT=` line is not cosmetic — Electron parses it from stdout to find the backend. Don't change its format.

### 3. Frontend

In a **second terminal**, from the repo root:

```bash
npm install
npm run build      # or: npm run watch
```

---

## Running in development

Development needs **two terminals**. `npm start` does *not* start the backend — in dev, Electron assumes you launched it yourself on port 5000.

**Terminal 1 — backend**
```bash
cd src/backend
venv\Scripts\activate      # macOS/Linux: source venv/bin/activate
python Server.py
```

**Terminal 2 — frontend**
```bash
npm start                  # or: npm run dev
```

### Environment variables

Optional `.env` in the repo root:

```env
SECRET_KEY=change-this-to-a-random-secret-key-min-32-chars
API_PORT=5000

# Optional. Defaults to src/backend/kraking.db in dev,
# %APPDATA%\Cyrus\kraking.db when packaged.
DATABASE_PATH=kraking.db

# Optional. Seconds between automation checks (default 60, clamped 10-3600).
CYRUS_POLL_INTERVAL=60
```

`CYRUS_PARENT_PID` is set automatically by Electron — the backend watches that process and exits when it does, so a crashed app can't leave an orphaned server holding port 5000.

> **Changing `SECRET_KEY` invalidates every stored exchange key and every issued token.** The encryption key is derived from it. Set it once, then leave it alone.

### Notes for contributors

- **There is no test suite and no linter.** To sanity-check backend edits: `venv\Scripts\python.exe -m py_compile <files...>`. For the frontend, `npm run build` succeeding is the bar.
- **The frontend has no module system at runtime.** TypeScript compiles per-file, but files load as plain `<script>` tags, so everything is global. Do **not** add `import`/`export` to anything under `src/app/`.
- **New services/controllers need a `<script>` tag** in `src/index.html`, placed after their dependencies. Forgetting this is the most common "why is my new code undefined" bug. Viewmodels are the exception — the router loads those.
- **Schema changes** go in `helper/MigrateDatabase.py` as idempotent migrations, not `SetupDatabase.py`, so existing installs upgrade cleanly.
- Flask debug mode is **not** enabled and there is no auto-reload. Restart the backend after Python changes.

---

## First-time usage

1. **Create an account** — click *Create Account*, pick a username (3+ chars) and password (6+ chars)
2. **Connect an exchange** — *Profile → Exchange Connections*, add your API key and secret, then *Test* to validate
3. **Look around** — *Overview* for portfolio, *Open Orders* for live orders
4. **Create an automation** — *Automations → New Automation*, pick a trigger and action, review, save
5. **Check the heartbeat** — the pill at the top of the Automations page should read *Automations running*

### API key permissions

Grant the minimum your rules need. Convert actions need trade permission; withdraw actions additionally need withdraw permission **and** the destination address must already be whitelisted on the exchange. Cyrus cannot add addresses to a whitelist — it can only send to entries that already exist.

---

## Project structure

```
Cyrus/
├── src/
│   ├── index.html                     # Shell; hand-loads every script in order
│   ├── main.ts                        # Electron main: backend spawn, tray, IPC
│   ├── preload.ts                     # contextBridge -> window.cyrus
│   ├── app/
│   │   ├── app.ts                     # Route registration, startup
│   │   ├── router.ts                  # SPA routing
│   │   ├── services/                  # API clients + shared state
│   │   │   ├── dataaccess.ts          # The only fetch wrapper
│   │   │   ├── exchangestore.ts       # Selected connection + polling
│   │   │   ├── ruleflow.ts            # Automation flow chart
│   │   │   └── controllers/           # Auth, profile, business logic
│   │   ├── viewmodels/                # One per route
│   │   ├── views/                     # HTML partials
│   │   └── styles/                    # Per-view CSS
│   ├── backend/
│   │   ├── Server.py                  # Entry point, port binding, logging
│   │   ├── Routes.py                  # Blueprint + /api/health registration
│   │   ├── controllers/               # XController.py + XDbContext.py per domain
│   │   ├── helper/
│   │   │   ├── ExchangeClient.py      # CCXT operations
│   │   │   ├── ExchangeRegistry.py    # Capability flags, withdrawal minimums
│   │   │   ├── Security.py            # Fernet, bcrypt, JWT
│   │   │   ├── SetupDatabase.py       # Initial schema
│   │   │   ├── MigrateDatabase.py     # Idempotent migrations (run on boot)
│   │   │   ├── Logging.py             # Rotating file log + stdout redirect
│   │   │   ├── ProcessWatchdog.py     # Exit when Electron does
│   │   │   ├── notifier.py            # Execution emails
│   │   │   └── robinhood/             # Direct API adapter (experimental)
│   │   ├── automation/
│   │   │   ├── worker.py              # Rule evaluation loop + heartbeat
│   │   │   └── portfolio_snapshots.py # Daily portfolio valuation
│   │   └── models/                    # Data classes
│   └── assets/
├── dist/                              # Compiled TypeScript (git-ignored)
├── LICENSE
└── package.json
```

---

## Building the Windows installer

```bash
# 1. Compile TypeScript
npm run build

# 2. Build the backend executable (from the Cyrus venv)
cd src/backend
venv\Scripts\activate
pyinstaller server.spec
deactivate
cd ../..

# 3. Bump the version
npm version X.X.X

# 4. Build the installer -> release/Cyrus Setup X.X.X.exe
npm run dist

# 5. Publish
gh release create vX.X.X "release/Cyrus Setup X.X.X.exe" --title "vX.X.X" --notes "Your notes"
```

Step 2 must run before step 4 — `build.extraResources` copies `src/backend/dist/CyrusServer.exe` into the installer. Always use the venv's own `pyinstaller` so it resolves `ccxt`.

### What ships

A self-contained installer: the Electron app, the compiled Flask backend, and all dependencies. End users need neither Python nor Node.

On first launch Electron starts the bundled backend, which creates its database at `%APPDATA%\Cyrus\kraking.db` and logs to `%APPDATA%\Cyrus\logs\cyrus.log`. Neither is removed by uninstalling or updating.

Closing the window minimises to the tray so automations keep running; quitting from the tray stops the backend too.

### Code signing

Unsigned builds trigger a "Windows protected your PC" SmartScreen warning on first install (users can click *More info → Run anyway*). A code signing certificate removes it.

---

## Troubleshooting

### Automations aren't running

Check the heartbeat pill at the top of the Automations page first — it tells you which of these you're in.

| Indicator | Meaning | Fix |
|---|---|---|
| **Automations running** | Engine is healthy | Rules are being checked; see below |
| **Automations delayed** | Behind schedule | Usually exchange rate limiting; wait a cycle |
| **Automations STOPPED** / **NOT running** | Engine isn't checking anything | Restart Cyrus |
| **last check errored** | Cycling but failing | Hover for the error; check `logs\cyrus.log` |

If the engine is running but a specific rule never fires, open the **Log** tab — every skip is recorded with its reason. The most common causes:

- **Balance below threshold** — the rule is armed and waiting; nothing is wrong
- **Below the minimum withdrawal** — the trigger fired but the amount is under the exchange's minimum (Kraken's minimums, plus a 10% buffer, are in `ExchangeRegistry.py`). Raise the rule's threshold above that minimum
- **Cooldown active** — waiting out the interval since the last run
- **Rule auto-paused** — it hit its execution limit. Resuming won't help until you raise or clear the limit, or it will pause itself again

### Backend

**`ModuleNotFoundError: No module named 'flask'`** — activate the venv, then `pip install -r requirements.txt`.

**Port 5000 already in use** — the backend falls back to an OS-assigned port automatically and reports it via `CYRUS_PORT=`. If a previous `CyrusServer.exe` is still holding the port, packaged builds now clear it on launch; in dev, stop your other backend first.

**Nothing in the console after `CYRUS_PORT=`** — expected when launched by Electron. Output is redirected to `%APPDATA%\Cyrus\logs\cyrus.log` so a full stdout pipe can never block the worker. Running from a terminal keeps console output.

### Frontend

**`tsc is not recognized`** — use `npx tsc`, or `npm install -g typescript`.

**Blank screen** — open DevTools (View → Toggle Developer Tools) and check the console. Verify `dist/` is populated and any new script has a tag in `index.html`.

**"Not authenticated"** — clear localStorage and log in again.

### Database

Located at `%APPDATA%\Cyrus\kraking.db` when packaged, `src/backend/kraking.db` in dev. (Legacy filename — it is not `cyrus.db`.)

**Locked / permission errors** — make sure only one backend is running, and that antivirus isn't holding the file.

**Reset** — stop the backend, delete `kraking.db`, restart. A fresh database is created on boot. This deletes all accounts, connections, and rules.

---

## API endpoints

All routes require `Authorization: Bearer <token>` except `/api/health` and the auth endpoints.

### Health
- `GET /api/health` — backend + automation worker liveness (unauthenticated; loopback only)

### Authentication
- `POST /api/auth/register` · `POST /api/auth/login`
- `GET /api/auth/accounts` · `PUT /api/auth/accounts/<id>/toggle-active`

### User
- `GET /api/user/profile` · `DELETE /api/user/delete`
- `PUT /api/user/update-username` · `update-password` · `update-theme`
- `PUT /api/user/update-notifications` · `update-email-notifications` · `update-donation-modal`
- `POST /api/user/test-email`

### Exchange connections
- `GET /api/exchanges/supported` — capability flags per exchange
- `GET|POST /api/exchanges/connections`
- `PUT|DELETE /api/exchanges/connections/<id>`
- `POST /api/exchanges/connections/<id>/validate`

### Exchange data
- `GET /api/exchange/<id>/open-orders` · `/balance` · `/withdrawal-addresses` · `/portfolio`
- `GET /api/exchange/portfolio/history`

### Automation
- `GET|POST /api/automation/rules`
- `GET|PUT|DELETE /api/automation/rules/<id>`
- `PUT /api/automation/rules/<id>/toggle`
- `GET /api/automation/rules/<id>/logs` · `GET /api/automation/logs`
- `GET /api/automation/withdrawal-minimums`
- `GET /api/automation/worker-status` — engine heartbeat

### Market data
- `GET /api/market/pairs` · `/ohlcv` · `/ticker`

### Watchlist
- `GET|POST /api/watchlist` · `PUT /api/watchlist/order` · `DELETE /api/watchlist/<symbol>`

### Reports
- `GET /api/report/monthly/status` · `POST /api/report/monthly/send`

---

## Security notes

- **Exchange API keys are Fernet-encrypted** (AES-128) at rest. The key is derived via SHA-256 from the Flask `SECRET_KEY`; keys are decrypted only when making an exchange call.
- **Passwords** are bcrypt-hashed. **JWTs** expire after 30 days.
- **All SQL is parameterised.**
- **The backend binds to `127.0.0.1` only** — it is never reachable from the network. Note that CORS is currently permissive (`origins: "*"`) for `/api/*`; every endpoint except `/api/health` still requires a valid token, and the renderer's CSP restricts it to `connect-src 'self' http://127.0.0.1:*`.
- **Electron runs with `contextIsolation: true` and `nodeIntegration: false`.** The renderer only receives what `preload.ts` exposes on `window.cyrus`. Add privileged capabilities via `ipcMain.handle` + a preload bridge method — never by enabling node integration.
- **Keep `.env` out of version control.**

---

## Contributing

1. Fork, branch, commit, push, open a PR.
2. Read the *Notes for contributors* above first — the no-module-system and script-tag constraints trip up most first patches.

> **Note on copyright:** contributions are welcome, but by opening a PR you agree your contribution may be relicensed by the project owner, including under commercial terms.

---

## License

Cyrus is **source-available**, under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)
plus two additional conditions. See [LICENSE](LICENSE) for the binding terms —
this summary is not a substitute for reading it.

**You may:**
- Clone, read, run, and modify Cyrus for any noncommercial purpose — personal use,
  study, hobby projects, research, or use by a nonprofit, school, or government body.
- Publish your own modified version, and distribute it to others.

**You must:**
- Release any version you distribute under these same terms, with the complete
  source code available free of charge. No binary-only or closed forks, and no
  distributing it as a hosted service without the source.
- Keep the copyright notice and a copy of the LICENSE file with any copy you pass on.

**You may not:**
- Sell Cyrus, charge for access to it, or use it commercially. That includes
  paid forks, paid hosting, and use inside a for-profit business.

**Liability:** Cyrus is provided as is, with no warranty of any kind. It can place
orders and withdraw funds automatically, and those actions are generally
irreversible. You are solely responsible for how you configure and run it and for
everything that results. Nothing here is financial advice.

> Note: this is deliberately *not* an OSI-approved open source license — those
> require permitting commercial use. Cyrus is free to use and modify, but not to sell.

Commercial licensing is available separately: contact the author.

Third-party dependencies keep their own licenses; see the end of [LICENSE](LICENSE).

---

## Sponsors & Support

Cyrus is free for noncommercial use. If it saves you time, these help keep it going.

### Partners

Affiliate links — they cost you nothing extra. Also available in-app under **Partners**.

| Service | Why | Link |
|---|---|---|
| **Kraken** | The only supported exchange with a withdrawal API, so the only one where auto-withdraw rules work | [Sign up](https://invite.kraken.com/JDNW/mjewpya5) |
| **Coinbase Advanced** | The Coinbase interface Cyrus connects to — convert and price rules | [Sign up](https://advanced.coinbase.com/join/EC99C6S?src=referral-link) |
| **Coinbase** | The standard app, for buying and holding | [Sign up](https://coinbase.com/join/HB7T7JN?src=referral-link) |
| **Tangem** | Hardware wallet in card form — a withdrawal destination you hold the keys to | [Get one](https://tangem.com/invite/366PAR) |
| **NordVPN** | Encrypt your traffic while connected to exchanges | [Get NordVPN](https://go.nordvpn.net/aff_c?offer_id=15&aff_id=143568&url_id=902) |
| **NordPass** | Zero-knowledge vault for API keys and passwords | [Get NordPass](https://go.nordpass.io/aff_c?offer_id=488&aff_id=143568&url_id=9356) |

### Direct donations

**Venmo:** [@JonathanDressel](https://account.venmo.com/u/JonathanDressel)

| Network | Address |
|---|---|
| Bitcoin (BTC) | `32BJw5mpyQ6fuLeiR5yrAAR2H8gerB9GAD` |
| Ethereum (ETH) | `0xc0066CCD708376cF3fA34CF5a3a8eB88AF58c97A` |
| Solana (SOL) | `7vfBGpjZTEZEsKNi1ZdYYBPGq1uFzWvLuV6xRP13tSo9` |
| XRP | `rLHzPsX6oXkzU2qL12kHCH8G8cnZv1rBJh` (Tag: `204756592`) |

---

## Disclaimer

Cyrus places real orders and moves real funds, automatically and without a human present. Those actions are generally irreversible.

Use at your own risk. The author is not responsible for any financial loss, missed execution, or exchange account action resulting from use of this software. Nothing here is financial, investment, tax, or legal advice. Verify trades and balances on your exchange directly. See [LICENSE](LICENSE) for the binding terms.
