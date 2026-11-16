#!/usr/bin/env node
// Copy the built videos into the landing site and refresh its playlist.
//
//   node publish.js [path/to/Cyrus-Landing]     (default: ../../../Cyrus-Landing)
//
// Copies out/<id>.{mp4,jpg,vtt} to <landing>/tutorials/, writes the playlist
// there as manifest.json (the app bundles that folder: scripts/bundle-tutorials.js)
// and rewrites the block between /* TUTORIALS:DATA */ markers in
// <landing>/index.html.

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const landing = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..', 'Cyrus-Landing'));
const indexPath = path.join(landing, 'index.html');
if (!fs.existsSync(indexPath)) throw new Error(`No index.html in ${landing}`);

const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
const entries = Object.values(manifest)
  .filter(e => ['mp4', 'jpg', 'vtt'].every(ext => fs.existsSync(path.join(OUT, `${e.id}.${ext}`))))
  .sort((a, b) => a.order - b.order);

const dest = path.join(landing, 'tutorials');
fs.mkdirSync(dest, { recursive: true });
const keep = new Set();
for (const e of entries) {
  for (const ext of ['mp4', 'jpg', 'vtt']) {
    const name = `${e.id}.${ext}`;
    fs.copyFileSync(path.join(OUT, name), path.join(dest, name));
    keep.add(name);
  }
}
keep.add('manifest.json');
// Drop videos for scenes that no longer exist.
for (const f of fs.readdirSync(dest)) if (!keep.has(f)) fs.rmSync(path.join(dest, f));

const data = entries.map(e => ({
  id: e.id, title: e.title, summary: e.summary, seconds: e.seconds,
  chapters: e.chapters.map(c => ({ title: c.title, t: Math.round(c.t * 10) / 10 })),
}));
fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(data, null, 1));
const html = fs.readFileSync(indexPath, 'utf8');
const re = /\/\* TUTORIALS:DATA \*\/[\s\S]*?\/\* \/TUTORIALS:DATA \*\//;
if (!re.test(html)) throw new Error('TUTORIALS:DATA markers not found in index.html');
const block = `/* TUTORIALS:DATA */\n  const TUTORIALS = ${JSON.stringify(data, null, 2).replace(/\n/g, '\n  ')};\n  /* /TUTORIALS:DATA */`;
fs.writeFileSync(indexPath, html.replace(re, block));

const total = entries.reduce((s, e) => s + fs.statSync(path.join(dest, `${e.id}.mp4`)).size, 0);
console.log(`published ${entries.length} videos (${(total / 1e6).toFixed(0)} MB) to ${dest}`);
console.log('The app picks them up on the next `npm run dist` (or run node scripts/bundle-tutorials.js).');
