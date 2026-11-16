/**
 * In-app tutorial videos.
 *
 * Each page header carries a "Tutorial" button (`.tut-launch`, with the video
 * ids in `data-tutorial`). It opens a drawer on the right with that page's
 * narrated walkthrough, its chapters and captions. The drawer shares the
 * Assistant's slot — opening one closes the other — but has no scrim: on a wide
 * window it docks (the page narrows beside it, `body.tut-docked`), so you can
 * follow along while it plays.
 *
 * The videos ship inside the app: scripts/bundle-tutorials.js copies them and
 * their manifest into src/tutorials/ before packaging (electron-builder unpacks
 * the .mp4 files from the asar so they can stream and seek). A checkout without
 * them simply has no buttons — `has-tutorials` is only set once the manifest
 * loads. The recordings themselves are made by tools/tutorials.
 */

interface TutorialChapter {
  title: string;
  t: number;
}

interface TutorialEntry {
  id: string;
  title: string;
  summary: string;
  seconds: number;
  chapters: TutorialChapter[];
}

class Tutorials {
  /** Relative to src/index.html. */
  private static readonly BASE = 'tutorials/';
  /** Where each video was left, so reopening it carries on from there. */
  private static readonly POSITION_KEY = 'cyrus_tutorial_positions';

  private static entries = new Map<string, TutorialEntry>();
  private static drawer: HTMLElement | null = null;
  private static video: HTMLVideoElement | null = null;
  private static ids: string[] = [];
  private static currentId = '';
  private static currentChapter = -1;
  private static closeTimer: number | undefined;
  private static lastSaved = 0;

