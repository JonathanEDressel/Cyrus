/**
 * The "update available" modal and the top-bar Update pill.
 *
 * The main process (src/updater.ts) checks GitHub for a newer release and
 * pushes its state here. The modal shows once per new version — "Later"
 * remembers that version — while the pill stays in the top bar until the
 * update is installed, so it's always one click away.
 *
 * Windows: Update now → downloads in the background → Restart now installs.
 * macOS: Download opens this Mac's .dmg in the browser (no in-place install
 * without a Developer ID signature).
 */

interface AppUpdateState {
  status: 'none' | 'available' | 'downloading' | 'ready';
  current: string;
  version?: string;
  notes?: string;
  publishedAt?: string;
  url?: string;
  canInstall: boolean;
  percent?: number;
  transferred?: number;
  total?: number;
  error?: string;
}

class UpdateNotice {
  private static readonly DISMISSED_KEY = 'cyrus_update_dismissed';
  private static overlay: HTMLElement | null = null;
  private static state: AppUpdateState | null = null;

  static install(): void {
    const bridge = (window as any).cyrus?.updates;
    // Not in Electron (or an older preload): nothing to check with.
    if (!bridge) return;
    document.getElementById('update-pill')?.addEventListener('click', () => UpdateNotice.open());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && UpdateNotice.isOpen()) UpdateNotice.later();
    });
    bridge.onChange((s: AppUpdateState) => UpdateNotice.apply(s));
    bridge.state().then((s: AppUpdateState) => UpdateNotice.apply(s)).catch(() => {});
  }

  /** Take a state from the main process and reflect it everywhere. */
  static apply(next: AppUpdateState): void {
    const prev = UpdateNotice.state;
    UpdateNotice.state = next;
    UpdateNotice.renderPill();
    if (next.status === 'none') {
      UpdateNotice.close();
      return;
    }
    if (UpdateNotice.isOpen()) {
      UpdateNotice.render();
    } else if (next.status === 'ready' && prev?.status !== 'ready') {
      // They asked for it; say when it's ready even if they hid the modal.
      UpdateNotice.open();
    } else if (next.status === 'available' && next.version !== UpdateNotice.dismissed()) {
      UpdateNotice.open();
    }
  }

  static isOpen(): boolean {
    return !!UpdateNotice.overlay && !UpdateNotice.overlay.classList.contains('d-none');
  }

  static open(): void {
    if (!UpdateNotice.state || UpdateNotice.state.status === 'none') return;
    if (!UpdateNotice.overlay) UpdateNotice.build();
    UpdateNotice.render();
    UpdateNotice.overlay!.classList.remove('d-none');
    (UpdateNotice.overlay!.querySelector('#upd-primary') as HTMLElement | null)?.focus();
  }

  static close(): void {
    UpdateNotice.overlay?.classList.add('d-none');
  }

  /** Hide it; don't open it by itself again for this version. */
  private static later(): void {
    const v = UpdateNotice.state?.version;
    if (v) {
      try { localStorage.setItem(UpdateNotice.DISMISSED_KEY, v); } catch { /* it just asks again next launch */ }
    }
    UpdateNotice.close();
  }

  private static dismissed(): string | null {
    try { return localStorage.getItem(UpdateNotice.DISMISSED_KEY); } catch { return null; }
  }

  // ── Construction ────────────────────────────────────────────────────────

  private static build(): void {
    const el = document.createElement('div');
    el.className = 'upd-overlay d-none';
    el.innerHTML = `
      <div class="upd-modal" role="dialog" aria-modal="true" aria-labelledby="upd-title">
        <header class="upd-head">
          <span class="upd-mark" aria-hidden="true"><i class="fa-solid fa-arrow-down" id="upd-mark-icon"></i></span>
          <div class="upd-head-text">
            <span class="upd-kicker" id="upd-kicker"></span>
            <h2 class="upd-title" id="upd-title"></h2>
          </div>
          <button type="button" class="ai-icon-btn" data-upd-later aria-label="Close" title="Close (Esc)">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </header>
        <div class="upd-versions">
          <span class="upd-ver"><span class="upd-ver-label">Installed</span><span id="upd-current"></span></span>
          <i class="fa-solid fa-arrow-right upd-ver-arrow" aria-hidden="true"></i>
          <span class="upd-ver is-new"><span class="upd-ver-label">New</span><span id="upd-new"></span></span>
          <span class="upd-date" id="upd-date"></span>
        </div>
        <div class="upd-body">
          <h3 class="upd-label">What's new</h3>
          <div class="upd-notes" id="upd-notes"></div>
        </div>
        <div class="upd-progress d-none" id="upd-progress" aria-live="polite">
          <div class="upd-bar"><span id="upd-bar-fill"></span></div>
          <span class="upd-progress-text" id="upd-progress-text"></span>
        </div>
        <p class="upd-error d-none" id="upd-error" role="alert"></p>
        <footer class="upd-foot">
          <p class="upd-hint" id="upd-hint"></p>
          <div class="upd-actions">
            <button type="button" class="btn-secondary" data-upd-later id="upd-later">Later</button>
            <button type="button" class="btn-primary" id="upd-primary"></button>
          </div>
        </footer>
      </div>`;
    document.body.appendChild(el);
    UpdateNotice.overlay = el;

    el.querySelectorAll('[data-upd-later]').forEach(b => b.addEventListener('click', () => UpdateNotice.later()));
    el.querySelector('#upd-primary')?.addEventListener('click', () => UpdateNotice.primary());
  }

  private static primary(): void {
    const s = UpdateNotice.state;
    const bridge = (window as any).cyrus?.updates;
    if (!s || !bridge) return;
    if (s.status === 'ready') {
      bridge.install();
    } else if (s.status === 'available' && s.canInstall) {
      bridge.download().then((st: AppUpdateState) => UpdateNotice.apply(st)).catch(() => {});
    } else if (s.status === 'available') {
      bridge.openDownload();
      UpdateNotice.later();
    }
  }

  private static render(): void {
    const s = UpdateNotice.state;
    const el = UpdateNotice.overlay;
    if (!s || !el) return;
    const $ = (id: string) => el.querySelector(`#${id}`) as HTMLElement;
    const isMac = (window as any).cyrus?.platform === 'darwin';

    $('upd-current').textContent = s.current;
    $('upd-new').textContent = s.version || '';
    $('upd-date').textContent = s.publishedAt
      ? `Released ${new Date(s.publishedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`
      : '';
    $('upd-notes').innerHTML = UpdateNotice.notesHtml(s.notes || '');

    const progress = $('upd-progress');
    const primary = $('upd-primary') as HTMLButtonElement;
    const later = $('upd-later');
    const error = $('upd-error');
    error.textContent = s.error || '';
    error.classList.toggle('d-none', !s.error);
    progress.classList.toggle('d-none', s.status !== 'downloading' && s.status !== 'ready');
    primary.disabled = s.status === 'downloading';
    ($('upd-mark-icon')).className = s.status === 'ready' ? 'fa-solid fa-rotate-right' : 'fa-solid fa-arrow-down';

    if (s.status === 'ready') {
      $('upd-kicker').textContent = 'Ready to install';
      $('upd-title').textContent = `Cyrus ${s.version} is downloaded`;
      primary.innerHTML = '<i class="fa-solid fa-rotate-right" aria-hidden="true"></i>Restart now';
      later.textContent = 'Later';
      $('upd-hint').textContent = 'Cyrus closes, installs the update and opens again — automations pause for a few seconds. '
        + 'Choose Later and it installs the next time you quit.';
      UpdateNotice.setProgress(100, 'Downloaded');
    } else if (s.status === 'downloading') {
      $('upd-kicker').textContent = 'Downloading update';
      $('upd-title').textContent = `Cyrus ${s.version}`;
      primary.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>Downloading';
      later.textContent = 'Hide';
      $('upd-hint').textContent = 'Keep using Cyrus — the download carries on in the background.';
      const pct = s.percent || 0;
      const sizes = s.total ? ` · ${UpdateNotice.mb(s.transferred || 0)} of ${UpdateNotice.mb(s.total)}` : '';
      UpdateNotice.setProgress(pct, `${pct}%${sizes}`);
    } else {
      $('upd-kicker').textContent = 'Update available';
      $('upd-title').textContent = `Cyrus ${s.version} is out`;
      later.textContent = 'Later';
      if (s.canInstall) {
        primary.innerHTML = '<i class="fa-solid fa-arrow-down" aria-hidden="true"></i>Update now';
        $('upd-hint').textContent = 'Downloads in the background while you keep working, then restarts Cyrus once to finish. '
          + 'Your settings, connections and rules are kept.';
      } else {
        primary.innerHTML = `<i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i>${isMac ? 'Download for Mac' : 'Download'}`;
        $('upd-hint').textContent = isMac
          ? 'Opens the .dmg in your browser. Drag Cyrus into Applications and choose Replace — your settings, connections and rules are kept.'
          : 'Opens the installer in your browser. Run it over this version — your settings, connections and rules are kept.';
      }
    }
  }

  private static setProgress(pct: number, text: string): void {
    const el = UpdateNotice.overlay;
    if (!el) return;
    (el.querySelector('#upd-bar-fill') as HTMLElement).style.width = `${Math.max(0, Math.min(100, pct))}%`;
    (el.querySelector('#upd-progress-text') as HTMLElement).textContent = text;
  }

  private static renderPill(): void {
    const pill = document.getElementById('update-pill');
    const label = document.getElementById('update-pill-text');
    const s = UpdateNotice.state;
    if (!pill || !label) return;
    pill.classList.toggle('d-none', !s || s.status === 'none');
    pill.classList.toggle('is-ready', s?.status === 'ready');
    if (!s || s.status === 'none') return;
    label.textContent = s.status === 'ready' ? 'Restart to update'
      : s.status === 'downloading' ? `Updating ${s.percent || 0}%`
      : `Update ${s.version}`;
    pill.title = s.status === 'available' ? `Cyrus ${s.version} is available` : `Cyrus ${s.version}`;
  }

  private static mb(bytes: number): string {
    return `${Math.round(bytes / 1e6)} MB`;
  }

  /**
   * Release notes are Markdown written for the GitHub release page. Render the
   * few constructs they use (headings, bullets, bold, italics); everything is
   * escaped first, so nothing in them can inject markup.
   */
  private static notesHtml(md: string): string {
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inline = (t: string) => esc(t)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    const out: string[] = [];
    let para: string[] = [];
    let list: string[] = [];
    const flush = () => {
      if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
      if (list.length) out.push(`<ul>${list.map(li => `<li>${inline(li)}</li>`).join('')}</ul>`);
      para = [];
      list = [];
    };
    for (const raw of md.replace(/\r/g, '').split('\n')) {
      const line = raw.trim();
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      const bullet = /^[-*]\s+(.*)$/.exec(line);
      if (!line) flush();
      else if (heading) { flush(); out.push(`<h4>${inline(heading[1])}</h4>`); }
      else if (bullet) { if (para.length) flush(); list.push(bullet[1]); }
      else { if (list.length) flush(); para.push(line); }
    }
    flush();
    return out.join('') || '<p>See the release page for details.</p>';
  }
}

UpdateNotice.install();
