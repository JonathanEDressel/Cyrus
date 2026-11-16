#!/usr/bin/env node
// Copy the tutorial videos into src/tutorials/ so electron-builder ships them
// (package.json: build.files + asarUnpack). Runs before `npm run dist`; the
// macOS workflow runs it against a clone of the landing repo.
//
//   node scripts/bundle-tutorials.js [source-folder]
//
// The source is the argument, else $CYRUS_TUTORIALS, else the landing repo's
// tutorials/ folder next to this one (tools/tutorials/publish.js keeps it
// current). It must hold manifest.json and <id>.mp4/.jpg/.vtt for each entry.
// The videos are git-ignored here; the landing repo is where they live.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dest = path.join(root, 'src', 'tutorials');
const candidates = [process.argv[2], process.env.CYRUS_TUTORIALS, path.join(root, '..', 'Cyrus-Landing', 'tutorials')]
  .filter(Boolean)
  .map(p => path.resolve(p));
const src = candidates.find(p => fs.existsSync(path.join(p, 'manifest.json')));

if (!src) {
  console.error('No tutorial videos found. Looked for manifest.json in:\n  ' + candidates.join('\n  ')
    + '\nRun tools/tutorials/publish.js, or pass the folder that holds the videos.');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
const files = ['manifest.json', ...manifest.flatMap(e => ['mp4', 'jpg', 'vtt'].map(ext => `${e.id}.${ext}`))];
const missing = files.filter(f => !fs.existsSync(path.join(src, f)));
if (missing.length) {
  console.error(`${src} is missing: ${missing.join(', ')}`);
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
let bytes = 0;
for (const f of files) {
  fs.copyFileSync(path.join(src, f), path.join(dest, f));
  bytes += fs.statSync(path.join(dest, f)).size;
}
console.log(`bundled ${manifest.length} tutorial videos (${(bytes / 1e6).toFixed(0)} MB) from ${src}`);
