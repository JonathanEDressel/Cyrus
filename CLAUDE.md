# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Cyrus is a Windows desktop app for automating crypto trades/transfers across exchanges (Kraken, Coinbase Advanced, Binance) via [CCXT](https://github.com/ccxt/ccxt). It is an **Electron frontend (TypeScript, no framework, no bundler)** talking over HTTP to a **local Python Flask backend** backed by **SQLite**. In a packaged install the Electron main process spawns the backend as a bundled `.exe`; in dev you run the two halves in separate terminals.

## Commands

Frontend (run from repo root):
- `npm run build` — compile TypeScript (`tsc`) from `src/` to `dist/`.
- `npm run watch` — recompile on change. Use this while developing the frontend.
- `npm start` — `npm run build` then launch Electron. **Does not start the backend** (see below).
- `npm run dev` — same, with `--dev` flag.

Backend (run from `src/backend/`, with the venv activated):
- `python Server.py` — start Flask + the automation worker. Prints `CYRUS_PORT=<n>` once bound.
- Setup: `python -m venv venv && venv\Scripts\activate && pip install -r requirements.txt`

**Running the app in dev requires two terminals**: terminal 1 runs `python Server.py` in `src/backend/`, terminal 2 runs `npm start` at the root. Electron's `startBackend()` is a no-op in dev (`app.isPackaged` is false) — it assumes you launched the backend yourself on port 5000.

There is **no test suite** and **no linter configured**. To sanity-check backend edits, byte-compile the touched files: `venv\Scripts\python.exe -m py_compile <files...>`. There is no equivalent for the frontend beyond `tsc` succeeding.

### Building the Windows installer
1. `npm run build`
2. In `src/backend/` with venv active: `pyinstaller server.spec` (produces `src/backend/dist/CyrusServer.exe`). Always use the venv's own `pyinstaller` so it resolves `ccxt` etc.
3. `npm version X.X.X`
4. `npm run dist` (electron-builder → `release/Cyrus Setup X.X.X.exe`)
5. `gh release create vX.X.X "release/Cyrus Setup X.X.X.exe" --title "vX.X.X" --notes "..."`

`package.json` `build.extraResources` copies `CyrusServer.exe` into the installer, so step 2 must run before step 4.

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

**Automation worker** `automation/worker.py` — a daemon thread started with the app, polling every `POLL_INTERVAL = 60`s. Per active user it evaluates three trigger types — `order_filled` (via open/closed-order snapshot diffing stored in the DB), `balance_threshold`, `price_threshold` — and runs the `withdraw` or `convert_crypto` action. Key invariants when editing: it calls `mark_rule_triggered` **before** executing to prevent double-fires, writes a row to the automation log for every outcome (`success`/`error`/`skipped`), honors per-rule cooldowns and `max_executions`, and treats CCXT rate-limit / unavailable errors as retry-next-cycle. Execution can optionally send an email (`_notify_execution` → `helper/notifier.py`), which is fully best-effort and never allowed to break rule execution.

The same loop also sends the **monthly report** email (`_send_due_reports` → `helper/monthly_report.py`), so it goes out when the month turns over rather than when someone next opens the app. The due check is "has this period ever been sent" (`report_sends`), not "is it the 1st", so a boundary missed while Cyrus was closed is caught up on the next start; failures back off for `REPORT_RETRY_SECONDS`. The report is composed entirely server-side from the DB + exchanges — the client sends no report content, and `ReportController` only exposes the status endpoint and the Profile page's test send.

## Cross-cutting things that bite

- **The SQLite file is `kraking.db`, not `cyrus.db`** (legacy name; the README says cyrus.db but the code doesn't). In a packaged install it lives at `%APPDATA%\Cyrus\kraking.db`; in dev it defaults to `src/backend/kraking.db`. Path comes from `DATABASE_PATH`.
- **Dynamic backend port.** The backend may not be on 5000 (it falls back to an OS port if 5000 is taken). It prints `CYRUS_PORT=<n>`; `main.ts` parses that line from stdout and exposes it over the `get-backend-port` IPC channel; the renderer's `AppConfig.init()` resolves `API_BASE` from it before any request. Keep the `CYRUS_PORT=` stdout format stable, and don't hardcode `:5000` in new frontend code — use `AppConfig.API_BASE`.
- **Electron security model:** `contextIsolation: true`, `nodeIntegration: false`. The renderer only gets what `preload.ts` exposes on `window.cyrus` (`getBackendPort`, `captureRegion`). Add new privileged capabilities by adding an `ipcMain.handle` in `main.ts` and a matching bridge method in `preload.ts` — never by enabling node integration.
- **API key encryption:** exchange keys are Fernet-encrypted at rest with a key derived (SHA-256) from Flask `SECRET_KEY`. `helper/Security.py` also holds password hashing (bcrypt) and JWT. Changing `SECRET_KEY` invalidates all stored exchange keys and issued tokens.
- **Schema changes** go through `helper/MigrateDatabase.py` (`run_migrations` / `run_column_migrations`), which run on every startup — add idempotent migrations there rather than editing `SetupDatabase.py` for existing installs.
- `capture-region` IPC + `html-to-image` exist to snapshot on-screen charts for the monthly report, but are **currently parked**: the report email contains no chart images, and the capture helpers in `services/monthlyreport.ts` have no caller. They're kept because they're the working half of putting chart images back — note that they only work while a window is open, whereas the report itself is now sent by the backend worker.
- `.env` (git-ignored) holds `SECRET_KEY`, `API_PORT`, optional `DATABASE_PATH`.
