/**
 * Update checks (main process).
 *
 * Every platform: shortly after launch and then every few hours, ask GitHub
 * for the latest published release. If it's newer than this build, tell the
 * renderer, which shows the update modal (services/updatenotice.ts).
 *
 * Windows (packaged): "Update now" downloads the new installer in the
 * background with electron-updater (differentially, using the .blockmap, so
 * unchanged parts such as the tutorial videos aren't downloaded again) and
 * "Restart now" installs it silently and relaunches. That needs the release to
 * carry latest.yml and the .blockmap next to the .exe — see CLAUDE.md's release
 * steps. If anything about that fails, the modal falls back to a download link.
 *
 * macOS (and unpacked/dev builds): notify only. Installing in place needs a
 * Developer ID signature; until then the button opens the right .dmg for this
 * Mac in the browser.
 *
 * The request carries nothing about the user: it's an anonymous GET of a
 * public endpoint.
 */

import { app, BrowserWindow, ipcMain, net, shell } from 'electron';

const OWNER = 'JonathanEDressel';
const REPO = 'Cyrus';
const RELEASES_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const FIRST_CHECK_DELAY = 15 * 1000;
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

export type UpdateStatus = 'none' | 'available' | 'downloading' | 'ready';

export interface UpdateState {
  status: UpdateStatus;
  current: string;
  version?: string;
  notes?: string;
  publishedAt?: string;
  /** Browser download for this platform (or the release page). */
  url?: string;
  /** Windows packaged builds download and install in-app. */
  canInstall: boolean;
  percent?: number;
  transferred?: number;
  total?: number;
  error?: string;
}

const CAN_AUTO_INSTALL = process.platform === 'win32' && app.isPackaged;

let state: UpdateState = { status: 'none', current: app.getVersion(), canInstall: CAN_AUTO_INSTALL };
let getWindow: () => BrowserWindow | null = () => null;
let beforeInstall: () => void = () => {};
let updaterBound = false;
let checking = false;

/** [major, minor, patch]; anything unparsable compares as 0. */
function parts(v: string): number[] {
  return v.replace(/^v/i, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
}

function isNewer(candidate: string, current: string): boolean {
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

function setState(next: Partial<UpdateState>): void {
  state = { ...state, ...next, current: app.getVersion() };
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send('update-state', state);
}

interface ReleaseAsset { name: string; browser_download_url: string }

/** The installer this machine needs, or null if the release doesn't have it yet. */
function pickAsset(assets: ReleaseAsset[]): ReleaseAsset | null {
  if (process.platform === 'win32') return assets.find(a => /\.exe$/i.test(a.name)) || null;
  if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    return assets.find(a => a.name.toLowerCase().endsWith(`-${arch}.dmg`)) || null;
  }
  return null;
}

export async function checkForUpdate(): Promise<void> {
  // Mid-download or waiting to restart: nothing new to say.
  if (checking || state.status === 'downloading' || state.status === 'ready') return;
  checking = true;
  try {
    const res = await net.fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Cyrus-desktop-app' },
    });
    if (!res.ok) return;
    const rel = await res.json() as {
      tag_name?: string; body?: string; html_url?: string; published_at?: string;
      draft?: boolean; prerelease?: boolean; assets?: ReleaseAsset[];
    };
    if (rel.draft || rel.prerelease || !rel.tag_name) return;
    const version = rel.tag_name.replace(/^v/i, '');
    if (!isNewer(version, app.getVersion())) {
      if (state.status !== 'none') setState({ status: 'none' });
      return;
    }
    const assets = rel.assets || [];
    // The Mac builds are attached by CI some minutes after the release is
    // published; don't announce an update this Mac can't download yet.
    const asset = pickAsset(assets);
    if (!asset) return;
    const installable = CAN_AUTO_INSTALL && assets.some(a => a.name === 'latest.yml');
    setState({
      status: 'available',
      version,
      notes: (rel.body || '').slice(0, 20000),
      publishedAt: rel.published_at,
      url: asset.browser_download_url,
      canInstall: installable,
      error: undefined,
    });
  } catch {
    // Offline or GitHub unreachable: try again at the next interval.
  } finally {
    checking = false;
  }
}

async function downloadUpdate(): Promise<void> {
  if (!state.canInstall || state.status !== 'available') return;
  setState({ status: 'downloading', percent: 0, transferred: 0, total: undefined, error: undefined });
  try {
    const { autoUpdater } = await import('electron-updater');
    if (!updaterBound) {
      updaterBound = true;
      autoUpdater.autoDownload = false;
      // Downloaded but not yet restarted: install when they next quit.
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on('download-progress', p => setState({
        status: 'downloading', percent: Math.round(p.percent), transferred: p.transferred, total: p.total,
      }));
      autoUpdater.on('update-downloaded', () => setState({ status: 'ready', percent: 100 }));
    }
    const result = await autoUpdater.checkForUpdates();
    if (!result || !isNewer(result.updateInfo.version, app.getVersion())) {
      throw new Error('The release has no installer this version can update to.');
    }
    await autoUpdater.downloadUpdate();
  } catch (err) {
    console.error('[UPDATE] In-app download failed:', err);
    setState({
      status: 'available',
      canInstall: false,
      error: "Cyrus couldn't download the update itself. Download the installer instead — it keeps your settings and data.",
    });
  }
}

async function installUpdate(): Promise<void> {
  if (state.status !== 'ready') return;
  const { autoUpdater } = await import('electron-updater');
  // Let the window close for real (it normally hides to the tray); quitting
  // also stops the backend, so the installer can replace CyrusServer.exe.
  beforeInstall();
  autoUpdater.quitAndInstall(true, true);
}

export function initUpdates(opts: { getWindow: () => BrowserWindow | null; beforeInstall: () => void }): void {
  getWindow = opts.getWindow;
  beforeInstall = opts.beforeInstall;

  ipcMain.handle('update-state', () => state);
  ipcMain.handle('update-check', async () => { await checkForUpdate(); return state; });
  ipcMain.handle('update-download', () => { downloadUpdate(); return state; });
  ipcMain.handle('update-install', () => installUpdate());
  ipcMain.handle('update-open', async () => {
    // Only ever a GitHub release download, never a URL from the renderer.
    const url = state.url;
    if (url && /^https:\/\/github\.com\//.test(url)) await shell.openExternal(url);
  });

  setTimeout(() => { checkForUpdate(); }, FIRST_CHECK_DELAY);
  setInterval(() => { checkForUpdate(); }, CHECK_INTERVAL);
}
