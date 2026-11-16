/**
 * Opt-in anonymous usage stats (main process).
 *
 * Off until the user says yes: on first sign-in the renderer asks
 * (services/usagestats.ts), and the answer can be changed any time on Profile.
 * The choice is per install, not per account, and lives in
 * userData/usage-stats.json, outside the database.
 *
 * When on, this sends a small heartbeat to the collector when the app starts,
 * on sign-in and sign-out, every HEARTBEAT_MS, and when it quits. Each ping
 * carries exactly:
 *   install_id   a random UUID made when they opt in, unrelated to the account
 *   event        start | heartbeat | login | logout | quit
 *   version      the app version
 *   os, arch     win32/darwin, x64/arm64
 *   window_open  whether the window is on screen (vs. running in the tray)
 *   signed_in    whether someone is signed in
 * Nothing else: no username, email, balances, exchanges, rules or keys. The
 * collector also records the country Cloudflare derives from the connection
 * (never the IP address itself), which the Privacy page discloses.
 *
 * Turning it off sends one last `optout` ping, which deletes this install's rows
 * on the server, then throws the install id away, so a later opt-in starts
 * fresh and can't be linked to the earlier one.
 */

import { app, BrowserWindow, ipcMain, net } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

// The deployed collector. While this is empty the feature is off
// everywhere: no prompt, no toggle, no requests.
const PRODUCTION_URL = 'https://cyrus-usage.cyrusapp.workers.dev/ping';
const HEARTBEAT_MS = 5 * 60 * 1000;
const FIRST_PING_DELAY = 10 * 1000;
const REQUEST_TIMEOUT = 8000;

type Consent = 'granted' | 'declined';
type UsageEvent = 'start' | 'heartbeat' | 'login' | 'logout' | 'quit' | 'optout';

interface Settings {
  consent?: Consent;
  installId?: string;
  decidedAt?: string;
}

export interface UsageState {
  /** A collector is configured for this build. */
  available: boolean;
  /** null until they've answered. */
  consent: Consent | null;
}

let settings: Settings = {};
let signedIn = false;
let timer: NodeJS.Timeout | null = null;
let getWindow: () => BrowserWindow | null = () => null;

/**
 * Packaged builds report to production. Dev builds report nowhere unless
 * CYRUS_USAGE_URL points them somewhere (e.g. the local Worker), so
 * development sessions never show up in the real numbers.
 */
function endpoint(): string {
  const override = (process.env.CYRUS_USAGE_URL || '').trim();
  if (override) return override;
  return app.isPackaged ? PRODUCTION_URL : '';
}

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'usage-stats.json');
}

function load(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    settings = raw && typeof raw === 'object' ? raw : {};
  } catch {
    settings = {};
  }
}

function save(): void {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('[USAGE] Could not save settings:', err);
  }
}

function enabled(): boolean {
  return !!endpoint() && settings.consent === 'granted' && !!settings.installId;
}

function windowOpen(): boolean {
  const win = getWindow();
  return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
}

// Pings go out one at a time, in order. Two in flight at once (a start and a
// login a moment apart) could land out of order, and the server keeps
// whichever arrived last, so a stale "signed out" could overwrite a fresh login.
let queue: Promise<void> = Promise.resolve();

function send(event: UsageEvent, installId = settings.installId): Promise<void> {
  // The state is read now, at the moment of the event, not when it's sent.
  const body = buildBody(event, installId);
  const url = endpoint();
  if (!url || !body) return queue;
  queue = queue.then(() => post(url, body));
  return queue;
}

function buildBody(event: UsageEvent, installId: string | undefined): object | null {
  if (!installId) return null;
  if (event === 'optout') return { install_id: installId, event };
  return {
    install_id: installId,
    event,
    version: app.getVersion(),
    os: process.platform,
    arch: process.arch,
    window_open: windowOpen(),
    signed_in: signedIn,
  };
}

async function post(url: string, body: object): Promise<void> {
  try {
    await net.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Cyrus-desktop-app' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
  } catch {
    // Offline or the collector is down: it's only a count, never retry.
  }
}

/** Dev builds can shorten the interval (CYRUS_USAGE_HEARTBEAT_MS) for testing. */
function heartbeatMs(): number {
  const override = Number(process.env.CYRUS_USAGE_HEARTBEAT_MS);
  return !app.isPackaged && override >= 1000 ? override : HEARTBEAT_MS;
}

function startHeartbeat(): void {
  if (timer || !enabled()) return;
  timer = setInterval(() => { if (enabled()) void send('heartbeat'); }, heartbeatMs());
}

function stopHeartbeat(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

function state(): UsageState {
  return { available: !!endpoint(), consent: settings.consent ?? null };
}

async function setConsent(granted: boolean): Promise<UsageState> {
  if (granted) {
    if (!settings.installId) settings.installId = randomUUID();
    settings.consent = 'granted';
    settings.decidedAt = new Date().toISOString();
    save();
    void send('start');
    startHeartbeat();
  } else {
    const previousId = settings.installId;
    stopHeartbeat();
    settings = { consent: 'declined', decidedAt: new Date().toISOString() };
    save();
    // Ask the server to forget this install. Best-effort: if it doesn't
    // arrive, the rows age out with the 90-day retention.
    if (previousId) await send('optout', previousId);
  }
  return state();
}

/** Best-effort goodbye so the live count drops at once rather than timing out. */
export function usageStatsQuit(): void {
  stopHeartbeat();
  if (enabled()) void send('quit');
}

export function initUsageStats(opts: { getWindow: () => BrowserWindow | null }): void {
  getWindow = opts.getWindow;
  load();

  ipcMain.handle('usage-state', () => state());
  ipcMain.handle('usage-set-consent', (_event, granted: unknown) => setConsent(granted === true));
  ipcMain.handle('usage-signed-in', (_event, args: { signedIn?: unknown; fresh?: unknown }) => {
    const next = args?.signedIn === true;
    const changed = next !== signedIn;
    signedIn = next;
    if (changed && enabled()) {
      // A restored session isn't a new login; it just rides on the next ping.
      if (next && args?.fresh === true) void send('login');
      else if (!next) void send('logout');
    }
    return state();
  });

  if (enabled()) {
    setTimeout(() => { if (enabled()) void send('start'); }, FIRST_PING_DELAY);
    startHeartbeat();
  }
}
