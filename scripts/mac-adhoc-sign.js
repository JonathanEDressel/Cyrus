// electron-builder afterPack hook: ad-hoc sign the macOS app.
//
// Apple Silicon refuses to run code with no signature at all, and an unsigned
// bundle downloaded from the internet is reported as "damaged" with no way to
// open it. An ad-hoc signature ("-") costs nothing and turns that into the
// normal one-time "Open Anyway" prompt in System Settings → Privacy & Security.
//
// Does nothing on Windows, or once a real Developer ID is configured (CSC_LINK
// or mac.identity) — electron-builder signs and notarizes properly then.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MACHO_MAGIC = new Set([
  0xfeedface, 0xfeedfacf, // 32/64-bit, big-endian
  0xcefaedfe, 0xcffaedfe, // 32/64-bit, little-endian
  0xcafebabe, 0xbebafeca, // universal (fat)
]);

function isMachO(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4);
    if (fs.readSync(fd, buf, 0, 4, 0) < 4) return false;
    return MACHO_MAGIC.has(buf.readUInt32BE(0));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && isMachO(full)) out.push(full);
  }
  return out;
}

function sign(target, deep = false) {
  const args = ['--force', '--sign', '-', '--timestamp=none'];
  if (deep) args.push('--deep');
  execFileSync('codesign', [...args, target], { stdio: 'inherit' });
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const configured = context.packager.platformSpecificBuildOptions.identity;
  if (process.env.CSC_LINK || configured) {
    console.log('[adhoc-sign] Real signing identity configured; skipping ad-hoc signing.');
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  // The bundled Python backend first (innermost code before the bundle that
  // seals it). PyInstaller output lives in Resources, which --deep skips.
  const backendDir = path.join(appPath, 'Contents', 'Resources', 'backend');
  if (fs.existsSync(backendDir)) {
    const binaries = walk(backendDir);
    console.log(`[adhoc-sign] Signing ${binaries.length} backend binaries`);
    // Libraries before the executable that loads them.
    binaries.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
    for (const bin of binaries) sign(bin);
  } else {
    console.warn('[adhoc-sign] No bundled backend found at', backendDir);
  }

  console.log(`[adhoc-sign] Signing ${appName}`);
  sign(appPath, true);
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' });
};
