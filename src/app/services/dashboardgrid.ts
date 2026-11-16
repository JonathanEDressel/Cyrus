/**
 * DashboardGrid — a customisable 12-column widget grid.
 *
 * The page supplies a catalog of widget types (each backed by a <template> in
 * its view) and a layout: the widgets on the page, in order, each with a width
 * in columns and an optional fixed height. In edit mode the user can drag a
 * widget by its grip to move it, drag its corner to resize it, add widgets
 * from the catalog and remove them. Every change is reported through
 * onChange; persisting it is the page's job.
 *
 * The grid knows nothing about what a widget shows. onMount hands the page a
 * freshly stamped widget to fill in and wire up, onUnmount lets it release
 * anything it holds (charts, observers), and onResize tells it the box changed.
 */

interface DashWidgetDef {
  type: string;
  title: string;
  icon: string;
  description: string;
  /** id of the <template> holding the widget's markup. */
  template: string;
  defaultW: number;
  minW: number;
  /** Smallest fixed height, in px, the corner handle may set. */
  minH?: number;
  /** No card frame of its own (e.g. the headline tile strip). */
  bare?: boolean;
}

interface DashWidget {
  type: string;
  /** Width in grid columns, 1–12. */
  w: number;
  /** Fixed height in px, or null to fit the content. */
  h: number | null;
  /** Widget-specific settings (a note's text, say). */
  config?: Record<string, any>;
}

interface DashLayout {
  version: 1;
  widgets: DashWidget[];
}

interface DashboardGridOptions {
  grid: HTMLElement;
  catalog: DashWidgetDef[];
  layout: DashLayout;
  onMount: (widget: DashWidget, el: HTMLElement) => void;
  onUnmount: (widget: DashWidget, el: HTMLElement) => void;
  onResize: (widget: DashWidget, el: HTMLElement) => void;
  onChange: (layout: DashLayout) => void;
}

class DashboardGrid {
  static readonly COLUMNS = 12;
  static readonly MAX_H = 1400;
  static readonly SNAP_H = 10;

  private opts: DashboardGridOptions;
  private layout: DashLayout;
  private editing = false;

  constructor(opts: DashboardGridOptions) {
    this.opts = opts;
    this.layout = DashboardGrid.normalize(opts.layout, opts.catalog, { version: 1, widgets: [] });
  }

  // ── Layout data ───────────────────────────────────────────────────