  /** Delegated listeners, installed at load — the buttons live in views the
   *  router swaps in and out. */
  static install(): void {
    document.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-tutorial]') as HTMLElement | null;
      if (!btn) return;
      e.preventDefault();
      const ids = Tutorials.idsFor(btn);
      if (!ids.length) return;
      if (Tutorials.isOpen() && Tutorials.ids.join(' ') === ids.join(' ')) Tutorials.close();
      else Tutorials.open(ids);
    });

    document.addEventListener('keydown', (e) => {
      // The assistant handles Escape for itself when it's the one open.
      if (e.key === 'Escape' && Tutorials.isOpen()
          && !(typeof AiAssistant !== 'undefined' && AiAssistant.isOpen())) {
        Tutorials.close();
      }
    });

    window.addEventListener('resize', () => { if (Tutorials.isOpen()) Tutorials.place(); });

    const content = document.getElementById('app-content');
    if (content) new MutationObserver(() => Tutorials.syncButtons()).observe(content, { childList: true });

    Tutorials.load();
  }

  static isOpen(): boolean {
    return !!Tutorials.drawer && !Tutorials.drawer.classList.contains('d-none');
  }

  static open(ids: string[]): void {
    if (typeof AiAssistant !== 'undefined' && AiAssistant.isOpen()) AiAssistant.close();
    if (!Tutorials.drawer) Tutorials.build();
    const drawer = Tutorials.drawer!;
    window.clearTimeout(Tutorials.closeTimer);

    Tutorials.ids = ids;
    Tutorials.renderTabs();
    Tutorials.show(ids.includes(Tutorials.currentId) ? Tutorials.currentId : ids[0]);
    Tutorials.place();

    drawer.classList.remove('d-none');
    requestAnimationFrame(() => drawer.classList.add('tut-open'));
    Tutorials.dock(true);
    Tutorials.syncButtons();
    (drawer.querySelector('.tut-panel') as HTMLElement | null)?.focus();
  }

  static close(): void {
    const drawer = Tutorials.drawer;
    if (!drawer || drawer.classList.contains('d-none')) return;
    Tutorials.savePosition(true);
    Tutorials.video?.pause();
    drawer.classList.remove('tut-open');
    Tutorials.dock(false);
    window.clearTimeout(Tutorials.closeTimer);
    Tutorials.closeTimer = window.setTimeout(() => drawer.classList.add('d-none'), 200);
    // Synchronously, so the button reads as closed straight away.
    Tutorials.syncButtons(false);
  }

  /** Narrow the page beside the panel (CSS does it on wide windows only). */
  private static dock(on: boolean): void {
    if (document.body.classList.contains('tut-docked') === on) return;
    document.body.classList.toggle('tut-docked', on);
    // Charts size themselves on window resize; give them the new width once
    // the page has finished sliding.
    window.setTimeout(() => window.dispatchEvent(new Event('resize')), 260);
  }

  // ── Data ────────────────────────────────────────────────────────────────

  private static async load(): Promise<void> {
    try {
      const res = await fetch(Tutorials.BASE + 'manifest.json');
      if (!res.ok) return;
      const list = await res.json() as TutorialEntry[];
      list.forEach(e => Tutorials.entries.set(e.id, e));
    } catch {
      // No bundled videos (a dev checkout without them): the buttons stay hidden.
      return;
    }
    if (Tutorials.entries.size) {
      document.body.classList.add('has-tutorials');
      Tutorials.syncButtons();
    }
  }

  private static idsFor(btn: HTMLElement): string[] {
    return (btn.dataset.tutorial || '').split(/\s+/).filter(id => Tutorials.entries.has(id));
  }

  /** Running time on each page button, and its pressed state. */
  private static syncButtons(open = Tutorials.isOpen()): void {
    document.querySelectorAll<HTMLElement>('.tut-launch[data-tutorial]').forEach(btn => {
      const ids = Tutorials.idsFor(btn);
      btn.classList.toggle('d-none', !ids.length);
      if (!ids.length) return;
      const dur = btn.querySelector('.tut-launch-dur');
      if (dur) {
        dur.textContent = ids.length > 1
          ? `${ids.length} videos`
          : Tutorials.clock(Tutorials.entries.get(ids[0])!.seconds);
      }
      const mine = open && ids.join(' ') === Tutorials.ids.join(' ');
      btn.setAttribute('aria-expanded', String(mine));
      btn.classList.toggle('is-active', mine);
    });
  }

  // ── Construction ────────────────────────────────────────────────────────

  private static build(): void {
    const el = document.createElement('div');
    el.className = 'tut-drawer d-none';
    el.innerHTML = `
      <aside class="tut-panel" role="dialog" aria-labelledby="tut-title" tabindex="-1">
        <header class="tut-head">
          <span class="tut-head-mark" aria-hidden="true"><i class="fa-solid fa-play"></i></span>
          <div class="tut-head-text">
            <span class="tut-kicker" id="tut-kicker">Tutorial</span>
            <span class="tut-title" id="tut-title"></span>
          </div>
          <button type="button" class="ai-icon-btn" data-tut-close title="Close (Esc)" aria-label="Close tutorial">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </header>
        <div class="tut-tabs d-none" id="tut-tabs" role="tablist" aria-label="Videos for this page"></div>
        <div class="tut-body">
          <video class="tut-video" id="tut-video" controls preload="metadata" playsinline></video>
          <p class="tut-error d-none" id="tut-error">This video couldn't be loaded. Reinstalling Cyrus restores it.</p>
          <p class="tut-summary" id="tut-summary"></p>
          <h3 class="tut-label">Chapters</h3>
          <ol class="tut-chapters" id="tut-chapters"></ol>
          <p class="tut-note">Recorded in demo mode, so the balances and orders on screen are sample data.
            Keep this open and follow along — the page behind it still works.</p>
        </div>
      </aside>`;
    document.body.appendChild(el);
    Tutorials.drawer = el;

    el.querySelector('[data-tut-close]')?.addEventListener('click', () => Tutorials.close());

    const video = el.querySelector('#tut-video') as HTMLVideoElement;
    Tutorials.video = video;
    video.addEventListener('timeupdate', () => {
      Tutorials.markChapter();
      Tutorials.savePosition(false);
    });
    video.addEventListener('ended', () => Tutorials.forgetPosition(Tutorials.currentId));
    video.addEventListener('error', () => el.querySelector('#tut-error')?.classList.remove('d-none'));
    video.addEventListener('loadedmetadata', () => {
      const pos = Tutorials.positions()[Tutorials.currentId];
      // Carry on where they stopped, unless that was the very start or end.
      if (pos && pos > 5 && pos < video.duration - 10) video.currentTime = pos;
    });

    el.querySelector('#tut-chapters')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-t]') as HTMLElement | null;
      if (!btn) return;
      video.currentTime = Number(btn.dataset.t);
      video.play().catch(() => { /* blocked or not loaded yet: the seek still lands */ });
    });

    el.querySelector('#tut-tabs')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-tab-id]') as HTMLElement | null;
      if (btn?.dataset.tabId) Tutorials.show(btn.dataset.tabId);
    });
  }

  /** Below the top bar, so search, Ask and Logout stay reachable. */
  private static place(): void {
    const panel = Tutorials.drawer?.querySelector('.tut-panel') as HTMLElement | null;
    if (!panel) return;
    const chrome = document.getElementById('app-header');
    const bar = document.querySelector('.app-topbar');
    const top = chrome && bar && !chrome.classList.contains('d-none')
      ? Math.max(0, Math.round(bar.getBoundingClientRect().bottom)) : 0;
    panel.style.top = `${top}px`;
  }

  private static renderTabs(): void {
    const tabs = Tutorials.drawer?.querySelector('#tut-tabs') as HTMLElement | null;
    if (!tabs) return;
    tabs.replaceChildren(...(Tutorials.ids.length > 1 ? Tutorials.ids.map(id => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tut-tab';
      b.setAttribute('role', 'tab');
      b.dataset.tabId = id;
      b.textContent = Tutorials.entries.get(id)!.title;
      return b;
    }) : []));
    tabs.classList.toggle('d-none', Tutorials.ids.length < 2);
  }

  /** Load one video into the drawer. */
  private static show(id: string): void {
    const entry = Tutorials.entries.get(id);
    const el = Tutorials.drawer;
    const video = Tutorials.video;
    if (!entry || !el || !video) return;

    el.querySelectorAll<HTMLElement>('.tut-tab').forEach(t => {
      const on = t.dataset.tabId === id;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
    });
    if (id === Tutorials.currentId && video.currentSrc) return;

    Tutorials.savePosition(true);
    video.pause();
    Tutorials.currentId = id;
    Tutorials.currentChapter = -1;
    el.querySelector('#tut-error')?.classList.add('d-none');

    (el.querySelector('#tut-kicker') as HTMLElement).textContent = `Tutorial · ${Tutorials.clock(entry.seconds)}`;
    (el.querySelector('#tut-title') as HTMLElement).textContent = entry.title;
    (el.querySelector('#tut-summary') as HTMLElement).textContent = entry.summary;

    video.querySelectorAll('track').forEach(t => t.remove());
    video.poster = `${Tutorials.BASE}${id}.jpg`;
    video.src = `${Tutorials.BASE}${id}.mp4`;
    const track = document.createElement('track');
    track.kind = 'captions';
    track.srclang = 'en';
    track.label = 'English';
    track.src = `${Tutorials.BASE}${id}.vtt`;
    video.appendChild(track);

    const list = el.querySelector('#tut-chapters') as HTMLElement;
    list.replaceChildren(...entry.chapters.map(c => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tut-chapter';
      b.dataset.t = String(c.t);
      const time = document.createElement('time');
      time.textContent = Tutorials.clock(c.t);
      const name = document.createElement('span');
      name.textContent = c.title;
      b.append(time, name);
      li.appendChild(b);
      return li;
    }));
    Tutorials.markChapter();
  }

  private static markChapter(): void {
    const entry = Tutorials.entries.get(Tutorials.currentId);
    const video = Tutorials.video;
    if (!entry || !video || !Tutorials.drawer) return;
    let idx = 0;
    entry.chapters.forEach((c, i) => { if (video.currentTime >= c.t) idx = i; });
    if (idx === Tutorials.currentChapter) return;
    Tutorials.currentChapter = idx;
    Tutorials.drawer.querySelectorAll('.tut-chapter').forEach((b, i) => {
      b.classList.toggle('is-current', i === idx);
      if (i === idx) b.setAttribute('aria-current', 'step');
      else b.removeAttribute('aria-current');
    });
  }

  // ── Resume positions (per-viewer convenience; losing them is harmless) ──

  private static positions(): Record<string, number> {
    try {
      return JSON.parse(localStorage.getItem(Tutorials.POSITION_KEY) || '{}') || {};
    } catch {
      return {};
    }
  }

  private static savePosition(force: boolean): void {
    const video = Tutorials.video;
    if (!video || !Tutorials.currentId || !video.currentTime) return;
    const now = Date.now();
    if (!force && now - Tutorials.lastSaved < 5000) return;
    Tutorials.lastSaved = now;
    try {
      const all = Tutorials.positions();
      all[Tutorials.currentId] = Math.floor(video.currentTime);
      localStorage.setItem(Tutorials.POSITION_KEY, JSON.stringify(all));
    } catch { /* storage unavailable: it just starts from the top next time */ }
  }

  private static forgetPosition(id: string): void {
    try {
      const all = Tutorials.positions();
      delete all[id];
      localStorage.setItem(Tutorials.POSITION_KEY, JSON.stringify(all));
    } catch { /* see savePosition */ }
  }

  private static clock(seconds: number): string {
    const s = Math.round(seconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
}

Tutorials.install();
