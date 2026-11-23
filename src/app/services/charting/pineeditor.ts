/*
 * Charts page: the Pine Editor, a resizable panel docked under the chart
 * (like TradingView's). Write or paste a script, see compile errors as you
 * type, save it to your indicator library and add it to the chart. Saving a
 * script that's already on the chart redraws it there.
 *
 * The code area is a <textarea> laid over a syntax-highlighted <pre> with the
 * same metrics, so there's no editor dependency to bundle.
 */

interface PineEditorHost {
  /** Add a saved script to the chart. */
  addToChart(scriptId: number): void;
  /** How many indicators on the chart use this script. */
  usesOnChart(scriptId: number): number;
  /** Take a deleted script off the chart. */
  removeFromChart(scriptId: number): void;
  /** The chart's runtime error for a script, if it failed there. */
  chartError(scriptId: number): string | null;
  /** The panel opened, closed or was resized. */
  layout(): void;
}

interface PineEditorDraft { id: number | null; name: string; text: string; }

const PINE_KEYWORDS = new Set(['if', 'else', 'for', 'to', 'by', 'in', 'while', 'break', 'continue', 'switch', 'var',
  'varip', 'and', 'or', 'not', 'import', 'export', 'type', 'method', 'enum']);
const PINE_TYPES = new Set(['int', 'float', 'bool', 'string', 'color', 'series', 'simple', 'const', 'array', 'table', 'line', 'label', 'box']);
const PINE_OUTPUTS = new Set(['indicator', 'plot', 'plotshape', 'plotchar', 'plotarrow', 'hline', 'fill', 'bgcolor',
  'barcolor', 'alertcondition', 'alert', 'strategy', 'study', 'library']);
const PINE_VARS = new Set(['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'time', 'bar_index',
  'last_bar_index', 'na', 'true', 'false']);