  /**
   * Make any stored layout safe to render: unknown types and duplicates are
   * dropped, widths clamped to the widget's own minimum, heights to a sane
   * range. Anything unreadable gives the fallback.
   */
  static normalize(raw: any, catalog: DashWidgetDef[], fallback: DashLayout): DashLayout {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.widgets)) {
      return DashboardGrid.clone(fallback);
    }
    const defs = new Map(catalog.map(d => [d.type, d]));
    const seen = new Set<string>();
    const widgets: DashWidget[] = [];
    for (const w of raw.widgets) {
      const def = w && defs.get(String(w.type));
      if (!def || seen.has(def.type)) continue;
      seen.add(def.type);
      const width = Math.round(Number(w.w));
      const height = w.h == null ? null : Math.round(Number(w.h));
      widgets.push({
        type: def.type,
        w: Number.isFinite(width) ? Math.min(DashboardGrid.COLUMNS, Math.max(def.minW, width)) : def.defaultW,
        h: height != null && Number.isFinite(height)
          ? Math.min(DashboardGrid.MAX_H, Math.max(def.minH ?? 120, height))
          : null,
        config: w.config && typeof w.config === 'object' ? { ...w.config } : undefined,
      });
    }
    return { version: 1, widgets };
  }

  static clone(layout: DashLayout): DashLayout {
    return JSON.parse(JSON.stringify(layout));
  }

  getLayout(): DashLayout {
    return DashboardGrid.clone(this.layout);
  }

  has(type: string): boolean {
    return this.layout.widgets.some(w => w.type === type);
  }

  /** Merge settings into one widget's config and report the change. */
  updateConfig(type: string, patch: Record<string, any>): void {
    const w = this.find(type);
    if (!w) return;
    w.config = { ...(w.config || {}), ...patch };
    this.emit();
  }

  config(type: string): Record<string, any> {
    return { ...(this.find(type)?.config || {}) };
  }

  private find(type: string): DashWidget | undefined {
    return this.layout.widgets.find(w => w.type === type);
  }

  private def(type: string): DashWidgetDef | undefined {
    return this.opts.catalog.find(d => d.type === type);
  }

  private emit(): void {
    this.opts.onChange(this.getLayout());
  }

  // ── Rendering ─────────────────────────────────────────────────────

  render(): void {
    this.unmountAll();
    this.opts.grid.innerHTML = '';
    for (const w of this.layout.widgets) {
      const el = this.stamp(w);
      if (el) this.opts.grid.appendChild(el);
    }
    // Mount after everything is in the DOM, so widgets that measure themselves
    // (charts) see their real size.
    for (const w of this.layout.widgets) {
      const el = this.elementFor(w.type);
      if (el) this.opts.onMount(w, el);
    }
  }

  /** Swap in a different layout (reset to default, say). */
  replace(layout: DashLayout): void {
    this.layout = DashboardGrid.normalize(layout, this.opts.catalog, { version: 1, widgets: [] });
    this.render();
    this.emit();
  }

  elementFor(type: string): HTMLElement | null {
    return this.opts.grid.querySelector<HTMLElement>(`:scope > .dash-widget[data-widget="${type}"]`);
  }

  private stamp(w: DashWidget): HTMLElement | null {
    const def = this.def(w.type);
    const tpl = def && document.getElementById(def.template) as HTMLTemplateElement | null;
    if (!def || !tpl) return null;

    const el = document.createElement('section');
    el.className = `dash-widget${def.bare ? ' dash-widget--bare' : ''}`;
    el.setAttribute('data-widget', w.type);
    el.setAttribute('aria-label', def.title);
    el.innerHTML = `
      <div class="dash-edit-bar" role="toolbar" aria-label="${this.escape(def.title)} layout">
        <button type="button" class="dash-grip" data-act="grip" title="Drag to move" aria-label="Drag to move">
          <i class="fa-solid fa-grip-vertical" aria-hidden="true"></i>
        </button>
        <span class="dash-edit-title"><i class="fa-solid ${def.icon}" aria-hidden="true"></i>${this.escape(def.title)}</span>
        <span class="dash-edit-size" data-size></span>
        <span class="dash-edit-actions">
          <button type="button" data-act="earlier" title="Move earlier" aria-label="Move earlier"><i class="fa-solid fa-arrow-left"></i></button>
          <button type="button" data-act="later" title="Move later" aria-label="Move later"><i class="fa-solid fa-arrow-right"></i></button>
          <button type="button" data-act="narrower" title="Narrower" aria-label="Narrower"><i class="fa-solid fa-minus"></i></button>
          <button type="button" data-act="wider" title="Wider" aria-label="Wider"><i class="fa-solid fa-plus"></i></button>
          <button type="button" data-act="fit" title="Fit height to content" aria-label="Fit height to content"><i class="fa-solid fa-arrows-up-down"></i></button>
          <button type="button" data-act="remove" class="dash-remove" title="Remove widget" aria-label="Remove widget"><i class="fa-solid fa-xmark"></i></button>
        </span>
      </div>
      <div class="dash-widget-body"></div>
      <div class="dash-resize" title="Drag to resize · double-click to fit height" aria-hidden="true"></div>`;
    el.querySelector('.dash-widget-body')!.appendChild(tpl.content.cloneNode(true));
    this.applySize(el, w);
    this.bindWidget(el);
    return el;
  }

  private applySize(el: HTMLElement, w: DashWidget): void {
    el.style.setProperty('--w', String(w.w));
    el.classList.toggle('has-h', w.h != null);
    el.style.height = w.h != null ? `${w.h}px` : '';
    const size = el.querySelector('[data-size]');
    if (size) size.textContent = `${w.w}/${DashboardGrid.COLUMNS}${w.h != null ? ` · ${w.h}px` : ''}`;
  }

  private unmountAll(): void {
    for (const w of this.layout.widgets) {
      const el = this.elementFor(w.type);
      if (el) this.opts.onUnmount(w, el);
    }
  }

  /** Release every widget — call when the page goes away. */
  destroy(): void {
    this.unmountAll();
  }

  // ── Edit mode ─────────────────────────────────────────────────────

  setEditing(on: boolean): void {
    this.editing = on;
    this.opts.grid.classList.toggle('is-editing', on);
  }

  isEditing(): boolean {
    return this.editing;
  }

  add(type: string): HTMLElement | null {
    const def = this.def(type);
    if (!def || this.has(type)) return null;
    const w: DashWidget = { type, w: def.defaultW, h: null };
    this.layout.widgets.push(w);
    const el = this.stamp(w);
    if (!el) return null;
    this.opts.grid.appendChild(el);
    this.opts.onMount(w, el);
    this.emit();
    return el;
  }

  remove(type: string): void {
    const w = this.find(type);
    const el = this.elementFor(type);
    if (!w) return;
    if (el) {
      this.opts.onUnmount(w, el);
      el.remove();
    }
    this.layout.widgets = this.layout.widgets.filter(x => x !== w);
    this.emit();
  }

  private bindWidget(el: HTMLElement): void {
    const type = el.getAttribute('data-widget')!;

    el.querySelector('.dash-edit-bar')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('button[data-act]');
      if (!btn || !this.editing) return;
      const w = this.find(type);
      const def = this.def(type);
      if (!w || !def) return;
      switch (btn.getAttribute('data-act')) {
        case 'earlier': this.move(type, -1); break;
        case 'later': this.move(type, 1); break;
        case 'narrower': this.setSize(type, Math.max(def.minW, w.w - 1), w.h); break;
        case 'wider': this.setSize(type, Math.min(DashboardGrid.COLUMNS, w.w + 1), w.h); break;
        case 'fit': this.setSize(type, w.w, null); break;
        case 'remove': this.remove(type); break;
      }
    });

    // Only the grip starts a drag, so selecting text or using a widget's own
    // controls never picks the widget up.
    el.querySelector<HTMLElement>('.dash-grip')
      ?.addEventListener('pointerdown', (e) => this.startDrag(e, el));

    const handle = el.querySelector<HTMLElement>('.dash-resize');
    handle?.addEventListener('pointerdown', (e) => this.startResize(e, el));
    handle?.addEventListener('dblclick', () => {
      const w = this.find(type);
      if (w && this.editing) this.setSize(type, w.w, null);
    });
  }

  private setSize(type: string, width: number, height: number | null): void {
    const w = this.find(type);
    const el = this.elementFor(type);
    if (!w || !el) return;
    if (w.w === width && w.h === height) return;
    w.w = width;
    w.h = height;
    this.applySize(el, w);
    this.opts.onResize(w, el);
    this.emit();
  }

  private move(type: string, delta: number): void {
    const list = this.layout.widgets;
    const i = list.findIndex(w => w.type === type);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    const el = this.elementFor(type);
    const other = this.elementFor(list[i].type);
    if (el && other) {
      if (delta < 0) other.before(el); else other.after(el);
    }
    el?.querySelector<HTMLElement>(`button[data-act="${delta < 0 ? 'earlier' : 'later'}"]`)?.focus();
    this.emit();
  }

  /** Corner drag: width snaps to whole columns, height to SNAP_H pixels. */
  private startResize(e: PointerEvent, el: HTMLElement): void {
    if (!this.editing || e.button !== 0) return;
    e.preventDefault();
    const type = el.getAttribute('data-widget')!;
    const w = this.find(type);
    const def = this.def(type);
    if (!w || !def) return;

    const grid = this.opts.grid;
    const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
    const colStep = (grid.clientWidth + gap) / DashboardGrid.COLUMNS;
    const rect = el.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    el.classList.add('is-resizing');

    let width = w.w;
    let height = w.h;
    const onMove = (ev: PointerEvent) => {
      const cols = Math.round((rect.width + gap + (ev.clientX - startX)) / colStep);
      width = Math.min(DashboardGrid.COLUMNS, Math.max(def.minW, cols));
      // A mostly sideways drag changes the width only, so a widget that fits
      // its content keeps doing so.
      const dy = ev.clientY - startY;
      height = Math.abs(dy) < 6 ? w.h : Math.min(DashboardGrid.MAX_H,
        Math.max(def.minH ?? 120, Math.round((rect.height + dy) / DashboardGrid.SNAP_H) * DashboardGrid.SNAP_H));
      this.applySize(el, { ...w, w: width, h: height });
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      el.classList.remove('is-resizing');
      if (width === w.w && height === w.h) {
        this.applySize(el, w);
        return;
      }
      this.setSize(type, width, height);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }

  /**
   * Drag to reorder, by the grip: past a few pixels of movement the widget
   * lifts, and moves live through the grid as the pointer passes others.
   * Pointer events rather than HTML5 drag and drop, which won't reliably
   * start a drag from a button and gives no control over the preview.
   */
  private startDrag(e: PointerEvent, el: HTMLElement): void {
    if (!this.editing || e.button !== 0) return;
    e.preventDefault();
    const grid = this.opts.grid;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    let lifted = false;
    let last = '';
    let pointerX = startX;
    let pointerY = startY;
    let scrollFrame = 0;
    const scroller = DashboardGrid.scrollParent(grid);

    // Near the top or bottom edge of the scrolling page, keep scrolling so a
    // widget can be carried to a spot that's out of view.
    const autoScroll = () => {
      scrollFrame = 0;
      if (!lifted || !scroller) return;
      // When the document scrolls, fixed chrome covers its top and bottom, so
      // the edge zones reach further in.
      const isDoc = scroller === document.scrollingElement;
      const top = isDoc ? 0 : scroller.getBoundingClientRect().top;
      const bottom = isDoc ? window.innerHeight : scroller.getBoundingClientRect().bottom;
      const topEdge = top + (isDoc ? 130 : 70);
      const bottomEdge = bottom - (isDoc ? 90 : 70);
      let dy = 0;
      if (pointerY < topEdge) dy = -Math.ceil((topEdge - pointerY) / 4);
      else if (pointerY > bottomEdge) dy = Math.ceil((pointerY - bottomEdge) / 4);
      if (dy !== 0) {
        const before = scroller.scrollTop;
        scroller.scrollTop += Math.max(-24, Math.min(24, dy));
        if (scroller.scrollTop !== before) place(pointerX, pointerY);
        scrollFrame = requestAnimationFrame(autoScroll);
      }
    };

    const place = (x: number, y: number) => {
      // The widget beneath the pointer, looking past the one being dragged.
      const over = document.elementsFromPoint(x, y)
        .map(n => (n as HTMLElement).closest<HTMLElement>('.dash-widget'))
        .find(w => !!w && w !== el && w.parentElement === grid);
      if (!over) return;
      const r = over.getBoundingClientRect();
      // Beside it in a row: left/right half decides. A full-width one: top/bottom.
      const after = r.width < grid.clientWidth * 0.9
        ? x > r.left + r.width / 2
        : y > r.top + r.height / 2;
      const key = `${over.getAttribute('data-widget')}:${after}`;
      if (key === last) return;
      last = key;
      if (after) {
        if (over.nextElementSibling !== el) over.after(el);
      } else if (over.previousElementSibling !== el) {
        over.before(el);
      }
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      pointerX = ev.clientX;
      pointerY = ev.clientY;
      if (!lifted) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        lifted = true;
        el.classList.add('is-dragging');
        grid.classList.add('is-reordering');
      }
      place(pointerX, pointerY);
      if (!scrollFrame) scrollFrame = requestAnimationFrame(autoScroll);
    };

    // Listen on the document: moving the widget through the DOM would drop a
    // pointer capture held by its grip.
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
      scrollFrame = 0;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      if (!lifted) return;
      el.classList.remove('is-dragging');
      grid.classList.remove('is-reordering');
      const order = Array.from(grid.querySelectorAll<HTMLElement>(':scope > .dash-widget'))
        .map(x => x.getAttribute('data-widget'));
      const before = this.layout.widgets.map(w => w.type).join();
      this.layout.widgets.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
      if (this.layout.widgets.map(w => w.type).join() !== before) this.emit();
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }

  /** The nearest ancestor that scrolls vertically (the page's content pane). */
  private static scrollParent(el: HTMLElement): HTMLElement | null {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
    }
    return document.scrollingElement as HTMLElement | null;
  }

  private escape(s: string): string {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
}
