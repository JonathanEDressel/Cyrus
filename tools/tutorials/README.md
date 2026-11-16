# Tutorial videos

Records the narrated per-page walkthroughs shown in the **Tutorials** section of
the landing page. Each video is a scripted run of the real frontend in **demo
mode**, so every number on screen is the fixture in
`src/app/services/demomode.ts`, never a real account.

## How it works

1. **Narration** — `media.py tts` voices each step of a scene with a neural
   voice (edge-tts, `en-US-AndrewNeural`, slightly slowed) and records how long
   each line runs. Clips are cached in `.cache/tts/` by text.
2. **Recording** — `lib/harness.js` starts a private backend on a free port
   against a throwaway database, registers a throwaway user, serves the repo
   over HTTP and opens `src/index.html` in headless Chrome with demo mode on.
   A small overlay (`lib/overlay.js`) draws a visible cursor, click ripples,
   spotlights and the title card. Frames come from the DevTools screencast;
   each step lasts as long as its narration (or its actions, if longer).
3. **Assembly** — `media.py assemble` places every clip at the moment its step
   started, mixes it over a quiet ambient bed generated in code (no licensed
   music), ducks the music under speech, encodes H.264/AAC, and writes a poster
   and WebVTT captions from the voice's sentence timings.

Nothing touches the backend on port 5000 or your real `kraking.db`.

## Setup (once)

```
cd tools/tutorials
npm install
python -m venv .venv && .venv\Scripts\python -m pip install -r requirements.txt
```

Needs Chrome or Edge installed (or `CHROME_PATH`), the backend venv
(`src/backend/venv` or root `venv`), and a compiled frontend (`npm run build`
at the repo root). The voice needs internet access.

## Commands

```
node run.js --list                 # scenes and step counts
node run.js --check overview       # fast dry run: every selector must resolve
node run.js overview taxes         # build those (out/<id>.mp4/.jpg/.vtt)
node run.js                        # build everything
node run.js --reassemble taxes     # re-mix and re-encode the last recording
node run.js --index                # rebuild out/manifest.json from finished videos
node publish.js                    # copy into ../../../Cyrus-Landing/tutorials
                                   # and refresh the landing page playlist
node explore.js holdings           # screenshots + selector list for a page
```

## Writing a scene

`scenes/NN-name.js` exports `{ id, order, title, subtitle, summary, steps }`.
Each step is `{ say, act?, chapter?, hold?, breath? }`: `say` is spoken, `act`
runs while it is spoken and gets the `Director` from `lib/harness.js`
(`click`, `hover`, `type`, `select`, `spot`, `scrollTo`, `nav`, …). `chapter`
marks a jump point in the landing-page player. See `scenes/01-overview.js`.

Write narration for the ear: short sentences, no symbols or parentheses, and
only claims you have confirmed in the code. Re-record a scene whenever the
page it covers changes.