class PineEditor {
  private el: {
    name: HTMLInputElement; dirty: HTMLElement; text: HTMLTextAreaElement; hl: HTMLElement; gutter: HTMLElement;
    console: HTMLElement; add: HTMLButtonElement; save: HTMLButtonElement; openMenu: HTMLElement; moreMenu: HTMLElement;
    file: HTMLInputElement;
  };
  private id: number | null = null;
  private savedName = '';
  private savedText = '';
  private errorLine = 0;
  private compileTimer: ReturnType<typeof setTimeout> | null = null;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private unsub: (() => void) | null = null;
  private readonly onDocDown = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (!t.closest('.pe-menu-wrap')) this.closeMenus();
  };

  private static readonly HEIGHT_KEY = 'cyrus_pine_editor_height';
  private static readonly OPEN_KEY = 'cyrus_pine_editor_open';

  constructor(private root: HTMLElement, private host: PineEditorHost) {
    root.innerHTML = `
      <div class="pe-resize" title="Drag to resize" aria-hidden="true"></div>
      <div class="pe-head">
        <i class="fa-solid fa-code pe-logo" aria-hidden="true"></i>
        <input class="pe-name" maxlength="80" spellcheck="false" aria-label="Script name" placeholder="Untitled script">
        <span class="pe-dirty d-none" title="Unsaved changes">●</span>
        <div class="pe-menu-wrap">
          <button type="button" class="ct-icon-btn" data-pe="open" title="Open a script" aria-haspopup="true"><i class="fa-regular fa-folder-open"></i></button>
          <div class="ct-menu pe-menu d-none" data-menu="open" role="menu"></div>
        </div>
        <span class="ct-spacer"></span>
        <button type="button" class="ct-btn" data-pe="save" title="Save to your indicators (Ctrl+S)"><i class="fa-solid fa-floppy-disk" aria-hidden="true"></i>Save</button>
        <button type="button" class="ct-btn pe-add" data-pe="add" title="Ctrl+Enter"><i class="fa-solid fa-plus" aria-hidden="true"></i><span>Add to chart</span></button>
        <div class="pe-menu-wrap">
          <button type="button" class="ct-icon-btn" data-pe="more" title="More" aria-haspopup="true"><i class="fa-solid fa-ellipsis"></i></button>
          <div class="ct-menu pe-menu pe-menu-right d-none" data-menu="more" role="menu">
            <button type="button" class="ct-menu-item" data-pe="new"><i class="fa-solid fa-plus"></i>New indicator</button>
            <button type="button" class="ct-menu-item" data-pe="copy"><i class="fa-regular fa-copy"></i>Make a copy</button>
            <button type="button" class="ct-menu-item" data-pe="import"><i class="fa-solid fa-file-import"></i>Open a .pine file…</button>
            <button type="button" class="ct-menu-item" data-pe="export"><i class="fa-solid fa-file-export"></i>Save as a .pine file</button>
            <div class="ct-menu-sep"></div>
            <button type="button" class="ct-menu-item ct-danger" data-pe="delete"><i class="fa-solid fa-trash-can"></i>Delete script</button>
          </div>
        </div>
        <button type="button" class="ct-icon-btn" data-pe="close" title="Close the editor" aria-label="Close the editor"><i class="fa-solid fa-xmark"></i></button>
        <input type="file" class="d-none" accept=".pine,.txt,text/plain" data-pe="file">
      </div>
      <div class="pe-body">
        <div class="pe-gutter" aria-hidden="true"></div>
        <div class="pe-code">
          <pre class="pe-hl" aria-hidden="true"></pre>
          <textarea class="pe-text" spellcheck="false" wrap="off" autocapitalize="off" autocomplete="off" aria-label="Pine Script code"></textarea>
        </div>
      </div>
      <div class="pe-console" role="status" aria-live="polite"></div>`;
    const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
    this.el = {
      name: q('.pe-name'), dirty: q('.pe-dirty'), text: q('.pe-text'), hl: q('.pe-hl'), gutter: q('.pe-gutter'),
      console: q('.pe-console'), add: q('[data-pe="add"]'), save: q('[data-pe="save"]'),
      openMenu: q('[data-menu="open"]'), moreMenu: q('[data-menu="more"]'), file: q('[data-pe="file"]'),
    };
    this.bind();
    this.unsub = CustomIndicators.onChange(() => this.syncButtons());
    document.addEventListener('mousedown', this.onDocDown);
    let h = 300;
    try { h = Number(localStorage.getItem(PineEditor.HEIGHT_KEY)) || 300; } catch { /* storage off */ }
    root.style.height = `${Math.max(160, Math.min(h, window.innerHeight * 0.7))}px`;
    this.restoreDraft();
    let wasOpen = false;
    try { wasOpen = localStorage.getItem(PineEditor.OPEN_KEY) === '1'; } catch { /* storage off */ }
    if (wasOpen) this.open();
  }

  get isOpen(): boolean { return !this.root.classList.contains('d-none'); }

  private get draftKey(): string { return `cyrus_pine_draft_${AuthController.getUser()?.id ?? 'anon'}`; }

  private get dirty(): boolean {
    return this.el.text.value !== this.savedText || this.el.name.value.trim() !== this.savedName;
  }

  // ── Opening and closing ───────────────────────────────────────────────

  /** Show the panel; with a script id, open that script (asking first if there are unsaved edits). */
  open(scriptId?: number | null): void {
    this.root.classList.remove('d-none');
    try { localStorage.setItem(PineEditor.OPEN_KEY, '1'); } catch { /* storage off */ }
    if (scriptId != null && scriptId !== this.id) this.load(scriptId);
    else if (scriptId === null) this.newScript();
    this.render();
    this.host.layout();
    requestAnimationFrame(() => this.el.text.focus());
  }

  close(): void {
    this.saveDraftNow();
    this.root.classList.add('d-none');
    try { localStorage.setItem(PineEditor.OPEN_KEY, '0'); } catch { /* storage off */ }
    this.closeMenus();
    this.host.layout();
  }

  toggle(): void {
    if (this.isOpen) this.close(); else this.open();
  }

  destroy(): void {
    this.saveDraftNow();
    this.unsub?.();
    document.removeEventListener('mousedown', this.onDocDown);
    if (this.compileTimer) clearTimeout(this.compileTimer);
    if (this.draftTimer) clearTimeout(this.draftTimer);
  }

  private confirmDiscard(): boolean {
    return !this.dirty || window.confirm(`Discard your unsaved changes to "${this.el.name.value.trim() || 'Untitled script'}"?`);
  }

  private setScript(id: number | null, name: string, text: string, savedName: string, savedText: string): void {
    this.id = id;
    this.savedName = savedName;
    this.savedText = savedText;
    this.el.name.value = name;
    this.el.text.value = text;
    this.el.text.scrollTop = 0;
    this.el.text.setSelectionRange(0, 0);
    this.render();
    this.compileNow();
    this.saveDraftNow();
  }

  private load(id: number): void {
    const row = CustomIndicators.get(id);
    if (!row || !this.confirmDiscard()) return;
    this.setScript(row.id, row.name, row.source, row.name, row.source);
  }

  newScript(): void {
    if (!this.confirmDiscard()) return;
    const name = CustomIndicators.uniqueName('My indicator');
    this.setScript(null, name, PINE_NEW_SCRIPT.replace('"My indicator"', JSON.stringify(name)), '', '');
  }

  private restoreDraft(): void {
    let d: PineEditorDraft | null = null;
    try { d = JSON.parse(localStorage.getItem(this.draftKey) || 'null'); } catch { d = null; }
    if (d && typeof d.text === 'string') {
      this.id = typeof d.id === 'number' ? d.id : null;
      this.el.name.value = d.name || '';
      this.el.text.value = d.text;
      // Saved versions arrive with the library; until then treat it as edited.
      this.savedText = '\u0000';
      void CustomIndicators.ensureLoaded().then(() => {
        const row = this.id != null ? CustomIndicators.get(this.id) : undefined;
        if (this.id != null && !row) this.id = null;
        this.savedName = row?.name ?? '';
        this.savedText = row?.source ?? '';
        this.render();
      });
    } else {
      this.setScript(null, 'My indicator', PINE_NEW_SCRIPT, '', '');
    }
    this.render();
    this.compileNow();
  }

  private saveDraftNow(): void {
    const d: PineEditorDraft = { id: this.id, name: this.el.name.value, text: this.el.text.value };
    try { localStorage.setItem(this.draftKey, JSON.stringify(d)); } catch { /* storage off */ }
  }

  // ── Saving ────────────────────────────────────────────────────────────

  /** Save to the library. Returns the script id, or null if it couldn't be saved. */
  private async save(): Promise<number | null> {
    if (this.busy) return null;
    const text = this.el.text.value;
    let name = this.el.name.value.trim();
    if (!text.trim()) { this.message('error', 'The script is empty.'); return null; }
    if (!name) {
      const c = PineEngine.compile(text).compiled;
      name = CustomIndicators.uniqueName(c?.title || 'My indicator');
      this.el.name.value = name;
    }
    this.busy = true;
    this.el.save.disabled = true;
    try {
      let row: CustomIndicatorRow;
      if (this.id != null && CustomIndicators.get(this.id)) {
        row = await CustomIndicators.update(this.id, { name, source: text });
      } else {
        row = await CustomIndicators.create(name, text);
      }
      this.id = row.id;
      this.savedName = row.name;
      this.savedText = row.source;
      this.el.name.value = row.name;
      this.saveDraftNow();
      this.render();
      this.compileNow(true);
      return row.id;
    } catch (err: any) {
      this.message('error', `Couldn’t save: ${err?.message || err}`);
      return null;
    } finally {
      this.busy = false;
      this.el.save.disabled = false;
    }
  }

  /** Add to chart (saving first), or redraw it if it's already there. */
  private async addOrUpdate(): Promise<void> {
    const { error } = PineEngine.compile(this.el.text.value);
    if (error) {
      this.compileNow();
      this.message('error', `Fix this first. ${PineEngine.describe(error)}`, error.line);
      return;
    }
    const wasOnChart = this.id != null && this.host.usesOnChart(this.id) > 0;
    const id = this.dirty || this.id == null || !CustomIndicators.get(this.id) ? await this.save() : this.id;
    if (id == null) return;
    if (!wasOnChart) this.host.addToChart(id);
    this.syncButtons();
    // The chart runs it now; show a runtime failure here too.
    setTimeout(() => {
      const err = this.host.chartError(id);
      if (err) this.message('error', `On the chart: ${err}`, Number(/^Line (\d+)/.exec(err)?.[1]) || 0);
    }, 60);
  }

  private async copy(): Promise<void> {
    const base = `${this.el.name.value.trim() || 'My indicator'} copy`;
    const name = CustomIndicators.uniqueName(base);
    try {
      const row = await CustomIndicators.create(name, this.el.text.value);
      this.setScript(row.id, row.name, row.source, row.name, row.source);
      this.message('ok', `Saved a copy as "${row.name}".`);
    } catch (err: any) {
      this.message('error', `Couldn’t copy: ${err?.message || err}`);
    }
  }

  private async remove(): Promise<void> {
    if (this.id == null || !CustomIndicators.get(this.id)) {
      if (window.confirm('Throw away this unsaved script?')) this.setScript(null, '', '', '', '');
      return;
    }
    const uses = this.host.usesOnChart(this.id);
    const name = this.savedName || 'this script';
    const note = uses ? ` It will also come off this chart.` : '';
    if (!window.confirm(`Delete "${name}" from your indicators?${note} Other saved charts that use it will show it as deleted.`)) return;
    const id = this.id;
    try {
      await CustomIndicators.remove(id);
      this.host.removeFromChart(id);
      this.setScript(null, '', '', '', '');
      this.newScript();
      this.message('ok', `Deleted "${name}".`);
    } catch (err: any) {
      this.message('error', `Couldn’t delete: ${err?.message || err}`);
    }
  }

  private importFile(file: File): void {
    if (file.size > 64 * 1024) { this.message('error', 'That file is too big for a script (64 KB max).'); return; }
    void file.text().then((text) => {
      if (!this.confirmDiscard()) return;
      const c = PineEngine.compile(text).compiled;
      const name = CustomIndicators.uniqueName(c?.title || file.name.replace(/\.(pine|txt)$/i, '') || 'Imported indicator');
      this.setScript(null, name, text, '', '');
      this.message('ok', `Opened ${file.name}. Save it to keep it.`);
    });
  }

  private exportFile(): void {
    const name = (this.el.name.value.trim() || 'indicator').replace(/[\\/:*?"<>|]+/g, '_');
    const url = URL.createObjectURL(new Blob([this.el.text.value], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.pine`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ── UI ────────────────────────────────────────────────────────────────

  private bind(): void {
    const t = this.el.text;
    t.addEventListener('input', () => this.onEdit());
    t.addEventListener('scroll', () => this.syncScroll());
    t.addEventListener('keydown', (e) => this.onKey(e));
    this.el.name.addEventListener('input', () => { this.render(); this.queueDraft(); });
    this.el.name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); t.focus(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); void this.save(); }
    });
    this.root.querySelectorAll<HTMLElement>('[data-pe]').forEach((b) => b.addEventListener('click', (e) => {
      const act = b.dataset.pe;
      if (act === 'file') return;
      e.stopPropagation();
      if (act !== 'open' && act !== 'more') this.closeMenus();
      switch (act) {
        case 'open': this.toggleMenu('open'); break;
        case 'more': this.toggleMenu('more'); break;
        case 'save': void this.save().then((id) => { if (id != null) this.message('ok', this.host.usesOnChart(id) ? 'Saved. The chart is updated.' : 'Saved to your indicators.'); }); break;
        case 'add': void this.addOrUpdate(); break;
        case 'new': this.newScript(); break;
        case 'copy': void this.copy(); break;
        case 'import': this.el.file.click(); break;
        case 'export': this.exportFile(); break;
        case 'delete': void this.remove(); break;
        case 'close': this.close(); break;
      }
    }));
    this.el.file.addEventListener('change', () => {
      const f = this.el.file.files?.[0];
      if (f) this.importFile(f);
      this.el.file.value = '';
    });
    this.el.console.addEventListener('click', (e) => {
      const line = Number((e.target as HTMLElement).closest<HTMLElement>('[data-line]')?.dataset.line);
      if (line) this.goToLine(line);
    });
    // Drag the top edge to resize.
    const handle = this.root.querySelector('.pe-resize') as HTMLElement;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startY = e.clientY, startH = this.root.offsetHeight;
      const move = (ev: MouseEvent) => {
        const h = Math.max(160, Math.min(window.innerHeight * 0.75, startH + (startY - ev.clientY)));
        this.root.style.height = `${h}px`;
        this.host.layout();
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        try { localStorage.setItem(PineEditor.HEIGHT_KEY, String(this.root.offsetHeight)); } catch { /* storage off */ }
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  private toggleMenu(which: 'open' | 'more'): void {
    const menu = which === 'open' ? this.el.openMenu : this.el.moreMenu;
    const show = menu.classList.contains('d-none');
    this.closeMenus();
    if (!show) return;
    if (which === 'open') this.renderOpenMenu();
    menu.classList.remove('d-none');
  }

  private closeMenus(): void {
    this.el.openMenu.classList.add('d-none');
    this.el.moreMenu.classList.add('d-none');
  }

  private renderOpenMenu(): void {
    const esc = ChartWorkspace.esc;
    const list = CustomIndicators.scripts;
    this.el.openMenu.innerHTML = `<div class="ct-menu-head">Your indicators</div>` +
      (list.length ? list.map((s) => `<button type="button" class="ct-menu-chart${s.id === this.id ? ' active' : ''}" data-open-id="${s.id}" role="menuitem">
          <span class="ct-mc-name">${esc(s.name)}</span>
          <span class="ct-mc-meta">${this.host.usesOnChart(s.id) ? 'On this chart · ' : ''}edited ${esc(this.ago(s.updated_at))}</span>
        </button>`).join('') : '<p class="ct-menu-empty">Nothing saved yet.</p>') +
      `<div class="ct-menu-sep"></div><button type="button" class="ct-menu-item" data-open-new="1"><i class="fa-solid fa-plus"></i>New indicator</button>`;
    this.el.openMenu.querySelectorAll<HTMLElement>('[data-open-id]').forEach((b) => b.addEventListener('click', () => {
      this.closeMenus();
      this.load(Number(b.dataset.openId));
    }));
    this.el.openMenu.querySelector('[data-open-new]')?.addEventListener('click', () => { this.closeMenus(); this.newScript(); });
  }

  private ago(sqlTime: string): string {
    const t = Date.parse(String(sqlTime).replace(' ', 'T') + 'Z');
    if (!isFinite(t)) return '';
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  private syncButtons(): void {
    const on = this.id != null && this.host.usesOnChart(this.id) > 0;
    const label = this.el.add.querySelector('span');
    if (label) label.textContent = on ? 'Update on chart' : 'Add to chart';
    this.el.add.querySelector('i')!.className = on ? 'fa-solid fa-rotate' : 'fa-solid fa-plus';
    this.el.dirty.classList.toggle('d-none', !this.dirty);
  }

  private onEdit(): void {
    this.render();
    this.queueDraft();
    if (this.compileTimer) clearTimeout(this.compileTimer);
    this.compileTimer = setTimeout(() => this.compileNow(), 350);
  }

  private queueDraft(): void {
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => this.saveDraftNow(), 800);
  }

  private render(): void {
    const text = this.el.text.value;
    this.el.hl.innerHTML = PineEditor.highlight(text) + '\n';
    const lines = text.split('\n').length;
    let g = '';
    for (let i = 1; i <= lines; i++) g += `<div${i === this.errorLine ? ' class="pe-err-line"' : ''}>${i}</div>`;
    this.el.gutter.innerHTML = g;
    this.syncScroll();
    this.syncButtons();
  }

  private syncScroll(): void {
    const t = this.el.text;
    this.el.hl.style.transform = `translate(${-t.scrollLeft}px, ${-t.scrollTop}px)`;
    this.el.gutter.style.transform = `translateY(${-t.scrollTop}px)`;
  }

  private compileNow(justSaved = false): void {
    const text = this.el.text.value;
    if (!text.trim()) { this.errorLine = 0; this.message('info', 'Write or paste a Pine Script (v5 or v6) indicator.'); this.render(); return; }
    const { compiled, error } = PineEngine.compile(text);
    const prev = this.errorLine;
    if (error) {
      this.errorLine = error.line;
      this.message('error', PineEngine.describe(error), error.line);
    } else if (compiled) {
      this.errorLine = 0;
      const n = (k: string) => compiled.outputs.filter((o) => o.kind === k).length;
      const bits = [`${n('plot')} plot${n('plot') === 1 ? '' : 's'}`];
      if (compiled.inputs.length) bits.push(`${compiled.inputs.length} input${compiled.inputs.length === 1 ? '' : 's'}`);
      if (compiled.alertConditions.length) bits.push(`${compiled.alertConditions.length} alert condition${compiled.alertConditions.length === 1 ? '' : 's'}`);
      const where = compiled.overlay ? 'on the price chart' : 'in its own pane';
      const warn = compiled.warnings.length ? ` ${compiled.warnings.join(' ')}` : '';
      this.message('ok', `${justSaved ? 'Saved. ' : ''}Compiled: "${compiled.shorttitle || compiled.title}" draws ${where} · ${bits.join(' · ')}.${warn}`);
    }
    if (prev !== this.errorLine) this.render();
  }

  private message(kind: 'ok' | 'error' | 'info', text: string, line = 0): void {
    const esc = ChartWorkspace.esc;
    const icon = kind === 'ok' ? 'fa-circle-check' : kind === 'error' ? 'fa-circle-exclamation' : 'fa-circle-info';
    this.el.console.className = `pe-console pe-${kind}`;
    this.el.console.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i> ${line
      ? `<button type="button" class="pe-goto" data-line="${line}" title="Go to line ${line}">${esc(text)}</button>`
      : `<span>${esc(text)}</span>`}`;
  }

  private goToLine(line: number): void {
    const t = this.el.text;
    const lines = t.value.split('\n');
    let pos = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
    t.focus();
    t.setSelectionRange(pos, pos + (lines[line - 1]?.length || 0));
    const lh = parseFloat(getComputedStyle(t).lineHeight) || 18;
    t.scrollTop = Math.max(0, (line - 4) * lh);
    this.syncScroll();
  }

  // ── Keys ──────────────────────────────────────────────────────────────

  /** Replace the selection, keeping the textarea's own undo history. */
  private insert(text: string): void {
    const t = this.el.text;
    if (!document.execCommand('insertText', false, text)) {
      t.setRangeText(text, t.selectionStart, t.selectionEnd, 'end');
      this.onEdit();
    }
  }

  private onKey(e: KeyboardEvent): void {
    const t = this.el.text;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); void this.save(); return; }
    if (mod && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void this.addOrUpdate(); return; }
    if (e.key === 'Escape') { e.stopPropagation(); return; }
    if (mod && e.key === '/') { e.preventDefault(); this.toggleComment(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      const v = t.value, s = t.selectionStart, en = t.selectionEnd;
      if (s === en && !e.shiftKey) { this.insert('    '); return; }
      // Indent / outdent every selected line.
      const start = v.lastIndexOf('\n', s - 1) + 1;
      const block = v.slice(start, en);
      const next = block.split('\n').map((l) => (e.shiftKey ? l.replace(/^( {1,4}|\t)/, '') : `    ${l}`)).join('\n');
      t.setSelectionRange(start, en);
      this.insert(next);
      t.setSelectionRange(start, start + next.length);
      return;
    }
    if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      const v = t.value, s = t.selectionStart;
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      const line = v.slice(lineStart, s);
      let indent = /^\s*/.exec(line)![0];
      const code = line.replace(/\/\/.*$/, '').trim();
      if (/=>$/.test(code) || /^(if|else|for|while|switch)\b/.test(code) || /=\s*(if|switch)\b/.test(code)) indent += '    ';
      this.insert(`\n${indent}`);
    }
  }

  private toggleComment(): void {
    const t = this.el.text;
    const v = t.value, s = t.selectionStart, en = t.selectionEnd;
    const start = v.lastIndexOf('\n', s - 1) + 1;
    let end = v.indexOf('\n', en === s ? en : en - 1);
    if (end < 0) end = v.length;
    const lines = v.slice(start, end).split('\n');
    const allCommented = lines.every((l) => !l.trim() || /^\s*\/\//.test(l));
    const next = lines.map((l) => {
      if (!l.trim()) return l;
      return allCommented ? l.replace(/^(\s*)\/\/ ?/, '$1') : l.replace(/^(\s*)/, '$1// ');
    }).join('\n');
    t.setSelectionRange(start, end);
    this.insert(next);
    t.setSelectionRange(start, start + next.length);
  }

  // ── Highlighting ──────────────────────────────────────────────────────

  static highlight(src: string): string {
    const esc = (s: string) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
    const re = /(\/\/@version=\d+)|(\/\/.*)|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?)|(#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b)|(\b\d+(?:\.\d*)?(?:[eE][+-]?\d+)?\b|\.\d+\b)|([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)(\s*\()?|(:=|=>|==|!=|<=|>=|[-+*/%<>=?:])/g;
    let out = '', last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      out += esc(src.slice(last, m.index));
      last = re.lastIndex;
      const [all, ver, comment, str, color, num, ident, call, op] = m;
      if (ver) out += `<span class="pe-t-ann">${esc(ver)}</span>`;
      else if (comment) out += `<span class="pe-t-com">${esc(comment)}</span>`;
      else if (str) out += `<span class="pe-t-str">${esc(str)}</span>`;
      else if (color) out += `<span class="pe-t-col" style="border-bottom-color:${color}">${esc(color)}</span>`;
      else if (num) out += `<span class="pe-t-num">${esc(num)}</span>`;
      else if (ident) {
        let cls = '';
        if (PINE_KEYWORDS.has(ident)) cls = 'pe-t-kw';
        else if (PINE_TYPES.has(ident)) cls = 'pe-t-type';
        else if (PINE_OUTPUTS.has(ident)) cls = 'pe-t-out';
        else if (call) cls = 'pe-t-fn';
        else if (PINE_VARS.has(ident) || ident.includes('.')) cls = 'pe-t-var';
        out += cls ? `<span class="${cls}">${esc(ident)}</span>` : esc(ident);
        if (call) out += esc(call);
      } else if (op) out += `<span class="pe-t-op">${esc(op)}</span>`;
      else out += esc(all);
    }
    return out + esc(src.slice(last));
  }
}
