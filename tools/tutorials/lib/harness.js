// Recording harness for the tutorial videos.
//
// Nothing here touches a real Cyrus install. It starts its OWN backend on a
// free port against a throwaway database, registers a throwaway user, serves
// the compiled frontend from the repo over HTTP, and opens it in headless
// Chrome with demo mode switched on — so every number on screen is the demo
// fixture in src/app/services/demomode.ts, never anyone's real account.
//
// Frames are captured with the DevTools screencast (each frame carries its own
// timestamp), and every narration step records when it started, so the
// assembler can line the voice up with the picture exactly.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');
const overlaySource = require('./overlay');

const REPO = path.resolve(__dirname, '..', '..', '..');
const BACKEND = path.join(REPO, 'src', 'backend');

const VIEWPORT = { width: 1280, height: 800 };
const SCALE = 1.5; // 1920x1200 frames

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.map': 'application/json', '.jpg': 'image/jpeg', '.gif': 'image/gif',
};

async function startStatic() {
  const port = await freePort();
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const file = path.normalize(path.join(REPO, url));
    if (!file.startsWith(REPO)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { port, close: () => new Promise(r => server.close(r)) };
}

async function startBackend(workDir) {
  const port = await freePort();
  const dbPath = path.join(workDir, 'tutorial.db');
  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) fs.rmSync(f, { force: true });
  const python = [path.join(BACKEND, 'venv', 'Scripts', 'python.exe'),
                  path.join(REPO, 'venv', 'Scripts', 'python.exe'),
                  path.join(BACKEND, 'venv', 'bin', 'python')].find(p => fs.existsSync(p));
  if (!python) throw new Error('No backend venv found (src/backend/venv or venv)');
  const child = spawn(python, ['Server.py'], {
    cwd: BACKEND,
    env: {
      ...process.env,
      API_PORT: String(port),
      DATABASE_PATH: dbPath,
      SECRET_KEY: 'tutorial-recording-' + Math.random().toString(36).slice(2),
      CYRUS_PARENT_PID: String(process.pid),
      PYTHONUNBUFFERED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const bound = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Backend did not start:\n' + log)), 60000);
    const onData = d => {
      log += d.toString();
      const m = log.match(/CYRUS_PORT=(\d+)/);
      if (m) { clearTimeout(timer); resolve(parseInt(m[1], 10)); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => reject(new Error(`Backend exited (${code}):\n${log}`)));
  });
  return { port: bound, dbPath, stop: () => { try { child.kill(); } catch {} } };
}

async function api(port, route, body, token) {
  const res = await fetch(`http://127.0.0.1:${port}/api${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${route} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

/**
 * The scripting surface a scene's steps use. Every pointer action glides the
 * visible cursor first, so viewers can follow what is being clicked.
 */
class Director {
  constructor(page) { this.page = page; }

  locator(target) {
    return typeof target === 'string' ? this.page.locator(target).first() : target;
  }

  async box(target) {
    const loc = this.locator(target);
    await loc.waitFor({ state: 'visible', timeout: 15000 });
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    return loc.boundingBox();
  }

  async move(target, ms = 750) {
    const b = await this.box(target);
    if (!b) return;
    await this.page.evaluate(([x, y, d]) => window.__tut.moveTo(x, y, d),
      [b.x + Math.min(b.width / 2, 60), b.y + b.height / 2, ms]);
  }

  async moveXY(x, y, ms = 750) {
    await this.page.evaluate(([a, b, d]) => window.__tut.moveTo(a, b, d), [x, y, ms]);
  }

  async click(target, { pause = 250, ...opts } = {}) {
    await this.move(target);
    await this.page.evaluate(() => window.__tut.press());
    await this.locator(target).click({ timeout: 10000, ...opts });
    await sleep(pause);
  }

  async hover(target, ms = 750) {
    await this.move(target, ms);
    await this.locator(target).hover({ timeout: 10000 }).catch(() => {});
  }

  async type(target, text, { delay = 70, clear = true } = {}) {
    await this.click(target);
    const loc = this.locator(target);
    if (clear) await loc.fill('');
    await loc.pressSequentially(String(text), { delay });
  }

  /** Choose from a native <select>. `value` may be a value or { label }.
   *  The dropdown itself isn't clicked open: a native popup isn't part of the
   *  page, so it would never show up in the recording anyway. */
  async select(target, value) {
    await this.move(target);
    await this.page.evaluate(() => window.__tut.press());
    await this.locator(target).selectOption(value);
    await sleep(400);
  }

  async press(key) { await this.page.keyboard.press(key); }

  /** Ring a region and dim the rest. Pass null to clear. */
  async spot(target) {
    if (!target) return this.page.evaluate(() => window.__tut.spotlight(null));
    const b = await this.box(target);
    await this.page.evaluate(r => window.__tut.spotlight(r), b);
  }

  async lower(text) { await this.page.evaluate(t => window.__tut.lower(t), text || null); }

  /** Smoothly scroll the page's scroll container (or a given element). */
  async scroll(by, { within = null, ms = 900 } = {}) {
    await this.page.evaluate(([sel, dy, d]) => new Promise(res => {
      const el = (sel && document.querySelector(sel)) || document.scrollingElement;
      const start = el.scrollTop, t0 = performance.now();
      const ease = t => t < .5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2) / 2;
      (function step(now) {
        const p = Math.min(1, (now - t0) / d);
        el.scrollTop = start + dy * ease(p);
        if (p < 1) requestAnimationFrame(step); else res();
      })(t0);
    }), [within, by, ms]);
  }

  async scrollTo(target, { within = null, offset = 130, ms = 900 } = {}) {
    const loc = this.locator(target);
    await loc.waitFor({ state: 'attached', timeout: 15000 });
    const dy = await loc.evaluate((el, [sel, off]) => {
      const box = sel && document.querySelector(sel);
      const top = box ? box.getBoundingClientRect().top : 0;
      return el.getBoundingClientRect().top - top - off;
    }, [within, offset]);
    await this.scroll(dy, { within, ms });
  }

  async nav(route) {
    await this.click(`.nav-link[data-route="${route}"]`);
    await this.settle();
  }

  /** Wait for the router to finish swapping the view and for charts to draw. */
  async settle(ms = 900) {
    await this.page.waitForLoadState('networkidle').catch(() => {});
    await sleep(ms);
  }

  wait(ms) { return sleep(ms); }

  /** Escape hatch for anything the helpers don't cover. */
  eval(fn, arg) { return this.page.evaluate(fn, arg); }
}

/**
 * Boot the app in demo mode against a private backend and hand back a page.
 * `scene` supplies optional theme / localStorage presets.
 */
async function launchApp(scene = {}, { headless = true } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-tut-'));
  const backend = await startBackend(work);
  const web = await startStatic();
  let browser;
  const close = async () => {
    if (browser) await browser.close().catch(() => {});
    await web.close();
    backend.stop();
    await sleep(500);
    fs.rmSync(work, { recursive: true, force: true });
  };
  try {
    const username = 'tutorial' + Date.now().toString(36);
    const password = 'tutorial-pass-123';
    await api(backend.port, '/auth/register', { username, password });
    const login = await api(backend.port, '/auth/login', { username, password });
    const token = login.data.token;
    const user = login.data.user;

    const exe = CHROME_CANDIDATES.find(p => fs.existsSync(p));
    if (!exe) throw new Error('Chrome/Edge not found; set CHROME_PATH');
    browser = await chromium.launch({ executablePath: exe, headless, args: ['--hide-scrollbars', '--force-color-profile=srgb'] });
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE, bypassCSP: true });
    await context.addInitScript(([port, tok, usr, theme, presets]) => {
      window.cyrus = {
        getBackendPort: async () => port,
        captureRegion: async () => null,
        // Present so the Profile page offers the Robinhood key generator;
        // reports a cancelled save, so nothing is ever written.
        saveKeygenScript: async () => ({ canceled: true }),
        platform: 'win32',
      };
      try {
        if (!sessionStorage.getItem('__tut_seeded')) {
          sessionStorage.setItem('__tut_seeded', '1');
          localStorage.clear();
          localStorage.setItem('cyrus_token', tok);
          localStorage.setItem('cyrus_user', JSON.stringify(usr));
          localStorage.setItem('cyrus_view_state', '1');   // demo mode on
          localStorage.setItem('cyrus_view_theme', theme);
          for (const [k, v] of Object.entries(presets || {})) localStorage.setItem(k, v);
        }
      } catch {}
    }, [backend.port, token, user, scene.theme || 'dark', scene.localStorage || {}]);
    await context.addInitScript({ content: overlaySource() });

    const page = await context.newPage();
    page.on('pageerror', e => console.warn('  [page error]', e.message));
    page.on('dialog', d => d.dismiss().catch(() => {}));
    await page.goto(`http://127.0.0.1:${web.port}/src/index.html`);
    await page.waitForFunction(() => typeof router !== 'undefined' && document.querySelector('#app-content') && document.querySelector('#app-content').children.length > 0, null, { timeout: 30000 });
    await sleep(2500);
    return { page, context, director: new Director(page), close, backend };
  } catch (e) {
    await close();
    throw e;
  }
}

async function withApp(fn, scene = {}, opts = {}) {
  const app = await launchApp(scene, opts);
  try { return await fn(app.page, app.director, app); } finally { await app.close(); }
}

/**
 * Record one scene. `durations[i]` is the narration length (ms) of step i;
 * each step lasts at least that long (plus a breath), and longer if its
 * actions need it. Returns the timeline the assembler needs.
 */
async function recordScene(scene, durations, outDir, opts = {}) {
  const framesDir = path.join(outDir, 'frames');
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });

  return withApp(async (page, director, app) => {
    const { context } = app;
    if (scene.setup) await scene.setup(director);
    await page.evaluate(([k, t, s]) => window.__tut.card(k, t, s),
      ['Cyrus tutorial', scene.title, scene.subtitle || '']);
    await sleep(400);

    // Start capturing.
    const cdp = await context.newCDPSession(page);
    const frames = [];
    let frameNo = 0;
    cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
      const name = `f${String(frameNo++).padStart(6, '0')}.jpg`;
      fs.writeFileSync(path.join(framesDir, name), Buffer.from(data, 'base64'));
      frames.push({ name, t: metadata.timestamp });
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 92,
      maxWidth: VIEWPORT.width * SCALE, maxHeight: VIEWPORT.height * SCALE, everyNthFrame: 1,
    });
    // A tiny repaint driver: the screencast only emits on change, and a
    // perfectly still page would otherwise leave long gaps.
    await page.evaluate(() => {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;z-index:2147483647;pointer-events:none;opacity:.01';
      document.body.appendChild(d);
      let on = false; window.__tutTick = setInterval(() => { on = !on; d.style.background = on ? '#000' : '#010101'; }, 100);
    });
    const t0 = Date.now() / 1000;
    await sleep(300);

    const steps = [];
    const BREATH = scene.breath ?? 550;
    for (let i = 0; i < scene.steps.length; i++) {
      const step = scene.steps[i];
      const start = Date.now() / 1000 - t0;
      const narr = durations[i] || 0;
      if (i === 0) setTimeout(() => page.evaluate(() => window.__tut.uncard()).catch(() => {}), 1400);
      const act = (async () => {
        if (i === 0) await sleep(1500);
        if (step.lower !== undefined) await director.lower(step.lower);
        if (step.act) await step.act(director);
      })().catch(e => { throw new Error(`step ${i} ("${(step.say || '').slice(0, 50)}"): ${e.message}`); });
      await Promise.all([act, sleep(narr + (step.hold ?? 0))]);
      await sleep(step.breath ?? BREATH);
      steps.push({ i, start, narration_ms: narr });
      process.stdout.write(`  step ${i + 1}/${scene.steps.length}
`);
    }
    await director.spot(null);
    await director.lower(null);
    await sleep(1200);
    const end = Date.now() / 1000 - t0;
    await cdp.send('Page.stopScreencast').catch(() => {});
    await sleep(300);

    const timeline = {
      scene: scene.id, end, t0,
      steps,
      frames: frames.map(f => ({ name: f.name, t: f.t - t0 })).filter(f => f.t >= -1),
      viewport: VIEWPORT, scale: SCALE,
    };
    fs.writeFileSync(path.join(outDir, 'timeline.json'), JSON.stringify(timeline, null, 1));
    console.log(`  recorded ${steps.length} steps, ${frames.length} frames, ${end.toFixed(1)}s`);
    return timeline;
  }, scene, opts);
}

module.exports = { recordScene, launchApp, withApp, Director, REPO };
