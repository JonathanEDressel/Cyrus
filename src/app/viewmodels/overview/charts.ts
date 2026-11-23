(function () {

interface ChartDraft {
  id: number | null;
  name: string;
  state: ChartState;
  at: number;
}

const TF_LABELS: Record<string, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '4h': '4H', '1d': '1D', '1w': '1W',
};

class ChartsController {
  private ws: ChartWorkspace | null = null;
  private charts: ChartSummary[] = [];
  private currentId: number | null = null;
  private name = 'Untitled';
  private savedSnap = '';
  private lastSnap = '';
  private undo: string[] = [];
  private redo: string[] = [];
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private pairCache = new Map<string, any[]>();
  private pairMode: { kind: 'compare' } | { kind: 'symbol'; paneId: string } = { kind: 'compare' };
  private nameResolve: ((v: string | null) => void) | null = null;
  private indTarget: string | null = null;
  private saving = false;
  /** Set once the first chart is on screen; drafts aren't written before then. */
  private opened = false;
  private alertTimer: ReturnType<typeof setInterval> | null = null;
  private unsubAlerts: (() => void) | null = null;
  private unsubScriptAlerts: (() => void) | null = null;
  private editor: PineEditor | null = null;
  /** The indicator the Create Alert dialog is for. */
  private salertFor: { paneId: string; indId: string } | null = null;
  private static readonly HISTORY_MAX = 100;

  private readonly onKeydown = (e: KeyboardEvent) => this.keydown(e);
  private readonly onDocClick = (e: MouseEvent) => this.docClick(e);

  constructor() {
    void this.init();
  }

  private $(id: string): HTMLElement | null { return document.getElementById(id); }
  private esc(s: string): string { return ChartWorkspace.esc(s); }

  private get userKey(): string { return String(AuthController.getUser()?.id ?? 'anon'); }
  private get lastKey(): string { return `cyrus_chart_last_${this.userKey}`; }

  // ── Setup ─────────────────────────────────────────────────────────────────

  private async init(): Promise<void> {
    const stage = this.$('ct-stage');
    if (!stage) return;
    this.renderTimeframes();
    this.renderTools();
    this.bindToolbar();

    this.ws = new ChartWorkspace(stage, {
      mode: 'edit',
      onChange: () => this.onChange(),
      onPaneAction: (paneId, action, anchor) => {
        if (action === 'symbol') void this.openPairPicker({ kind: 'symbol', paneId });
        else this.openIndicatorMenu(anchor, paneId);
      },
      onScriptAction: (action, paneId, indId) => {
        const spec = this.ws?.paneState(paneId)?.indicators.find((i) => i.id === indId);
        if (!spec) return;
        if (action === 'edit') this.editor?.open(spec.scriptId ?? null);
        else this.openScriptAlert(paneId, indId);
      },
    });
    const editorEl = this.$('ct-editor');
    if (editorEl) {
      this.editor = new PineEditor(editorEl, {
        addToChart: (id) => {
          const ws = this.ws;
          if (!ws) return;
          // Into the pane whose symbol is selected for indicators, else the first.
          const target = this.indTarget && this.indTarget !== '*' && ws.paneState(this.indTarget) ? this.indTarget : ws.state.panes[0].id;
          ws.addScript(target, id);
        },
        usesOnChart: (id) => this.ws?.scriptUses(id).length || 0,
        removeFromChart: (id) => {
          const ws = this.ws;
          if (!ws) return;
          ws.scriptUses(id).forEach((u) => ws.removeIndicator(u.paneId, u.indId));
        },
        chartError: (id) => {
          const ws = this.ws;
          const use = ws?.scriptUses(id)[0];
          return use ? ws!.scriptRun(use.paneId, use.indId)?.error ?? null : null;
        },
        layout: () => this.syncEditorButton(),
      });
      this.syncEditorButton();
    }
    const dc = this.ws.drawing!;
    dc.onToolChange = () => this.syncTools();
    dc.onSelectionChange = (d) => this.renderStyleBar(d);
    // Alerts follow their line: moved with it, removed with it.
    dc.onDrawingsMoved = (ds) => ds.forEach((d) => {
      if (d.alertId != null) ChartAlerts.moveFor(d).catch((err) => this.showError(`Couldn’t move the alert: ${this.msg(err)}`));
    });
    dc.onDrawingsRemoved = (ds) => ds.forEach((d) => { if (d.alertId != null) void ChartAlerts.remove(d.alertId); });
    this.unsubAlerts = ChartAlerts.onChange(() => this.syncAlerts());
    this.unsubScriptAlerts = ScriptAlerts.onChange(() => this.syncAlerts());
    void ScriptAlerts.ensureLoaded();
    // Fired alerts change state server-side; keep the list current.
    this.alertTimer = setInterval(() => { if (!document.hidden) void ChartAlerts.refresh(); }, 60_000);

    document.addEventListener('keydown', this.onKeydown);
    document.addEventListener('mousedown', this.onDocClick);
    const observer = new MutationObserver(() => {
      if (!document.getElementById('charts-root')) {
        this.flushDraft();
        document.removeEventListener('keydown', this.onKeydown);
        document.removeEventListener('mousedown', this.onDocClick);
        if (this.alertTimer) clearInterval(this.alertTimer);
        this.unsubAlerts?.();
        this.unsubScriptAlerts?.();
        this.editor?.destroy();
        this.editor = null;
        this.ws?.destroy();
        this.ws = null;
        observer.disconnect();
      }
    });
    const content = document.getElementById('app-content');
    if (content) observer.observe(content, { childList: true });

    await ChartWorkspace.loadSources();
    if (!this.ws) return;
    this.syncToolbar();
    await this.openInitial();
  }

  private async openInitial(): Promise<void> {
    const params = (window as any).__routeParams || {};
    // Drafts used to share one slot and were offered back with a prompt.
    this.storageRemove(`cyrus_chart_draft_${this.userKey}`);
    await this.loadList();
    if (!this.ws) return;
    let id: number | null = params.chartId ? Number(params.chartId) : null;
    const last = this.storageGet(this.lastKey);
    if (!id && last && last !== 'new') {
      const n = Number(last);
      if (this.charts.some((c) => c.id === n)) id = n;
    }
    if (!id && last !== 'new' && this.charts.length) id = this.charts[0].id;
    if (id) await this.openChart(id);
    else this.openNewChart(true);
    this.opened = true;
  }

  // ── Saved charts ──────────────────────────────────────────────────────────

  private async loadList(): Promise<void> {
    try {
      const resp = await ChartData.list();
      this.charts = resp.data || [];
      this.showError(null);
    } catch (err: any) {
      this.charts = [];
      this.showError(`Couldn’t load your saved charts: ${this.msg(err)}`);
    }
    this.renderChartList();
  }

  /**
   * Open a saved chart. Any unsaved changes to the chart being left are kept
   * as its draft, and this chart's own draft (if it has one) comes back
   * as it was, still marked unsaved.
   */
  private async openChart(id: number, restore = true, keepCurrent = true): Promise<void> {
    if (keepCurrent) this.flushDraft();
    try {
      const resp = await ChartData.get(id);
      const chart = resp.data;
      if (!chart || !this.ws) return;
      this.ws.drawing?.setTool('cursor');
      this.ws.loadState(chart.state || ChartWorkspace.defaultState());
      this.currentId = chart.id;
      this.name = chart.name;
      this.resetHistory();
      if (restore) this.restoreDraft();
      this.storageSet(this.lastKey, String(chart.id));
      this.syncToolbar();
    } catch (err: any) {
      this.showError(`Couldn’t open that chart: ${this.msg(err)}`);
      if (!this.opened) this.openNewChart(true);
    }
  }

  /**
   * Switch to the unsaved "new chart". With `restore`, an unsaved new chart
   * from before comes back; otherwise a fresh one starts on the coin that's
   * on screen.
   */
  private openNewChart(restore: boolean): void {
    if (!this.ws) return;
    if (!restore) {
      const pending = this.readDraft(null);
      const onIt = this.currentId == null && this.isDirty();
      if ((pending || onIt) && !window.confirm(`Discard the unsaved chart “${onIt ? this.name : pending!.name}” and start a new one?`)) return;
      this.clearDraft(null);
    }
    if (this.currentId != null) this.flushDraft();
    const first = this.ws.state.panes[0];
    this.ws.drawing?.setTool('cursor');
    this.ws.loadState(ChartWorkspace.defaultState(restore ? 'BTC/USD' : first?.symbol, restore ? 'coinbase' : first?.source));
    this.currentId = null;
    this.name = 'Untitled';
    this.resetHistory();
    if (restore) this.restoreDraft();
    this.storageSet(this.lastKey, 'new');
    this.syncToolbar();
  }

  /** Put back unsaved changes to the chart just opened, quietly. */
  private restoreDraft(): void {
    const draft = this.readDraft(this.currentId);
    if (!draft || !this.ws) return;
    if (this.currentId != null && this.snap(draft.state) === this.savedSnap) { this.clearDraft(this.currentId); return; }
    const before = this.lastSnap;
    this.ws.loadState(draft.state);
    if (this.currentId == null) this.name = draft.name || 'Untitled';
    this.lastSnap = this.snap(this.ws.getState());
    // Still unsaved; one undo goes back to the saved version.
    this.undo = [before];
    this.redo = [];
  }

  /** Throw away unsaved changes: back to the saved chart (or a fresh one). */
  private async discardChanges(): Promise<void> {
    if (!this.isDirty()) return;
    if (!window.confirm(`Discard your unsaved changes to “${this.name}”?`)) return;
    if (this.currentId == null) {
      this.clearDraft(null);
      this.resetHistory();
      this.openNewChart(true);
      return;
    }
    const id = this.currentId;
    this.clearDraft(id);
    await this.openChart(id, false, false);
  }

  private async save(): Promise<void> {
    if (!this.ws || this.saving) return;
    if (this.currentId == null) { await this.saveAs(true); return; }
    this.saving = true;
    this.setSaveLabel('Saving…');
    try {
      const state = this.ws.getState();
      await ChartData.update(this.currentId, { state });
      this.savedSnap = this.snap(state);
      this.clearDraft(this.currentId);
      this.setSaveLabel('Saved');
      void this.loadList();
    } catch (err: any) {
      this.setSaveLabel('Save');
      this.showError(`Couldn’t save: ${this.msg(err)}`);
    } finally {
      this.saving = false;
      this.syncDirty();
      setTimeout(() => this.setSaveLabel('Save'), 1500);
    }
  }

  /** Save under a new name: the first save of a new chart, or "Save a copy". */
  private async saveAs(first: boolean): Promise<void> {
    if (!this.ws) return;
    const suggested = first ? (this.name === 'Untitled' ? this.suggestName() : this.name) : `${this.name} (copy)`;
    const name = await this.askName(first ? 'Save chart' : 'Save a copy', suggested, 'Save');
    if (!name) return;
    try {
      const state = this.ws.getState();
      const resp = await ChartData.create(name, state);
      const chart = resp.data!;
      // The changes now live in the new chart; the one they came from is
      // left as it was last saved.
      this.clearDraft(this.currentId);
      this.currentId = chart.id;
      this.name = chart.name;
      this.savedSnap = this.snap(state);
      this.storageSet(this.lastKey, String(chart.id));
      this.syncToolbar();
      await this.loadList();
    } catch (err: any) {
      this.showError(`Couldn’t save: ${this.msg(err)}`);
    }
  }

  private async rename(): Promise<void> {
    const name = await this.askName('Rename chart', this.name, 'Rename');
    if (!name || name === this.name) return;
    if (this.currentId == null) { this.name = name; this.syncToolbar(); this.scheduleDraft(); return; }
    try {
      await ChartData.update(this.currentId, { name });
      this.name = name;
      this.syncToolbar();
      await this.loadList();
    } catch (err: any) {
      this.showError(`Couldn’t rename: ${this.msg(err)}`);
    }
  }

  private async deleteCurrent(): Promise<void> {
    if (this.currentId == null) {
      if (this.isDirty() && !window.confirm('Discard this unsaved chart?')) return;
      this.clearDraft(null);
      this.resetHistory();
      this.openNewChart(true);
      return;
    }
    if (!window.confirm(`Delete “${this.name}”? This can’t be undone.`)) return;
    try {
      const id = this.currentId;
      await ChartData.remove(id);
      this.clearDraft(id);
      await this.loadList();
      if (this.charts.length) await this.openChart(this.charts[0].id, true, false);
      else {
        this.currentId = null;
        this.undo = [];
        this.openNewChart(true);
      }
    } catch (err: any) {
      this.showError(`Couldn’t delete: ${this.msg(err)}`);
    }
  }

  private suggestName(): string {
    const s = this.ws?.state;
    if (!s) return 'My chart';
    return `${s.panes.map((p) => p.symbol.split('/')[0]).join(' vs ')} ${TF_LABELS[s.timeframe] || s.timeframe}`;
  }

  // ── Change tracking, undo/redo, drafts ────────────────────────────────────

  /** A comparable snapshot of what gets saved (zoom isn't a change). */
  private snap(state: ChartState): string {
    const { view, ...rest } = state;
    return JSON.stringify(rest);
  }

  private resetHistory(): void {
    const s = this.ws ? this.snap(this.ws.getState()) : '';
    this.savedSnap = this.currentId == null ? '' : s;
    this.lastSnap = s;
    this.undo = [];
    this.redo = [];
    this.syncDirty();
  }

  private isDirty(): boolean {
    if (!this.ws) return false;
    const s = this.snap(this.ws.getState());
    // An untouched new chart isn't worth asking about.
    if (this.currentId == null) return this.undo.length > 0;
    return s !== this.savedSnap;
  }

  private onChange(): void {
    if (!this.ws) return;
    const now = this.snap(this.ws.getState());
    if (now === this.lastSnap) return;
    this.undo.push(this.lastSnap);
    if (this.undo.length > ChartsController.HISTORY_MAX) this.undo.shift();
    this.redo = [];
    this.lastSnap = now;
    this.syncToolbar();
    this.scheduleDraft();
  }

  private stepHistory(back: boolean): void {
    if (!this.ws) return;
    const from = back ? this.undo : this.redo;
    const to = back ? this.redo : this.undo;
    const target = from.pop();
    if (target == null) return;
    to.push(this.lastSnap);
    this.ws.loadState(JSON.parse(target));
    this.lastSnap = target;
    this.syncToolbar();
    this.scheduleDraft();
  }

  private scheduleDraft(): void {
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => this.flushDraft(), 800);
  }

  /** Keep the current chart's unsaved changes (or drop its draft if there are none). */
  private flushDraft(): void {
    if (this.draftTimer) { clearTimeout(this.draftTimer); this.draftTimer = null; }
    if (!this.ws || !this.opened) return;
    if (!this.isDirty()) { this.clearDraft(this.currentId); return; }
    const draft: ChartDraft = { id: this.currentId, name: this.name, state: this.ws.getState(), at: Date.now() };
    this.storageSet(this.draftKey(this.currentId), JSON.stringify(draft));
  }

  private draftKey(id: number | null): string {
    return `cyrus_chart_draft_${this.userKey}_${id ?? 'new'}`;
  }

  private readDraft(id: number | null): ChartDraft | null {
    try {
      const d = JSON.parse(this.storageGet(this.draftKey(id)) || 'null');
      return d && d.state ? d : null;
    } catch { return null; }
  }

  private clearDraft(id: number | null): void { this.storageRemove(this.draftKey(id)); }

  private storageGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
  private storageSet(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* full or blocked */ } }
  private storageRemove(k: string): void { try { localStorage.removeItem(k); } catch { /* blocked */ } }

  // ── Toolbar ───────────────────────────────────────────────────────────────

  private renderTimeframes(): void {
    const box = this.$('ct-timeframes');
    if (!box) return;
    box.innerHTML = ChartGeo.TIMEFRAMES.map((tf) =>
      `<button type="button" class="time-range-btn" data-tf="${tf}">${TF_LABELS[tf] || tf}</button>`).join('');
    box.querySelectorAll<HTMLButtonElement>('[data-tf]').forEach((b) =>
      b.addEventListener('click', () => this.ws?.setTimeframe(b.dataset.tf!)));
  }

  private renderTools(): void {
    const box = this.$('ct-tools');
    if (!box) return;
    const cursor = `<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path d="M4 2l10 6.5-4.4 1 2.6 5-1.8.9-2.6-5L4 13.5z" fill="currentColor"/></svg>`;
    const groups = [['trend', 'ray', 'extended', 'hline', 'hray', 'vline'], ['channel', 'fib'], ['frvp', 'avp', 'avwap'], ['rect', 'measure', 'text']];
    let html = `<button type="button" class="ct-tool" data-tool="cursor" title="Cursor (Esc)" aria-label="Cursor">${cursor}</button><span class="ct-tool-sep"></span>`;
    groups.forEach((g, gi) => {
      html += g.map((t) => {
        const def = ChartDrawings.get(t);
        return `<button type="button" class="ct-tool" data-tool="${t}" title="${this.esc(def.label)}" aria-label="${this.esc(def.label)}">${def.icon}</button>`;
      }).join('');
      if (gi < groups.length - 1) html += '<span class="ct-tool-sep"></span>';
    });
    html += `<span class="ct-tool-sep"></span>
      <button type="button" class="ct-tool" data-toggle="magnet" title="Magnet: snap to open/high/low/close" aria-label="Magnet"><i class="fa-solid fa-magnet"></i></button>
      <button type="button" class="ct-tool" data-toggle="hide" title="Hide drawings" aria-label="Hide drawings"><i class="fa-regular fa-eye"></i></button>
      <button type="button" class="ct-tool" data-toggle="lock" title="Lock all drawings" aria-label="Lock all drawings"><i class="fa-solid fa-lock-open"></i></button>
      <button type="button" class="ct-tool ct-tool-danger" data-toggle="clear" title="Remove all drawings" aria-label="Remove all drawings"><i class="fa-regular fa-trash-can"></i></button>`;
    box.innerHTML = html;
    box.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.addEventListener('click', () => {
      const dc = this.ws?.drawing;
      if (!dc) return;
      const t = b.dataset.tool!;
      dc.setTool(dc.tool === t && t !== 'cursor' ? 'cursor' : t);
    }));
    box.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
      const dc = this.ws?.drawing;
      if (!dc) return;
      switch (b.dataset.toggle) {
        case 'magnet': dc.magnet = !dc.magnet; break;
        case 'hide': dc.toggleHidden(); break;
        case 'lock': dc.setAllLocked(!dc.allLocked()); break;
        case 'clear': dc.clearAll(); break;
      }
      this.syncTools();
    }));
  }

  private syncTools(): void {
    const dc = this.ws?.drawing;
    const box = this.$('ct-tools');
    if (!dc || !box) return;
    box.querySelectorAll<HTMLElement>('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === dc.tool));
    const magnet = box.querySelector('[data-toggle="magnet"]');
    magnet?.classList.toggle('active', dc.magnet);
    const hide = box.querySelector('[data-toggle="hide"]');
    hide?.classList.toggle('active', dc.allHidden);
    if (hide) hide.innerHTML = `<i class="fa-regular ${dc.allHidden ? 'fa-eye-slash' : 'fa-eye'}"></i>`;
    hide?.setAttribute('title', dc.allHidden ? 'Show drawings' : 'Hide drawings');
    const lock = box.querySelector('[data-toggle="lock"]');
    const locked = dc.allLocked();
    lock?.classList.toggle('active', locked);
    if (lock) lock.innerHTML = `<i class="fa-solid ${locked ? 'fa-lock' : 'fa-lock-open'}"></i>`;
    lock?.setAttribute('title', locked ? 'Unlock all drawings' : 'Lock all drawings');
  }

  private bindToolbar(): void {
    this.$('ct-chart-btn')?.addEventListener('click', () => this.toggleChartMenu());
    this.$('ct-save')?.addEventListener('click', () => void this.save());
    this.$('ct-type')?.addEventListener('change', (e) => this.ws?.setChartType((e.target as HTMLSelectElement).value as ChartType));
    this.$('ct-compare')?.addEventListener('click', () => void this.openPairPicker({ kind: 'compare' }));
    this.$('ct-compare-mode')?.addEventListener('change', (e) => this.ws?.setCompareMode((e.target as HTMLSelectElement).value as ChartCompareMode));
    this.$('ct-indicators')?.addEventListener('click', (e) => this.openIndicatorMenu(e.currentTarget as HTMLElement, null));
    this.$('ct-undo')?.addEventListener('click', () => this.stepHistory(true));
    this.$('ct-redo')?.addEventListener('click', () => this.stepHistory(false));
    this.$('ct-shot')?.addEventListener('click', () => void this.screenshot());
    this.$('ct-mine')?.addEventListener('click', () => {
      if (!this.ws) return;
      this.ws.setShowMine(this.ws.state.showMine === false);
      this.syncToolbar();
    });
    this.$('ct-alerts-btn')?.addEventListener('click', () => this.toggleAlertsMenu());
    this.$('ct-pine')?.addEventListener('click', () => this.editor?.toggle());

    // Create Alert dialog (indicator alerts)
    const so = this.$('ct-salert-overlay');
    so?.querySelectorAll<HTMLElement>('[data-salert-act]').forEach((b) =>
      b.addEventListener('click', () => (b.dataset.salertAct === 'ok' ? void this.createScriptAlert() : this.closeScriptAlert())));
    so?.addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) this.closeScriptAlert(); });
    this.$('ct-salert-cond')?.addEventListener('change', () => this.syncScriptAlertForm(true));
    this.$('ct-salert-freq')?.addEventListener('change', () => this.syncScriptAlertForm(false));
    this.$('ct-salert-msg')?.addEventListener('input', (e) => { (e.target as HTMLElement).dataset.edited = '1'; });

    this.$('ct-chart-menu')?.querySelectorAll<HTMLElement>('[data-chart-act]').forEach((b) => b.addEventListener('click', () => {
      this.closeMenus();
      switch (b.dataset.chartAct) {
        case 'new': this.openNewChart(false); break;
        case 'discard': void this.discardChanges(); break;
        case 'saveas': void this.saveAs(false); break;
        case 'rename': void this.rename(); break;
        case 'delete': void this.deleteCurrent(); break;
      }
    }));

    // Name dialog
    this.$('ct-name-overlay')?.querySelectorAll<HTMLElement>('[data-name-act]').forEach((b) =>
      b.addEventListener('click', () => this.closeName(b.dataset.nameAct === 'ok')));
    this.$('ct-name-overlay')?.addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) this.closeName(false); });
    this.$('ct-name-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.closeName(true); }
    });

    // Pair picker
    this.$('ct-pair-overlay')?.querySelectorAll<HTMLElement>('[data-pair-act]').forEach((b) =>
      b.addEventListener('click', () => this.closePairPicker()));
    this.$('ct-pair-overlay')?.addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) this.closePairPicker(); });
    this.$('ct-pair-source')?.addEventListener('change', () => void this.loadPairs());
    this.$('ct-pair-search')?.addEventListener('input', () => this.renderPairs());
  }

  private syncToolbar(): void {
    const ws = this.ws;
    if (!ws) return;
    const nameEl = this.$('ct-chart-name');
    if (nameEl) nameEl.textContent = this.name;
    const ok = ws.supportedTimeframes();
    this.$('ct-timeframes')?.querySelectorAll<HTMLButtonElement>('[data-tf]').forEach((b) => {
      const tf = b.dataset.tf!;
      b.classList.toggle('active', tf === ws.timeframe);
      b.disabled = !ok.includes(tf);
      b.title = b.disabled ? 'Not offered by every exchange on this chart' : '';
    });
    const type = this.$('ct-type') as HTMLSelectElement | null;
    if (type) type.value = ws.state.chartType;
    const mode = this.$('ct-compare-mode') as HTMLSelectElement | null;
    if (mode) {
      mode.value = ws.state.compareMode || 'stacked';
      mode.classList.toggle('d-none', ws.state.panes.length < 2);
    }
    const mine = this.$('ct-mine');
    const mineOn = ws.state.showMine !== false;
    mine?.classList.toggle('on', mineOn);
    mine?.setAttribute('aria-pressed', String(mineOn));
    const compare = this.$('ct-compare') as HTMLButtonElement | null;
    if (compare) {
      compare.disabled = !ws.canAddPane();
      compare.title = compare.disabled ? `Up to ${CHART_MAX_PANES} symbols per chart` : 'Add another symbol in its own pane';
    }
    (this.$('ct-undo') as HTMLButtonElement | null)?.toggleAttribute('disabled', !this.undo.length);
    (this.$('ct-redo') as HTMLButtonElement | null)?.toggleAttribute('disabled', !this.redo.length);
    this.syncDirty();
    this.syncTools();
    this.renderChartList();
    this.renderStyleBar(ws.drawing?.selectedDrawing() ?? null);
    this.syncAlerts();
  }

  // ── Price alerts ──────────────────────────────────────────────────────────

  private syncAlerts(): void {
    const active = ChartAlerts.alerts.filter((a) => a.status === 'active').length +
      ScriptAlerts.alerts.filter((a) => a.status === 'active').length;
    const fired = ChartAlerts.alerts.filter((a) => a.status === 'triggered').length +
      ScriptAlerts.alerts.filter((a) => a.status === 'triggered').length;
    const badge = this.$('ct-alerts-count');
    if (badge) {
      badge.textContent = String(active || fired);
      badge.classList.toggle('d-none', !active && !fired);
      badge.classList.toggle('ct-badge-muted', !active);
    }
    if (!this.$('ct-alerts-menu')?.classList.contains('d-none')) this.renderAlertsMenu();
    this.renderStyleBar(this.ws?.drawing?.selectedDrawing() ?? null);
  }

  private toggleAlertsMenu(): void {
    const menu = this.$('ct-alerts-menu');
    if (!menu) return;
    const open = menu.classList.contains('d-none');
    this.closeMenus();
    if (!open) return;
    this.renderAlertsMenu();
    menu.classList.remove('d-none');
    this.$('ct-alerts-btn')?.setAttribute('aria-expanded', 'true');
    void ChartAlerts.refresh();
    void ScriptAlerts.refresh();
  }

  private renderAlertsMenu(): void {
    const menu = this.$('ct-alerts-menu');
    if (!menu) return;
    const alerts = ChartAlerts.alerts;
    const scriptAlerts = ScriptAlerts.alerts;
    if (!alerts.length && !scriptAlerts.length) {
      menu.innerHTML = `<p class="ct-menu-empty">No alerts yet. Select a horizontal or trend line and press
        <i class="fa-regular fa-bell"></i> to be told when the price reaches it, or press
        <i class="fa-regular fa-bell"></i> on a custom indicator's label to alert on one of its conditions.</p>`;
      return;
    }
    const priceHtml = !alerts.length ? '' : `<div class="ct-menu-head">Price alerts</div>` + alerts.map((a) => {
      const fired = a.status === 'triggered';
      const when = fired && a.triggered_at
        ? new Date(a.triggered_at * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : '';
      return `<div class="ct-alert-row${fired ? ' fired' : ''}">
          <div class="ct-alert-main">
            <span class="ct-alert-sym">${this.esc(a.symbol)} <span class="ct-mc-meta">${this.esc(ChartWorkspace.sourceName(a.source))}</span></span>
            <span class="ct-mc-meta">${this.esc(ChartAlerts.describe(a))}${when ? ` · ${this.esc(when)}` : ''}</span>
          </div>
          ${a.chart_id ? `<button type="button" class="ct-sb-btn" data-alert-open="${a.chart_id}" title="Open its chart"><i class="fa-solid fa-chart-simple"></i></button>` : ''}
          ${fired ? `<button type="button" class="ct-sb-btn" data-alert-rearm="${a.id}" title="Watch again"><i class="fa-solid fa-rotate-right"></i></button>` : ''}
          <button type="button" class="ct-sb-btn ct-sb-danger" data-alert-remove="${a.id}" title="Remove"><i class="fa-solid fa-xmark"></i></button>
        </div>`;
    }).join('');
    const scriptHtml = !scriptAlerts.length ? '' : `<div class="ct-menu-head">Indicator alerts</div>` + scriptAlerts.map((a) => {
      const fired = a.status === 'triggered', paused = a.status === 'paused';
      const when = a.triggered_at
        ? new Date(a.triggered_at * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : '';
      const stale = ScriptAlerts.isStale(a);
      const state = paused ? 'Paused' : fired ? 'Fired, now off' : '';
      return `<div class="ct-alert-row${fired || paused ? ' fired' : ''}">
          <div class="ct-alert-main">
            <span class="ct-alert-sym">${this.esc(a.indicator_name)}: ${this.esc(a.condition_title)}</span>
            <span class="ct-mc-meta">${this.esc(ScriptAlerts.describe(a))}${state ? ` · ${state}` : ''}${when ? ` · last ${this.esc(when)}` : ''}</span>
            ${stale ? `<button type="button" class="ct-alert-stale" data-salert-update="${a.id}" title="This alert runs the indicator as it was when you made it">Indicator changed · use the current version</button>` : ''}
          </div>
          ${a.chart_id ? `<button type="button" class="ct-sb-btn" data-alert-open="${a.chart_id}" title="Open its chart"><i class="fa-solid fa-chart-simple"></i></button>` : ''}
          <button type="button" class="ct-sb-btn" data-salert-toggle="${a.id}" title="${a.status === 'active' ? 'Pause' : fired ? 'Watch again' : 'Resume'}"><i class="fa-solid ${a.status === 'active' ? 'fa-pause' : fired ? 'fa-rotate-right' : 'fa-play'}"></i></button>
          <button type="button" class="ct-sb-btn ct-sb-danger" data-salert-remove="${a.id}" title="Remove"><i class="fa-solid fa-xmark"></i></button>
        </div>`;
    }).join('');
    menu.innerHTML = priceHtml + scriptHtml;
    menu.querySelectorAll<HTMLElement>('[data-salert-remove]').forEach((b) => b.addEventListener('click', () => {
      void ScriptAlerts.remove(Number(b.dataset.salertRemove));
    }));
    menu.querySelectorAll<HTMLElement>('[data-salert-toggle]').forEach((b) => b.addEventListener('click', () => {
      const a = ScriptAlerts.get(Number(b.dataset.salertToggle));
      if (!a) return;
      ScriptAlerts.update(a.id, { status: a.status === 'active' ? 'paused' : 'active' })
        .catch((err) => this.showError(`Couldn’t change the alert: ${this.msg(err)}`));
    }));
    menu.querySelectorAll<HTMLElement>('[data-salert-update]').forEach((b) => b.addEventListener('click', () => {
      const a = ScriptAlerts.get(Number(b.dataset.salertUpdate));
      if (a) ScriptAlerts.updateScript(a).catch((err) => this.showError(`Couldn’t update the alert: ${this.msg(err)}`));
    }));
    menu.querySelectorAll<HTMLElement>('[data-alert-remove]').forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.dataset.alertRemove);
      void ChartAlerts.remove(id);
    }));
    menu.querySelectorAll<HTMLElement>('[data-alert-rearm]').forEach((b) => b.addEventListener('click', () => {
      const a = ChartAlerts.get(Number(b.dataset.alertRearm));
      if (a) ChartAlerts.rearm(a).catch((err) => this.showError(`Couldn’t re-arm the alert: ${this.msg(err)}`));
    }));
    menu.querySelectorAll<HTMLElement>('[data-alert-open]').forEach((b) => b.addEventListener('click', () => {
      this.closeMenus();
      const id = Number(b.dataset.alertOpen);
      if (id !== this.currentId) void this.openChart(id);
    }));
  }

  /** Bell in the style bar: put an alert on this line, or take it off. */
  private async toggleAlert(d: ChartDrawing): Promise<void> {
    const ws = this.ws;
    if (!ws) return;
    const existing = ChartAlerts.get(d.alertId);
    if (existing) {
      await ChartAlerts.remove(existing.id);
      delete d.alertId;
      ws.drawingsChanged();
      return;
    }
    const pane = ws.state.panes.find((p) => p.drawings.includes(d));
    if (!pane) return;
    try {
      const alert = await ChartAlerts.createFor(d, pane, this.currentId);
      d.alertId = alert.id;
      ws.drawingsChanged();
      this.showError(null);
    } catch (err: any) {
      this.showError(`Couldn’t set the alert: ${this.msg(err)}`);
    }
  }

  /** Open the Automations wizard with a price rule at this line. */
  private makeRule(d: ChartDrawing): void {
    const ws = this.ws;
    const pane = ws?.state.panes.find((p) => p.drawings.includes(d));
    if (!ws || !pane) return;
    const [asset, quote = 'USD'] = pane.symbol.split('/');
    const rule = { asset, price: Number(d.points[0].price.toPrecision(8)), quote };
    void router.navigate('commands', { newPriceRule: JSON.stringify(rule) });
  }

  // ── Pine Editor and indicator alerts ──────────────────────────────────────

  private syncEditorButton(): void {
    const b = this.$('ct-pine');
    const open = !!this.editor?.isOpen;
    b?.classList.toggle('on', open);
    b?.setAttribute('aria-pressed', String(open));
  }

  /** The Create Alert dialog for a script indicator's alertcondition()s. */
  private openScriptAlert(paneId: string, indId: string): void {
    const ws = this.ws;
    const pane = ws?.paneState(paneId);
    const spec = pane?.indicators.find((i) => i.id === indId);
    const row = CustomIndicators.get(spec?.scriptId);
    if (!ws || !pane || !spec || !row) return;
    const c = PineEngine.compile(row.source).compiled;
    if (!c) { this.showError('Fix the script’s errors in the Pine Editor before adding an alert.'); return; }
    if (!c.alertConditions.length && !c.usesAlertFn) {
      this.showError(`${row.name} has no alertcondition() or alert() to alert on.`);
      return;
    }
    this.closeMenus();
    ws.closePopover();
    this.salertFor = { paneId, indId };
    const cond = this.$('ct-salert-cond') as HTMLSelectElement;
    cond.innerHTML = c.alertConditions.map((a) => `<option value="${this.esc(a.key)}">${this.esc(a.title)}</option>`).join('') +
      (c.usesAlertFn ? '<option value="*alert">Any alert() function call</option>' : '');
    const ind = this.$('ct-salert-ind');
    if (ind) ind.textContent = CustomIndicators.shortLabel(spec);
    const sym = this.$('ct-salert-sym');
    if (sym) sym.textContent = `${pane.symbol} · ${ChartWorkspace.sourceName(pane.source)} · ${TF_LABELS[ws.timeframe] || ws.timeframe}`;
    (this.$('ct-salert-freq') as HTMLSelectElement).value = 'bar_close';
    const msg = this.$('ct-salert-msg') as HTMLTextAreaElement;
    delete msg.dataset.edited;
    this.$('ct-salert-error')?.classList.add('d-none');
    this.syncScriptAlertForm(true);
    this.$('ct-salert-overlay')?.classList.remove('d-none');
    cond.focus();
  }

  private syncScriptAlertForm(conditionChanged: boolean): void {
    const ws = this.ws, f = this.salertFor;
    const spec = f && ws?.paneState(f.paneId)?.indicators.find((i) => i.id === f.indId);
    const c = spec && PineEngine.compile(CustomIndicators.get(spec.scriptId)?.source || '').compiled;
    const key = (this.$('ct-salert-cond') as HTMLSelectElement).value;
    const msg = this.$('ct-salert-msg') as HTMLTextAreaElement;
    if (conditionChanged && !msg.dataset.edited) {
      const cond = c?.alertConditions.find((a) => a.key === key);
      msg.value = key === '*alert' ? '' : cond?.message || `${cond?.title || 'Alert'} on {{ticker}}`;
    }
    msg.disabled = key === '*alert';
    msg.placeholder = key === '*alert' ? 'Uses the message each alert() call sends' : '';
    const freq = (this.$('ct-salert-freq') as HTMLSelectElement).value as ScriptAlertFrequency;
    const hints: Record<ScriptAlertFrequency, string> = {
      bar_close: 'Fires once a bar closes with the condition true, so it matches what stays on the chart.',
      bar: 'Fires as soon as the condition is true on the bar that’s still forming, at most once per bar. The condition can still change before the bar closes.',
      once: 'Fires the first time the condition is true on the forming bar, then turns itself off.',
    };
    const hint = this.$('ct-salert-freq-hint');
    if (hint) hint.textContent = hints[freq];
  }

  private closeScriptAlert(): void {
    this.$('ct-salert-overlay')?.classList.add('d-none');
    this.salertFor = null;
  }

  private async createScriptAlert(): Promise<void> {
    const ws = this.ws, f = this.salertFor;
    const pane = f ? ws?.paneState(f.paneId) : undefined;
    const spec = pane?.indicators.find((i) => i.id === f!.indId);
    const row = CustomIndicators.get(spec?.scriptId);
    const c = row ? PineEngine.compile(row.source).compiled : null;
    const errEl = this.$('ct-salert-error');
    const fail = (m: string) => { if (errEl) { errEl.textContent = m; errEl.classList.remove('d-none'); } };
    if (!ws || !pane || !spec || !row || !c) { fail('That indicator is no longer on the chart.'); return; }
    const key = (this.$('ct-salert-cond') as HTMLSelectElement).value;
    const cond = c.alertConditions.find((a) => a.key === key);
    const ok = this.$('ct-salert-ok') as HTMLButtonElement;
    ok.disabled = true;
    try {
      await ScriptAlerts.create({
        indicator_id: row.id, chart_id: this.currentId, indicator_name: row.name,
        source: pane.source, symbol: pane.symbol, timeframe: ws.timeframe,
        condition_key: key, condition_title: key === '*alert' ? 'alert() call' : cond?.title || key,
        script_source: row.source, inputs: CustomIndicators.params(c, spec.params),
        frequency: (this.$('ct-salert-freq') as HTMLSelectElement).value as ScriptAlertFrequency,
        message: (this.$('ct-salert-msg') as HTMLTextAreaElement).value.trim(),
      });
      this.closeScriptAlert();
      this.showError(null);
      if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
    } catch (err: any) {
      fail(this.msg(err));
    } finally {
      ok.disabled = false;
    }
  }

  private syncDirty(): void {
    const dirty = this.isDirty();
    this.$('ct-dirty')?.classList.toggle('d-none', !dirty);
    this.$('ct-chart-menu')?.querySelector('[data-chart-act="discard"]')?.classList.toggle('d-none', !dirty);
  }

  private setSaveLabel(text: string): void {
    const b = this.$('ct-save');
    if (b) b.innerHTML = `<i class="fa-solid fa-floppy-disk" aria-hidden="true"></i>${this.esc(text)}`;
  }

  // ── Chart menu ────────────────────────────────────────────────────────────

  private toggleChartMenu(): void {
    const menu = this.$('ct-chart-menu');
    if (!menu) return;
    const open = menu.classList.contains('d-none');
    this.closeMenus();
    if (open) {
      this.renderChartList();
      menu.classList.remove('d-none');
      this.$('ct-chart-btn')?.setAttribute('aria-expanded', 'true');
    }
  }

  private renderChartList(): void {
    const list = this.$('ct-chart-list');
    if (!list) return;
    // An unsaved new chart left behind can be gone back to.
    const pending = this.currentId != null ? this.readDraft(null) : null;
    const pendingRow = pending ? `
      <button type="button" class="ct-menu-chart" data-chart-new="1" role="menuitem">
        <span class="ct-mc-name">${this.esc(pending.name || 'Untitled')} <span class="ct-dirty">●</span></span>
        <span class="ct-mc-meta">Not saved yet · ${this.esc(pending.state.panes.map((p) => p.symbol).join(' · '))}</span>
      </button>` : '';
    if (!this.charts.length && !pendingRow) {
      list.innerHTML = '<p class="ct-menu-empty">No saved charts yet. Save this one to keep it.</p>';
      return;
    }
    list.innerHTML = pendingRow + this.charts.map((c) => `
      <button type="button" class="ct-menu-chart${c.id === this.currentId ? ' active' : ''}" data-chart-id="${c.id}" role="menuitem">
        <span class="ct-mc-name">${this.esc(c.name)}</span>
        <span class="ct-mc-meta">${this.esc(c.symbols.join(' · '))}${c.timeframe ? ` · ${this.esc(TF_LABELS[c.timeframe] || c.timeframe)}` : ''} · ${this.esc(this.ago(c.updated_at))}</span>
      </button>`).join('');
    list.querySelectorAll<HTMLElement>('[data-chart-id]').forEach((b) => b.addEventListener('click', () => {
      this.closeMenus();
      const id = Number(b.dataset.chartId);
      if (id !== this.currentId) void this.openChart(id);
    }));
    list.querySelector('[data-chart-new]')?.addEventListener('click', () => {
      this.closeMenus();
      this.flushDraft();
      this.openNewChart(true);
    });
  }

  private ago(sqlTime: string): string {
    // SQLite CURRENT_TIMESTAMP is UTC without a zone marker.
    const t = Date.parse(sqlTime.replace(' ', 'T') + 'Z');
    if (!isFinite(t)) return '';
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ── Indicator menu ────────────────────────────────────────────────────────

  private openIndicatorMenu(anchor: HTMLElement, paneId: string | null): void {
    const menu = this.$('ct-ind-menu');
    const ws = this.ws;
    if (!menu || !ws) return;
    const wasOpen = !menu.classList.contains('d-none');
    this.closeMenus();
    if (wasOpen && this.indTarget === (paneId ?? '*')) return;
    this.indTarget = paneId ?? '*';
    let target = paneId ?? ws.state.panes[0].id;
    const render = () => {
      const panes = ws.state.panes;
      const picker = paneId == null && panes.length > 1
        ? `<div class="ct-ind-panes">${panes.map((p) => `<button type="button" class="time-range-btn${p.id === target ? ' active' : ''}" data-ind-pane="${this.esc(p.id)}">${this.esc(p.symbol)}</button>`).join('')}</div>`
        : `<div class="ct-menu-head">Add to ${this.esc(panes.find((p) => p.id === target)?.symbol || '')}</div>`;
      const active = panes.flatMap((p) => p.indicators.map((i) => ({ pane: p, ind: i })))
        .filter((x) => x.ind.type === 'script' || ChartIndicators.get(x.ind.type));
      const onChart = active.length ? `<div class="ct-menu-group">On this chart</div>` + active.map((x) =>
        `<div class="ct-ind-active">
          <i class="cw-swatch" style="background:${this.esc(x.ind.color || '#9FB0B8')}"></i>
          <span class="ct-ind-active-name">${this.esc(CustomIndicators.shortLabel(x.ind))}${panes.length > 1 ? ` <span class="ct-mc-meta">${this.esc(x.pane.symbol)}</span>` : ''}</span>
          <button type="button" class="ct-sb-btn ct-sb-danger" data-ind-remove="${this.esc(x.ind.id)}" data-ind-remove-pane="${this.esc(x.pane.id)}" title="Remove" aria-label="Remove ${this.esc(CustomIndicators.label(x.ind))}"><i class="fa-solid fa-xmark"></i></button>
        </div>`).join('') +
        (active.length > 1 ? `<button type="button" class="ct-menu-item ct-danger" data-ind-remove-all="1"><i class="fa-regular fa-trash-can"></i>Remove all indicators</button>` : '') +
        `<div class="ct-menu-sep"></div>` : '';
      const groups = Array.from(new Set(ChartIndicators.list.map((d) => d.group)));
      const mine = `<div class="ct-menu-group">My scripts</div>` + CustomIndicators.scripts.map((sc) => {
        const c = PineEngine.compile(sc.source);
        const note = c.error ? 'has errors' : c.compiled?.overlay ? 'on price' : 'own pane';
        return `<button type="button" class="ct-menu-item${c.error ? ' ct-menu-item-err' : ''}" data-ind-script="${sc.id}"${c.error ? ` title="${this.esc(PineEngine.describe(c.error))}"` : ''}><i class="fa-solid fa-code"></i>${this.esc(sc.name)}<span class="ct-menu-note">${note}</span></button>`;
      }).join('') +
        `<button type="button" class="ct-menu-item" data-ind-newscript="1"><i class="fa-solid fa-plus"></i>New Pine Script indicator…</button>`;
      menu.innerHTML = onChart + picker + mine + groups.map((g) => `<div class="ct-menu-group">${this.esc(g)}</div>` +
        ChartIndicators.list.filter((d) => d.group === g).map((d) =>
          `<button type="button" class="ct-menu-item" data-ind-type="${d.type}"><i class="fa-solid ${d.profile ? 'fa-bars-staggered' : d.overlay ? 'fa-chart-line' : 'fa-wave-square'}"></i>${this.esc(d.label)}<span class="ct-menu-note">${d.overlay ? 'on price' : 'own pane'}</span></button>`).join('')).join('');
      menu.querySelectorAll<HTMLElement>('[data-ind-pane]').forEach((b) => b.addEventListener('click', () => { target = b.dataset.indPane!; render(); }));
      // Removing keeps the menu open so several can go in a row.
      menu.querySelectorAll<HTMLElement>('[data-ind-remove]').forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation();
        ws.removeIndicator(b.dataset.indRemovePane!, b.dataset.indRemove!);
        render();
      }));
      menu.querySelector('[data-ind-remove-all]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        ws.removeAllIndicators();
        render();
      });
      menu.querySelectorAll<HTMLElement>('[data-ind-type]').forEach((b) => b.addEventListener('click', () => {
        this.closeMenus();
        ws.addIndicator(target, b.dataset.indType!);
      }));
      menu.querySelectorAll<HTMLElement>('[data-ind-script]').forEach((b) => b.addEventListener('click', () => {
        this.closeMenus();
        const id = Number(b.dataset.indScript);
        const c = PineEngine.compile(CustomIndicators.get(id)?.source || '');
        // A script with errors opens in the editor instead.
        if (c.error) { this.editor?.open(id); return; }
        ws.addScript(target, id);
      }));
      menu.querySelector('[data-ind-newscript]')?.addEventListener('click', () => {
        this.closeMenus();
        this.indTarget = target;
        this.editor?.open(null);
      });
    };
    void CustomIndicators.ensureLoaded().then(() => { if (!menu.classList.contains('d-none')) render(); });
    render();
    const root = this.$('charts-root')!.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(0, a.left - root.left)}px`;
    menu.style.top = `${a.bottom - root.top + 4}px`;
    menu.classList.remove('d-none');
    // Open at the top, where the indicators already on the chart are listed.
    menu.scrollTop = 0;
  }

  private closeMenus(): void {
    this.$('ct-chart-menu')?.classList.add('d-none');
    this.$('ct-chart-btn')?.setAttribute('aria-expanded', 'false');
    this.$('ct-ind-menu')?.classList.add('d-none');
    this.$('ct-alerts-menu')?.classList.add('d-none');
    this.$('ct-alerts-btn')?.setAttribute('aria-expanded', 'false');
    this.$('ct-fib-pop')?.remove();
  }

  private docClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    if (!t.closest('.ct-menu, .ct-menu-wrap, #ct-indicators, .cw-actions, .ct-fib-pop, [data-style="levels"]')) this.closeMenus();
    if (!t.closest('.cw-popover, .cw-chip')) this.ws?.closePopover();
  }

  // ── Pair picker ───────────────────────────────────────────────────────────

  private async openPairPicker(mode: { kind: 'compare' } | { kind: 'symbol'; paneId: string }): Promise<void> {
    const ws = this.ws;
    if (!ws) return;
    if (mode.kind === 'compare' && !ws.canAddPane()) return;
    this.closeMenus();
    this.pairMode = mode;
    const pane = mode.kind === 'symbol' ? ws.paneState(mode.paneId) : ws.state.panes[0];
    const title = this.$('ct-pair-title');
    if (title) title.textContent = mode.kind === 'compare' ? 'Compare a symbol' : `Change ${pane?.symbol || 'symbol'}`;
    const sel = this.$('ct-pair-source') as HTMLSelectElement;
    const sources = await ChartWorkspace.loadSources();
    sel.innerHTML = sources.map((s) => {
      const label = s.requires_key && !s.configured ? `${s.name} (set up)` : s.name;
      return `<option value="${this.esc(s.id)}">${this.esc(label)}</option>`;
    }).join('');
    sel.value = pane?.source || 'coinbase';
    (this.$('ct-pair-search') as HTMLInputElement).value = '';
    this.$('ct-pair-overlay')?.classList.remove('d-none');
    (this.$('ct-pair-search') as HTMLInputElement).focus();
    await this.loadPairs();
  }

  private closePairPicker(): void {
    this.$('ct-pair-overlay')?.classList.add('d-none');
  }

  private async loadPairs(): Promise<void> {
    const source = (this.$('ct-pair-source') as HTMLSelectElement).value;
    const hint = this.$('ct-pair-hint');
    const src = (await ChartWorkspace.loadSources()).find((s) => s.id === source);
    const stock = src?.kind === 'stock';
    const search = this.$('ct-pair-search') as HTMLInputElement | null;
    if (search) {
      search.placeholder = stock ? 'Search tickers or companies (e.g. AAPL, Apple)…' : 'Search pairs (e.g. ETH, XRP/CAD)…';
    }
    if (src?.requires_key && !src.configured) {
      // No key yet: point at Profile instead of fetching a list that would 400.
      if (hint) hint.textContent = '';
      const list = this.$('ct-pair-list');
      if (list) {
        list.innerHTML = `
          <div class="ct-pair-setup">
            <p>Charting stocks uses your own free Alpaca market-data key. Add it once on your Profile and US stocks and ETFs show up here.</p>
            <button type="button" class="btn btn-primary btn-sm" id="ct-pair-setup-btn">
              Add Alpaca key <i class="fa-solid fa-arrow-right"></i>
            </button>
          </div>`;
        this.$('ct-pair-setup-btn')?.addEventListener('click', () => {
          this.closePairPicker();
          void router.navigate('profile', { tab: 'exchanges', focus: 'stocks-card' });
        });
      }
      return;
    }
    if (hint && src) {
      const missing = ChartGeo.TIMEFRAMES.filter((tf) => !src.timeframes.includes(tf)).map((tf) => TF_LABELS[tf]);
      hint.textContent = (src.can_page
        ? `${src.name} loads older history as you scroll back.`
        : `${src.name} only serves its most recent ${src.max_limit} candles per timeframe.`)
        + (missing.length ? ` No ${missing.join('/')} candles.` : '')
        + (stock ? ' US stocks and ETFs from Alpaca (IEX): real-time prices, IEX-only volume.' : '');
    }
    if (!this.pairCache.has(source)) {
      const list = this.$('ct-pair-list');
      if (list) list.innerHTML = `<p class="ct-menu-empty">Loading ${stock ? 'symbols' : 'pairs'}…</p>`;
      try {
        const resp = await MarketData.getPairs(AuthController.getToken() || '', source);
        this.pairCache.set(source, resp.data || []);
      } catch (err: any) {
        if (list) list.innerHTML = `<p class="ct-menu-empty">Couldn’t load ${stock ? 'symbols' : 'pairs'}: ${this.esc(this.msg(err))}</p>`;
        return;
      }
    }
    if ((this.$('ct-pair-source') as HTMLSelectElement).value === source) this.renderPairs();
  }

  private renderPairs(): void {
    const list = this.$('ct-pair-list');
    const ws = this.ws;
    if (!list || !ws) return;
    const source = (this.$('ct-pair-source') as HTMLSelectElement).value;
    const q = (this.$('ct-pair-search') as HTMLInputElement).value;
    const pairs = this.pairCache.get(source) || [];
    const onChart = new Set(ws.state.panes.filter((p) => p.source === source).map((p) => p.symbol));
    const found = PairSearch.filter(pairs, q).slice(0, 80);
    const stock = ChartWorkspace.isStock(source);
    if (!found.length) { list.innerHTML = `<p class="ct-menu-empty">No matching ${stock ? 'symbols' : 'pairs'}</p>`; return; }
    list.innerHTML = found.map((p: any) => `
      <button type="button" class="add-crypto-item ct-pair-item" data-symbol="${this.esc(p.symbol)}"${onChart.has(p.symbol) ? ' disabled' : ''}>
        <span class="add-crypto-item-base">${this.esc(p.base)}</span>
        <span class="add-crypto-item-symbol">${this.esc(stock && p.name ? p.name : p.symbol)}${onChart.has(p.symbol) ? ' · on chart' : ''}</span>
      </button>`).join('');
    list.querySelectorAll<HTMLButtonElement>('[data-symbol]').forEach((b) => b.addEventListener('click', () => {
      const symbol = b.dataset.symbol!;
      this.closePairPicker();
      if (this.pairMode.kind === 'compare') ws.addPane(symbol, source);
      else ws.setPaneSymbol(this.pairMode.paneId, symbol, source);
    }));
  }

  // ── Style bar for the selected drawing ────────────────────────────────────

  private renderStyleBar(d: ChartDrawing | null): void {
    const bar = this.$('ct-stylebar');
    const dc = this.ws?.drawing;
    if (!bar || !dc) return;
    this.$('ct-fib-pop')?.remove();
    if (!d) { bar.classList.add('d-none'); bar.innerHTML = ''; return; }
    const def = ChartDrawings.get(d.type);
    const palette = ChartTheme.get().palette;
    const colors = def.noColor || d.type === 'measure' || d.type === 'fib' ? '' :
      `<span class="ct-sb-group">${palette.map((c) => `<button type="button" class="ct-sb-swatch${c.toLowerCase() === d.style.color.toLowerCase() ? ' on' : ''}" data-style="color" data-v="${c}" style="background:${c}" title="${c}"></button>`).join('')}</span>`;
    const widths = def.lineStyle ? `<span class="ct-sb-group">${[1, 2, 3, 4].map((w) =>
      `<button type="button" class="ct-sb-btn${d.style.width === w ? ' on' : ''}" data-style="width" data-v="${w}" title="${w}px"><span class="ct-sb-w" style="height:${w}px"></span></button>`).join('')}</span>` : '';
    const dashes = def.lineStyle ? `<span class="ct-sb-group">${(['solid', 'dashed', 'dotted'] as ChartDash[]).map((s) =>
      `<button type="button" class="ct-sb-btn${d.style.dash === s ? ' on' : ''}" data-style="dash" data-v="${s}" title="${s}"><span class="ct-sb-dash ct-sb-${s}"></span></button>`).join('')}</span>` : '';
    const fill = def.canFill ? `<button type="button" class="ct-sb-btn${d.style.fill ? ' on' : ''}" data-style="fill" title="Background"><i class="fa-solid fa-fill-drip"></i></button>` : '';
    const ext = def.canExtend ? `<span class="ct-sb-group">
        <button type="button" class="ct-sb-btn${d.style.extendLeft ? ' on' : ''}" data-style="extL" title="Extend left"><i class="fa-solid fa-arrow-left-long"></i></button>
        <button type="button" class="ct-sb-btn${d.style.extendRight ? ' on' : ''}" data-style="extR" title="Extend right"><i class="fa-solid fa-arrow-right-long"></i></button></span>` : '';
    const levels = d.type === 'fib' ? `<button type="button" class="ct-sb-btn ct-sb-text" data-style="levels" title="Choose levels">Levels</button>` : '';
    const text = d.type === 'text' ? `<button type="button" class="ct-sb-btn" data-style="edit-text" title="Edit text"><i class="fa-solid fa-i-cursor"></i></button>` : '';
    let alertBtns = '';
    if (ChartAlerts.canAlert(d)) {
      const alert = ChartAlerts.get(d.alertId);
      const bellTitle = alert
        ? (alert.status === 'active' ? `Alert set: ${ChartAlerts.describe(alert)}. Click to remove.` : 'This alert fired. Click to remove it, or move the line to watch again.')
        : (d.type === 'hline' || d.type === 'hray' ? 'Alert me when the price reaches this line' : 'Alert me when the price crosses this line (it follows the slope)');
      alertBtns = `<button type="button" class="ct-sb-btn${alert ? ' on' : ''}" data-style="alert" title="${this.esc(bellTitle)}"><i class="fa-${alert ? 'solid' : 'regular'} fa-bell"></i></button>`;
      const pane = this.ws?.state.panes.find((p) => p.drawings.includes(d));
      // Automation rules trade on an exchange, so stock lines only get the alert.
      if ((d.type === 'hline' || d.type === 'hray') && !ChartWorkspace.isStock(pane?.source)) {
        // Price rules run when the price rises to a level, so only offer one above it.
        const last = pane ? this.ws!.lastPrice(pane.id) : null;
        const below = last != null && d.points[0].price <= last;
        const ruleTitle = below
          ? 'Automation rules run when the price rises to a level, and this line is below the current price'
          : 'Make an automation rule that runs when the price rises to this line';
        alertBtns += `<button type="button" class="ct-sb-btn" data-style="rule" title="${this.esc(ruleTitle)}"${below ? ' disabled' : ''}><i class="fa-solid fa-bolt"></i></button>`;
      }
      alertBtns = `<span class="ct-sb-group">${alertBtns}</span>`;
    }
    const toolParams = (def.params || []).map((tp) => {
      const cur = d.params?.[tp.key] ?? tp.def;
      return `<span class="ct-sb-group" title="${this.esc(tp.label)}"><span class="ct-sb-plabel">${this.esc(tp.label)}</span>${tp.options.map((o) =>
        `<button type="button" class="ct-sb-btn ct-sb-text${o === cur ? ' on' : ''}" data-style="param" data-k="${this.esc(tp.key)}" data-v="${o}">${o}</button>`).join('')}</span>`;
    }).join('');
    bar.innerHTML = `<span class="ct-sb-label">${this.esc(def.label)}</span>${colors}${widths}${dashes}${fill}${ext}${levels}${toolParams}${text}${alertBtns}
      <span class="ct-sb-group">
        <button type="button" class="ct-sb-btn${d.locked ? ' on' : ''}" data-style="lock" title="${d.locked ? 'Unlock' : 'Lock'}"><i class="fa-solid ${d.locked ? 'fa-lock' : 'fa-lock-open'}"></i></button>
        <button type="button" class="ct-sb-btn" data-style="clone" title="Clone"><i class="fa-regular fa-clone"></i></button>
        <button type="button" class="ct-sb-btn ct-sb-danger" data-style="delete" title="Delete (Del)"><i class="fa-regular fa-trash-can"></i></button>
      </span>`;
    bar.classList.remove('d-none');
    bar.querySelectorAll<HTMLElement>('[data-style]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const v = b.dataset.v;
      switch (b.dataset.style) {
        case 'color': dc.updateSelected((x) => { x.style.color = v!; }); break;
        case 'width': dc.updateSelected((x) => { x.style.width = Number(v); }); break;
        case 'dash': dc.updateSelected((x) => { x.style.dash = v as ChartDash; }); break;
        case 'fill': dc.updateSelected((x) => { x.style.fill = !x.style.fill; }); break;
        case 'extL': dc.updateSelected((x) => { x.style.extendLeft = !x.style.extendLeft; }); break;
        case 'extR': dc.updateSelected((x) => { x.style.extendRight = !x.style.extendRight; }); break;
        case 'lock': dc.updateSelected((x) => { x.locked = !x.locked; }); this.syncTools(); break;
        case 'clone': dc.cloneSelected(); break;
        case 'delete': dc.deleteSelected(); break;
        case 'levels': this.openFibLevels(b, d); break;
        case 'param': dc.updateSelected((x) => { x.params = { ...(x.params || {}), [b.dataset.k!]: Number(v) }; }); break;
        case 'alert': void this.toggleAlert(d); break;
        case 'rule': this.makeRule(d); break;
        case 'edit-text': {
          // Same as double-clicking the note.
          const ws = this.ws!;
          const pane = ws.state.panes.find((p) => p.drawings.includes(d));
          if (pane) dc.openEditor(pane.id, d, false);
          break;
        }
      }
    }));
  }

  private openFibLevels(anchor: HTMLElement, d: ChartDrawing): void {
    const existing = this.$('ct-fib-pop');
    if (existing) { existing.remove(); return; }
    const dc = this.ws?.drawing;
    if (!dc) return;
    const pop = document.createElement('div');
    pop.className = 'ct-menu ct-fib-pop';
    pop.id = 'ct-fib-pop';
    const levels = d.levels || ChartDrawings.FIB_DEFAULT;
    pop.innerHTML = levels.map((l, i) => `<label class="ct-fib-row"><input type="checkbox" data-i="${i}"${l.on ? ' checked' : ''}>
      <i class="cw-swatch" style="background:${ChartDrawings.fibColor(l.value)}"></i>${l.value}</label>`).join('');
    pop.querySelectorAll<HTMLInputElement>('input[data-i]').forEach((inp) => inp.addEventListener('change', () => {
      dc.updateSelected((x) => {
        x.levels = (x.levels || ChartDrawings.FIB_DEFAULT).map((l, i) => (i === Number(inp.dataset.i) ? { ...l, on: inp.checked } : { ...l }));
      });
      // updateSelected re-renders the style bar; keep the levels list open.
      this.openFibLevels(this.$('ct-stylebar')!.querySelector('[data-style="levels"]') as HTMLElement, dc.selectedDrawing()!);
    }));
    const root = this.$('charts-root')!.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    pop.style.left = `${a.left - root.left}px`;
    pop.style.top = `${a.bottom - root.top + 4}px`;
    this.$('charts-root')!.appendChild(pop);
  }

  // ── Name dialog ───────────────────────────────────────────────────────────

  private askName(title: string, value: string, ok: string): Promise<string | null> {
    this.closeName(false);
    const t = this.$('ct-name-title');
    if (t) t.textContent = title;
    const okBtn = this.$('ct-name-ok');
    if (okBtn) okBtn.textContent = ok;
    const input = this.$('ct-name-input') as HTMLInputElement;
    input.value = value;
    this.$('ct-name-error')?.classList.add('d-none');
    this.$('ct-name-overlay')?.classList.remove('d-none');
    input.focus();
    input.select();
    return new Promise((resolve) => { this.nameResolve = resolve; });
  }

  private closeName(ok: boolean): void {
    const resolve = this.nameResolve;
    if (!resolve) return;
    if (ok) {
      const v = (this.$('ct-name-input') as HTMLInputElement).value.trim();
      if (!v) {
        const err = this.$('ct-name-error');
        if (err) { err.textContent = 'Give the chart a name.'; err.classList.remove('d-none'); }
        return;
      }
      this.nameResolve = null;
      this.$('ct-name-overlay')?.classList.add('d-none');
      resolve(v);
    } else {
      this.nameResolve = null;
      this.$('ct-name-overlay')?.classList.add('d-none');
      resolve(null);
    }
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────

  private keydown(e: KeyboardEvent): void {
    const ws = this.ws;
    if (!ws) return;
    const mod = e.ctrlKey || e.metaKey;
    const modalOpen = !this.$('ct-name-overlay')?.classList.contains('d-none') ||
                      !this.$('ct-pair-overlay')?.classList.contains('d-none') ||
                      !this.$('ct-salert-overlay')?.classList.contains('d-none');
    if (e.key === 'Escape') {
      if (!this.$('ct-salert-overlay')?.classList.contains('d-none')) { this.closeScriptAlert(); return; }
      if (!this.$('ct-pair-overlay')?.classList.contains('d-none')) { this.closePairPicker(); return; }
      if (modalOpen) { this.closeName(false); return; }
      this.closeMenus();
      ws.closePopover();
      if (ws.drawing?.cancel()) e.preventDefault();
      return;
    }
    if (modalOpen) return;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void this.save(); return; }
    const t = e.target as HTMLElement;
    if (t && (t.closest('input, textarea, select, [contenteditable="true"]'))) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); this.stepHistory(!e.shiftKey); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this.stepHistory(false); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && ws.drawing?.selectedDrawing()) {
      e.preventDefault();
      ws.drawing.deleteSelected();
    }
  }

  // ── Misc ──────────────────────────────────────────────────────────────────

  private async screenshot(): Promise<void> {
    const canvas = this.ws?.screenshot(this.name);
    if (!canvas) return;
    const base64 = canvas.toDataURL('image/png').split(',')[1];
    const stamp = new Date().toISOString().slice(0, 10);
    const safe = this.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'chart';
    await FileSave.save({ filename: `${safe}-${stamp}.png`, base64, mime: 'image/png', filterName: 'PNG image', extensions: ['png'] });
  }

  private showError(text: string | null): void {
    const el = this.$('charts-error');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('d-none', !text);
  }

  private msg(err: any): string {
    return typeof err === 'string' ? err : (err?.message || 'unknown error');
  }
}

new ChartsController();

})();
