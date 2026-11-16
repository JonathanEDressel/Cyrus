// In-page presentation layer for the tutorial recordings. Injected with
// addInitScript, so it exists before the app boots. Everything here is
// pointer-events:none and sits above the app; it never changes app state.
//
// window.__tut exposes:
//   moveTo(x, y, ms)          glide the fake cursor
//   press()                   click ripple at the cursor
//   spotlight(rect|null)      soft ring around a region (null clears)
//   card(title, sub, ms)      full-screen title card that fades away
//   lower(text|null)          small "lower third" chip naming the section

module.exports = function overlaySource() {
  return `(() => {
  if (window.__tut) return;
  const css = \`
    #tut-cursor{position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483646;pointer-events:none;
      transform:translate(-200px,-200px);transition:transform 0ms;filter:drop-shadow(0 2px 4px rgba(0,0,0,.45))}
    #tut-ripple{position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;z-index:2147483645;
      pointer-events:none;border:2px solid rgba(94,230,247,.95);opacity:0;transform:scale(.3)}
    #tut-ripple.go{animation:tutRip .55s ease-out}
    @keyframes tutRip{0%{opacity:.95;transform:scale(.3)}100%{opacity:0;transform:scale(1.6)}}
    #tut-spot{position:fixed;z-index:2147483644;pointer-events:none;border-radius:10px;opacity:0;
      box-shadow:0 0 0 2px rgba(94,230,247,.95),0 0 0 6px rgba(94,230,247,.22),0 0 0 9999px rgba(3,6,12,.38);
      transition:left .5s ease,top .5s ease,width .5s ease,height .5s ease,opacity .35s ease}
    #tut-card{position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:flex;flex-direction:column;
      align-items:center;justify-content:center;gap:14px;background:radial-gradient(ellipse at 50% 40%,#0f1b2b 0%,#05080d 70%);
      color:#e6edf3;font-family:'JetBrains Mono',ui-monospace,Consolas,monospace;opacity:0;transition:opacity .7s ease}
    #tut-card .k{font-size:15px;letter-spacing:.32em;color:#5ee6f7;text-transform:uppercase}
    #tut-card .t{font-size:44px;font-weight:700;letter-spacing:-.01em}
    #tut-card .s{font-size:18px;color:#93a4b8;max-width:820px;text-align:center;line-height:1.5;font-family:Inter,system-ui,sans-serif}
    #tut-lower{position:fixed;left:50%;bottom:26px;transform:translate(-50%,12px);z-index:2147483643;pointer-events:none;
      padding:9px 16px;border-radius:999px;background:rgba(8,14,22,.88);border:1px solid rgba(94,230,247,.45);
      color:#dff9fd;font:600 14px/1 Inter,system-ui,sans-serif;letter-spacing:.02em;opacity:0;
      transition:opacity .35s ease,transform .35s ease;white-space:nowrap}
    #tut-lower.on{opacity:1;transform:translate(-50%,0)}
  \`;
  const svg = '<svg viewBox="0 0 26 26" width="26" height="26"><path d="M4 2 L4 21 L9 16.5 L12.5 24 L15.6 22.6 L12.2 15.3 L19 15.3 Z" fill="#fff" stroke="#0b1220" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  let cursor, ripple, spot, card, lower, cx = -200, cy = -200;
  function ensure() {
    if (cursor && document.body.contains(cursor)) return;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    cursor = document.createElement('div'); cursor.id = 'tut-cursor'; cursor.innerHTML = svg;
    ripple = document.createElement('div'); ripple.id = 'tut-ripple';
    spot = document.createElement('div'); spot.id = 'tut-spot';
    card = document.createElement('div'); card.id = 'tut-card';
    lower = document.createElement('div'); lower.id = 'tut-lower';
    document.body.append(spot, ripple, lower, cursor, card);
  }
  function place() { cursor.style.transform = 'translate(' + (cx - 4) + 'px,' + (cy - 2) + 'px)'; }
  window.__tut = {
    moveTo(x, y, ms) {
      ensure();
      return new Promise(res => {
        const x0 = cx, y0 = cy, t0 = performance.now(), d = Math.max(1, ms || 700);
        if (x0 < -100) { cx = x; cy = y; place(); return res(); }
        const ease = t => t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;
        (function step(now) {
          const p = Math.min(1, (now - t0) / d), e = ease(p);
          cx = x0 + (x - x0) * e; cy = y0 + (y - y0) * e; place();
          if (p < 1) requestAnimationFrame(step); else res();
        })(t0);
      });
    },
    press() {
      ensure();
      ripple.style.left = cx + 'px'; ripple.style.top = cy + 'px';
      ripple.classList.remove('go'); void ripple.offsetWidth; ripple.classList.add('go');
    },
    spotlight(r) {
      ensure();
      if (!r) { spot.style.opacity = '0'; return; }
      const pad = 6;
      spot.style.left = (r.x - pad) + 'px'; spot.style.top = (r.y - pad) + 'px';
      spot.style.width = (r.width + pad * 2) + 'px'; spot.style.height = (r.height + pad * 2) + 'px';
      spot.style.opacity = '1';
    },
    card(kicker, title, sub) {
      ensure();
      card.innerHTML = '<div class="k"></div><div class="t"></div><div class="s"></div>';
      card.querySelector('.k').textContent = kicker || '';
      card.querySelector('.t').textContent = title || '';
      card.querySelector('.s').textContent = sub || '';
      card.style.transition = 'none'; card.style.opacity = '1';
    },
    uncard() { ensure(); card.style.transition = 'opacity .8s ease'; card.style.opacity = '0'; },
    lower(text) {
      ensure();
      if (!text) { lower.classList.remove('on'); return; }
      lower.textContent = text; lower.classList.add('on');
    },
    pos() { return { x: cx, y: cy }; },
  };
  document.addEventListener('DOMContentLoaded', ensure);
})();`;
};
