#!/usr/bin/env node
// Build the narrated tutorial videos.
//
//   node run.js                 every scene in scenes/
//   node run.js overview taxes  just those
//   node run.js --list          scene ids, titles and step counts
//   node run.js --reassemble x   re-mix and re-encode an existing recording
//   node run.js --index          rebuild out/manifest.json from finished videos
//   node run.js --check overview   walk the steps quickly with no narration
//                                   (verifies selectors; nothing is encoded)
//
// Output: out/<id>.mp4, .jpg (poster), .vtt (captions) and out/manifest.json.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { recordScene } = require('./lib/harness');

const HERE = __dirname;
const OUT = path.join(HERE, 'out');
const WORK = path.join(HERE, '.work');
const PY = [path.join(HERE, '.venv', 'Scripts', 'python.exe'), path.join(HERE, '.venv', 'bin', 'python')]
  .find(p => fs.existsSync(p)) || 'python';

function loadScenes() {
  const dir = path.join(HERE, 'scenes');
  return fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()
    .map(f => require(path.join(dir, f)))
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
}

function py(args) {
  const r = spawnSync(PY, [path.join(HERE, 'media.py'), ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`media.py ${args[0]} failed`);
}

async function build(scene, { check = false, reassemble = false } = {}) {
  console.log(`\n== ${scene.id}: ${scene.title}`);
  const work = path.join(WORK, scene.id);
  fs.mkdirSync(work, { recursive: true });
  const narrationPath = path.join(work, 'narration.json');
  fs.writeFileSync(narrationPath, JSON.stringify({
    id: scene.id, title: scene.title, steps: scene.steps.map(s => s.say || ''),
  }, null, 1));

  let durations;
  const haveRecording = fs.existsSync(path.join(work, 'timeline.json')) && fs.existsSync(path.join(work, 'frames'));
  if (reassemble && !haveRecording) throw new Error('nothing to reassemble: no recording in .work/' + scene.id);
  if (reassemble) {
    // Reuse the existing recording; only the audio mix and encode run again.
  } else if (check) {
    durations = scene.steps.map(() => 300);
  } else {
    py(['tts', narrationPath, work]);
    durations = JSON.parse(fs.readFileSync(path.join(work, 'durations.json'), 'utf8'));
  }
  if (!reassemble) await recordScene(check ? { ...scene, breath: 100 } : scene, durations, work);
  if (check) { console.log('  check passed'); return null; }

  fs.mkdirSync(OUT, { recursive: true });
  const mp4 = path.join(OUT, `${scene.id}.mp4`);
  py(['assemble', narrationPath, work, mp4]);
  // Frames are only needed to encode; they are hundreds of MB.
  fs.rmSync(path.join(work, 'frames'), { recursive: true, force: true });
  return entryFor(scene);
}

// Playlist entry for a built scene, from the timeline of its recording.
function entryFor(scene) {
  const tl = JSON.parse(fs.readFileSync(path.join(WORK, scene.id, 'timeline.json'), 'utf8'));
  return {
    id: scene.id, title: scene.title, summary: scene.summary || scene.subtitle || '',
    chapters: scene.steps.map((s, i) => s.chapter ? { title: s.chapter, t: tl.steps[i].start } : null).filter(Boolean),
    seconds: Math.round(tl.end), order: scene.order ?? 99,
  };
}

// Re-read before every write so two builds running at once don't drop
// each other's entries.
function saveEntry(entry) {
  const manifestPath = path.join(OUT, 'manifest.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
  manifest[entry.id] = entry;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

(async () => {
  const args = process.argv.slice(2);
  const scenes = loadScenes();
  if (args.includes('--list')) {
    for (const s of scenes) console.log(`${s.id.padEnd(14)} ${String(s.steps.length).padStart(3)} steps  ${s.title}`);
    return;
  }
  const check = args.includes('--check');
  const reassemble = args.includes('--reassemble');
  const wanted = args.filter(a => !a.startsWith('--'));
  const chosen = wanted.length ? scenes.filter(s => wanted.includes(s.id)) : scenes;
  if (wanted.length && chosen.length !== wanted.length) {
    throw new Error(`Unknown scene id. Known: ${scenes.map(s => s.id).join(', ')}`);
  }

  if (args.includes('--index')) {
    // Rebuild playlist entries for every scene that has a finished video.
    for (const s of scenes) {
      if (fs.existsSync(path.join(OUT, `${s.id}.mp4`)) && fs.existsSync(path.join(WORK, s.id, 'timeline.json'))) {
        saveEntry(entryFor(s)); console.log(`indexed ${s.id}`);
      }
    }
    return;
  }
  const failures = [];
  for (const scene of chosen) {
    try {
      const entry = await build(scene, { check, reassemble });
      if (entry) saveEntry(entry);
    } catch (e) {
      console.error(`  FAILED ${scene.id}: ${e.stack || e.message}`);
      failures.push(scene.id);
    }
  }
  if (failures.length) { console.error(`\nFailed: ${failures.join(', ')}`); process.exit(1); }
})();
