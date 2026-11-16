#!/usr/bin/env node
// Scene-writing aid: open a page in demo mode, optionally run a few actions,
// then save screenshots (top + scrolled) and a list of visible interactive
// elements with usable selectors.
//
//   node explore.js <route> [outdir] [--do "<js run in page>"] [--steps scene-file.js:N]
//
// --steps runs the first N steps of a scene (no narration pauses) before
// capturing, so you can see the state a later step starts from.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const harness = require('./lib/harness');

(async () => {
  const args = process.argv.slice(2);
  const route = args[0] || 'home';
  const out = path.resolve(args[1] && !args[1].startsWith('--') ? args[1] : path.join(__dirname, '.explore', route));
  const doIdx = args.indexOf('--do');
  const js = doIdx >= 0 ? args[doIdx + 1] : null;
  const stepsIdx = args.indexOf('--steps');
  const stepsArg = stepsIdx >= 0 ? args[stepsIdx + 1] : null;
  fs.mkdirSync(out, { recursive: true });

  await harness.withApp(async (page, director) => {
    if (route !== 'home') await director.nav(route);
    else await director.settle(1500);
    if (stepsArg) {
      const [file, n] = stepsArg.split(':');
      const scene = require(path.resolve(file));
      if (scene.setup) await scene.setup(director);
      for (const step of scene.steps.slice(0, parseInt(n, 10))) {
        if (step.act) await step.act(director);
      }
      await director.spot(null);
    }
    if (js) { await page.evaluate(js); await director.settle(800); }

    await page.screenshot({ path: path.join(out, '1-top.png') });
    const info = await page.evaluate(() => {
      const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const sel = el => {
        if (el.id) return '#' + el.id;
        const attrs = ['data-route', 'data-tab', 'data-action', 'data-filter', 'data-view', 'data-mode', 'name', 'aria-label', 'title'];
        for (const a of attrs) if (el.getAttribute(a)) return `${el.tagName.toLowerCase()}[${a}="${el.getAttribute(a)}"]`;
        const cls = [...el.classList].slice(0, 2).join('.');
        return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
      };
      const root = document.querySelector('#app-content') || document.body;
      const items = [...document.querySelectorAll('button, a, input, select, textarea, [role=tab], [data-tab], [data-route], summary, [contenteditable]')]
        .filter(visible).slice(0, 220).map(el => {
          const r = el.getBoundingClientRect();
          return `${sel(el)}  @(${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)})  "${(el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 60)}"`;
        });
      const headings = [...root.querySelectorAll('h1,h2,h3,h4,.card-title,.section-title,.panel-title')]
        .filter(visible).map(h => `${sel(h)}: ${h.innerText.trim().replace(/\s+/g, ' ').slice(0, 80)}`);
      const sc = document.scrollingElement;
      return { items, headings, scrollHeight: sc.scrollHeight, clientHeight: innerHeight };
    });
    // Scrolled captures down the page.
    const shots = Math.min(8, Math.ceil(info.scrollHeight / Math.max(1, info.clientHeight)));
    for (let k = 1; k < shots; k++) {
      await page.evaluate(([k, h]) => { document.scrollingElement.scrollTop = k * h * 0.85; }, [k, info.clientHeight]);
      await director.wait(500);
      await page.screenshot({ path: path.join(out, `${k + 1}-scrolled.png`) });
    }
    fs.writeFileSync(path.join(out, 'elements.txt'),
      `HEADINGS\n${info.headings.join('\n')}\n\nINTERACTIVE (first 220)\n${info.items.join('\n')}\n\nscrollHeight=${info.scrollHeight} clientHeight=${info.clientHeight}\n`);
    console.log(`saved to ${out}`);
  });
})().catch(e => { console.error(e); process.exit(1); });
