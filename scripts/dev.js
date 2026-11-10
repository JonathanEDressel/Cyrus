// Runs the backend and the Electron frontend together, in one terminal.
//
//   npm run start:all              (extra args go to Electron: npm run start:all -- --dev)
//
// In dev, Electron's startBackend() is a no-op that assumes a backend is already
// listening on port 5000. This starts `python Server.py`, compiles the frontend
// while it boots, waits for the port to accept connections, then launches
// Electron. Quitting Electron (tray -> Quit) or pressing Ctrl+C stops both.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BACKEND_DIR = path.join(ROOT, 'src', 'backend');
// Must match PREFERRED_PORT in src/main.ts — the port Electron uses in dev.
const PORT = 5000;
// First boot imports ccxt and runs migrations, which can take a while.
const STARTUP_TIMEOUT_MS = 60000;

let backend = null;

function log(msg) {
  console.log(`[dev] ${msg}`);
}

function findPython() {
  const candidates = [
    path.join(BACKEND_DIR, 'venv', 'Scripts', 'python.exe'),
    path.join(ROOT, 'venv', 'Scripts', 'python.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function waitForBackend(proc) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    const onExit = (code) => reject(new Error(`backend exited with code ${code} before it started listening`));
    proc.once('exit', onExit);

    const poll = async () => {
      if (await portOpen(PORT)) {
        proc.off('exit', onExit);
        resolve();
      } else if (Date.now() > deadline) {
        proc.off('exit', onExit);
        reject(new Error(`backend did not open port ${PORT} within ${STARTUP_TIMEOUT_MS / 1000}s`));
      } else {
        setTimeout(poll, 250);
      }
    };
    poll();
  });
}

function run(cmd, args) {
  return new Promise((resolve) => {
    spawn(cmd, args, { cwd: ROOT, stdio: 'inherit' }).on('exit', (code) => resolve(code));
  });
}

function stopBackend() {
  if (!backend) return;
  const pid = backend.pid;
  backend = null;
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
  } catch {
    // Already gone (Ctrl+C reaches it directly too).
  }
}

async function main() {
  if (await portOpen(PORT)) {
    // Most likely a backend you started by hand. Don't start a second one —
    // two automation workers on the same DB could double-fire rules.
    log(`Port ${PORT} is already in use; assuming that's the backend and starting only the frontend.`);
  } else {
    const python = findPython();
    if (!python) {
      console.error('[dev] No Python venv found. Set one up first:');
      console.error('      cd src\\backend && python -m venv venv && venv\\Scripts\\activate && pip install -r requirements.txt');
      process.exit(1);
    }
    log('Starting backend...');
    backend = spawn(python, ['Server.py'], {
      cwd: BACKEND_DIR,
      // Inheriting the terminal keeps the backend's console logging (it only
      // redirects to logs/cyrus.log when stdout is a pipe).
      stdio: 'inherit',
      // The backend exits on its own if this launcher dies without cleaning up.
      env: { ...process.env, CYRUS_PARENT_PID: String(process.pid) },
    });
    backend.on('exit', (code) => {
      if (backend) log(`Backend exited with code ${code}.`);
      backend = null;
    });
  }

  log('Compiling frontend...');
  const [buildCode] = await Promise.all([
    run(process.execPath, [require.resolve('typescript/bin/tsc')]),
    backend ? waitForBackend(backend) : null,
  ]);
  if (buildCode !== 0) {
    throw new Error(`tsc failed with code ${buildCode}`);
  }

  log('Launching Electron...');
  const electron = spawn(require('electron'), ['.', ...process.argv.slice(2)], { cwd: ROOT, stdio: 'inherit' });
  electron.on('exit', (code) => {
    stopBackend();
    process.exit(code ?? 0);
  });
}

process.on('SIGINT', () => {
  stopBackend();
  process.exit(130);
});

main().catch((err) => {
  console.error(`[dev] ${err.message}`);
  stopBackend();
  process.exit(1);
});
