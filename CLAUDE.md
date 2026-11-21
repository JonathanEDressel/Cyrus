# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Cyrus is a desktop app (Windows and macOS) for automating crypto trades/transfers across exchanges (Kraken, Coinbase Advanced, Binance, Gemini, OKX, KuCoin, Crypto.com Exchange, Gate.io; Robinhood via a direct adapter) via [CCXT](https://github.com/ccxt/ccxt). It is an **Electron frontend (TypeScript, no framework, no bundler)** talking over HTTP to a **local Python Flask backend** backed by **SQLite**. In a packaged install the Electron main process spawns the backend as a bundled PyInstaller binary (`CyrusServer.exe` on Windows, `CyrusServer/CyrusServer` folder build on macOS); in dev you run the two halves in separate terminals.

## Commands

Frontend (run from repo root):
- `npm run build` — compile TypeScript (`tsc`) from `src/` to `dist/`.
- `npm run watch` — recompile on change. Use this while developing the frontend.
- `npm start` — `npm run build` then launch Electron. **Does not start the backend** (see below).
- `npm run dev` — same, with `--dev` flag.
- `npm run start:all` — starts the backend (`src/backend/venv`, falling back to the root `venv`), compiles, waits for port 5000, then launches Electron, all in one terminal (`scripts/dev.js`). Quitting Electron or Ctrl+C stops both. If port 5000 is already in use, it assumes that's a backend you started yourself and launches only the frontend.

Backend (run from `src/backend/`, with the venv activated):
- `python Server.py` — start Flask + the automation worker. Prints `CYRUS_PORT=<n>` once bound.
- Setup: `python -m venv venv && venv\Scripts\activate && pip install -r requirements.txt`

**Running the app in dev**: `npm run start:all` does everything in one terminal. To do it by hand you need two terminals: terminal 1 runs `python Server.py` in `src/backend/`, terminal 2 runs `npm start` at the root. Electron's `startBackend()` is a no-op in dev (`app.isPackaged` is false) — it assumes you launched the backend yourself on port 5000.

There is **no test suite** and **no linter configured**. To sanity-check backend edits, byte-compile the touched files: `venv\Scripts\python.exe -m py_compile <files...>`. There is no equivalent for the frontend beyond `tsc` succeeding.

### Building the installers
Windows is built locally; macOS is built in CI.
1. `npm run build`
2. In `src/backend/`: `..\..\venv\Scripts\python.exe -m PyInstaller server.spec --noconfirm` (produces `src/backend/dist/CyrusServer.exe`). Use `python -m PyInstaller` from the venv, **not** `venv\Scripts\pyinstaller.exe` — that launcher points at a stale interpreter without `anthropic`. `server.spec` (tracked, portable) aborts if a required package is missing.
3. `npm version X.X.X`
4. `npm run dist` (electron-builder → `release/Cyrus-Setup-X.X.X.exe`, plus `latest.yml` and `Cyrus-Setup-X.X.X.exe.blockmap` for auto-update; it never publishes by itself). Its `predist` hook runs `scripts/bundle-tutorials.js`, which copies the tutorial videos from `../Cyrus-Landing/tutorials` (or `$CYRUS_TUTORIALS`) into the git-ignored `src/tutorials/`; it fails if they aren't there, so the installer never ships without them.
5. `git push --follow-tags`, then `gh release create vX.X.X release/Cyrus-Setup-X.X.X.exe release/Cyrus-Setup-X.X.X.exe.blockmap release/latest.yml --title "vX.X.X" --notes-file release-notes-vX.X.X.md`. **All three files are required**: installed Windows copies read `latest.yml` to update themselves in-app, and the installer's name must match the one inside it (hence the dash-separated `win.artifactName`). Update the landing page's download links to the new file names.

`package.json` `build.win.extraResources` copies `CyrusServer.exe` into the installer, so step 2 must run before step 4.

On Windows the same `afterPack` hook runs `scripts/win-exe-resources.js`, which stamps `src/assets/icon.ico` and the version details into `Cyrus.exe` with `rcedit`. electron-builder would do this itself only with `win.signAndEditExecutable` on, which needs its winCodeSign toolkit — and that archive won't unpack on Windows without admin rights or Developer Mode (it contains symlinks). Without the hook, the exe and every shortcut show Electron's default icon.

**macOS** is built by `.github/workflows/mac-release.yml`, triggered by publishing the release in step 5 (or by hand from the Actions tab). On `macos-15` (arm64) and `macos-15-intel` (x64) runners it builds the backend from the same `server.spec` (folder build on darwin), bundles the tutorial videos from a shallow clone of the public Cyrus-Landing repo, packages a `.dmg` per arch (`build.mac`), smoke-tests the backend and the packaged app, and uploads `Cyrus-X.X.X-<arch>.dmg` to the release. Builds are ad-hoc signed by the `afterPack` hook (`scripts/after-pack.js` → `scripts/mac-adhoc-sign.js`) (no Apple Developer ID yet), so users approve the first open via System Settings → Privacy & Security → Open Anyway.

## Frontend architecture — read this before editing `src/app/`

**There is no module system at runtime.** TypeScript is compiled per-file to CommonJS but loaded in the browser as plain `<script>` tags. This has consequences you must respect:

- **Everything is global.** A class/const in one `.ts` file is directly referenceable from another (e.g. `AppConfig`, `AuthController`, `router`, `DataAccess` are all globals). Do **not** add `import`/`export` statements to files under `src/app/` — that would break the global sharing the code relies on.
- **`src/index.html` hand-loads every script in dependency order** (bottom of the file). When you add a new service/controller under `src/app/`, you must add a corresponding `<script src="../dist/...">` tag in `index.html`, placed after anything it depends on. Forgetting this is the most common "why is my new code undefined" bug.
- Third-party libs (`lightweight-charts`, `html-to-image`) are loaded from `node_modules` via `<script>` in `<head>` and used as globals too.

**Routing** (`src/app/router.ts`, routes registered in `src/app/app.ts`): a single global `router`. `navigate(name)` fetches an HTML partial from `src/app/views/`, injects it into `#app-content`, then appends the route's view-model script from `dist/`. Route params are passed via `window.__routeParams` (there is no query-string routing). `app.ts` is the entry point — it awaits `AppConfig.init()`, registers all routes, restores auth/theme/exchange state, and navigates to the landing route.

**Layers under `src/app/`:**
- `services/dataaccess.ts` — the only `fetch` wrapper (`DataAccess.get/post/put/del`). Unwraps the `{ success, result, data }` envelope and throws `result` on non-2xx.
- `services/*data.ts` (`authdata`, `userdata`, `exchangedata`, `automationdata`, …) — thin per-domain API clients built on `DataAccess`.
- `services/controllers/*controller.ts` — business logic / state (auth token handling, profile, etc.).
- `services/exchangestore.ts` — global store for the selected exchange connection + polling; the sidebar exchange selector drives it.
- `viewmodels/**` — one per route; wires a rendered view's DOM to controllers/services.
- `views/**` — static HTML partials. `styles/**` — per-view CSS, loaded lazily by the router.

## Backend architecture — `src/backend/`

**Entry point** `Server.py` → `create_app()`: sets up CORS, runs `setup_database()` + migrations, registers blueprints (`Routes.py`), then `start_worker(app)`. It serves via `werkzeug.serving.make_server` (not `app.run`) because make_server calls `sys.exit(1)` on a bind failure; the code probes port availability first and falls back to an OS-assigned port (`0`) if the requested one is taken.

**Blueprint-per-domain.** `Routes.py` mounts one blueprint per controller under `/api/<domain>`: `auth`, `user`, `exchanges`, `exchange`, `automation`, `watchlist`, `market`, `report`.

**Controller / DbContext split** (the dominant pattern — mirror it for new endpoints):
- `controllers/XController.py` — Flask routes. Parse/validate request, call the DbContext and/or exchange helpers, return via `success_response` / `created_response` / `bad_request` / `not_found` / `handle_error` from `helper/`.
- `controllers/XDbContext.py` — all SQL for that domain, as `@staticmethod`s using the `execute_query_one/all`, `execute_insert`, `execute_non_query`, `execute_scalar` helpers in `helper/Helper.py`. **Always parameterized SQL** (`?` placeholders); each helper opens and closes its own connection. Rows come back as dicts.
- Data classes live in `models/` (`UserModel`, `AutomationModel`) with `from_row` / `to_dict`.

**Exchange access** goes through `helper/`:
- `ExchangeRegistry.py` — `SUPPORTED_EXCHANGES` metadata (capability flags like `supports_withdraw`), `get_user_exchange(user_id, conn_id)` (builds a CCXT client from stored+decrypted keys), minimum-withdrawal lookups.
- `ExchangeClient.py` — thin CCXT operations: `get_open_orders`, `get_closed_orders`, `get_balance`, `withdraw`, `convert`, `get_market_price`.
- Capability differences between exchanges are enforced in code (e.g. withdraw is Kraken-only); check the `supports_*` flags before acting rather than assuming.
- **Per-exchange ccxt quirks** live in the registry (`ccxt_options`, passed to `create_exchange`) and in `ExchangeClient`: quote-sized market buys use `create_market_buy_order_with_cost` on Coinbase/OKX/KuCoin/Gate, `cost` on Kraken, a hand-built `notional` order on Crypto.com (ccxt's create_order drops `cost` there), `quoteOrderQty` elsewhere. KuCoin "HF" accounts can't list open orders across markets, so `get_open_orders` asks `hf/orders/active/symbols` and goes market by market. Gate loads spot markets only. KuCoin has no trade/transfer history yet (`supports_*_history: False`). Bybit was considered and dropped: its API blocks US connections.
- Gemini has no market orders and no closed-orders list in ccxt: `convert()` routes it through `_ioc_convert` (immediate-or-cancel limit at `IOC_CONVERT_SLIPPAGE`), and `get_closed_orders(order_id=...)` falls back to `fetch_order`. Its transfers come from one combined feed (`transfer_history.source = 'combined'`) and its fills are walked per market by timestamp (`trade_history.paging = 'timestamp'`).

**Automation worker** `automation/worker.py` — a daemon thread started with the app, polling every `POLL_INTERVAL = 60`s. Per active user it evaluates three trigger types — `order_filled` (via open/closed-order snapshot diffing stored in the DB), `balance_threshold`, `price_threshold` — and runs the `withdraw` or `convert_crypto` action. Key invariants when editing: it calls `mark_rule_triggered` **before** executing to prevent double-fires, writes a row to the automation log for every outcome (`success`/`error`/`skipped`), honors per-rule cooldowns and `max_executions`, and treats CCXT rate-limit / unavailable errors as retry-next-cycle. Execution can optionally send an email (`_notify_execution` → `helper/notifier.py`), which is fully best-effort and never allowed to break rule execution.

The same loop also sends the **monthly report** email (`_send_due_reports` → `helper/monthly_report.py`), so it goes out when the month turns over rather than when someone next opens the app. The due check is "has this period ever been sent" (`report_sends`), not "is it the 1st", so a boundary missed while Cyrus was closed is caught up on the next start; failures back off for `REPORT_RETRY_SECONDS`. The report is composed entirely server-side from the DB + exchanges — the client sends no report content, and `ReportController` only exposes the status endpoint and the Profile page's test send.

## Cross-cutting things that bite

- **The SQLite file is `kraking.db`, not `cyrus.db`** (legacy name; the README says cyrus.db but the code doesn't). In a packaged install it lives in Electron's `userData` folder — `%APPDATA%\Cyrus\kraking.db` on Windows, `~/Library/Application Support/Cyrus/kraking.db` on macOS; in dev it defaults to `src/backend/kraking.db`. Path comes from `DATABASE_PATH`.
- **Dynamic backend port.** The backend may not be on 5000 (it falls back to an OS port if 5000 is taken). It prints `CYRUS_PORT=<n>`; `main.ts` parses that line from stdout and exposes it over the `get-backend-port` IPC channel; the renderer's `AppConfig.init()` resolves `API_BASE` from it before any request. Keep the `CYRUS_PORT=` stdout format stable, and don't hardcode `:5000` in new frontend code — use `AppConfig.API_BASE`.
- **Electron security model:** `contextIsolation: true`, `nodeIntegration: false`. The renderer only gets what `preload.ts` exposes on `window.cyrus` (`getBackendPort`, `captureRegion`). Add new privileged capabilities by adding an `ipcMain.handle` in `main.ts` and a matching bridge method in `preload.ts` — never by enabling node integration.
- **Encrypted database:** the SQLite file is SQLCipher (AES-256). Every connection must go through `helper/DbCrypto.connect` (`get_db_connection` does) — a plain `sqlite3.connect` gets "file is not a database". `ensure_encrypted` converts an older plain file at startup. `CYRUS_DB_ENCRYPTION=off` keeps a new dev database plain (ignored when frozen).
- **`SECRET_KEY` is per install in packaged builds:** `loadSecretKey` in `main.ts` makes 32 random bytes on first run, stored in `userData/cyrus-secret.json` encrypted with Electron `safeStorage` (DPAPI / Keychain). It's never regenerated if it can't be unlocked (that would lock the database); a database with a different key makes the backend exit 3 with `CYRUS_DB_LOCKED`, and `main.ts` offers Quit / Start Fresh. `CYRUS_LEGACY_SECRET_KEYS` lists the pre-1.5 shared placeholder so `helper/SecretRekey.py` re-encrypts stored secrets and fingerprints on upgrade. Dev uses `.env` `SECRET_KEY`.
- **API key encryption:** exchange keys are also Fernet-encrypted with a key derived (SHA-256) from `SECRET_KEY`. `helper/Security.py` also holds password hashing (bcrypt) and JWT. Changing `SECRET_KEY` invalidates all stored exchange keys and issued tokens, and locks the database.
- **Schema changes** go through `helper/MigrateDatabase.py` (`run_migrations` / `run_column_migrations`), which run on every startup — add idempotent migrations there rather than editing `SetupDatabase.py` for existing installs.
- **In-app tutorial videos** (`services/tutorials.ts`, `styles/tutorials.css`): each page header has a `.tut-launch` button whose `data-tutorial` names the video id(s); it opens a docked drawer that shares the Assistant's slot (opening one closes the other). The videos are recorded by `tools/tutorials`, published to the landing repo by its `publish.js` (which also writes `manifest.json`), and bundled into the app at build time; `build.asarUnpack` keeps the `.mp4`s outside the asar so they stream and seek. With no `src/tutorials/manifest.json` (a fresh checkout) the buttons simply stay hidden. Re-record a page's video when that page changes.
- `capture-region` IPC + `html-to-image` exist to snapshot on-screen charts for the monthly report, but are **currently parked**: the report email contains no chart images, and the capture helpers in `services/monthlyreport.ts` have no caller. They're kept because they're the working half of putting chart images back — note that they only work while a window is open, whereas the report itself is now sent by the backend worker.
- **App updates**: `src/updater.ts` (main) checks `api.github.com/repos/JonathanEDressel/Cyrus/releases/latest` 15 s after launch and every 6 h, and pushes an `update-state` to the renderer; `services/updatenotice.ts` shows the modal (once per version; "Later" is remembered) and the top-bar Update pill. Packaged Windows builds download and install in-app through `electron-updater` (`build.publish` → GitHub; it needs `latest.yml` on the release, else the modal falls back to a download link). macOS is notify-only — the button opens this Mac's `.dmg` — because in-place updates need a Developer ID signature. Draft and pre-release releases are ignored, and a Mac isn't told about a release until its `.dmg` is attached.
- **Usage stats (opt-in)**: `src/usagestats.ts` (main) sends an anonymous heartbeat — random install id, version, OS/arch, window open vs tray, signed in — to a write-only collector (Cloudflare Worker; it also stores the request's country, never the IP), only after the user agrees (prompt after first sign-in, `services/usagestats.ts`; toggle on Profile → Account). Consent and the id live in `userData/usage-stats.json`; opting out sends `optout` (server deletes the rows) and discards the id. It's inert while `PRODUCTION_URL` is empty, and unpackaged builds only report to `CYRUS_USAGE_URL`. The collector and its local-only dashboard are deliberately kept out of this public repo: they live in `tools/usage-stats/`, excluded via `.git/info/exclude`, so never `git add -f` them. If you change what's sent, update the Privacy page and `UsageStats.SENT` with it.
- **Platform differences live in `src/main.ts`** (`IS_MAC`): backend path, stale-process sweep (`taskkill` vs `pkill`), tray icon (`icon.ico` vs `trayTemplate.png` menu-bar template), balloon vs `Notification`, login item, the Dock `activate` handler, and an app menu on macOS (its Edit menu is what makes ⌘C/⌘V work). The renderer can read `window.cyrus.platform` (e.g. ⌘K vs Ctrl K hints). The frozen backend on macOS points `SSL_CERT_FILE` at certifi (`Server.py`). Keep Electron at ≥ 38.2: older builds cause system-wide lag on macOS 26.
- `.env` (git-ignored) holds `SECRET_KEY`, `API_PORT`, optional `DATABASE_PATH`.
