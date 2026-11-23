/*
 * Charts page: the drawing tool state machine. Listens on the chart in the
 * capture phase so a press that lands on a drawing (or places one) never
 * reaches lightweight-charts and pans the chart; every other press falls
 * through, so panning and zooming work as normal in cursor mode.
 *
 * Placing: click to set each anchor (the next one follows the mouse), or
 * press-drag-release for two-point tools. Shift keeps a line level.
 */

type DrawingTool = 'cursor' | string;

class DrawingController {
  tool: DrawingTool = 'cursor';
  magnet = false;
  allHidden = false;
  private selected: { paneId: string; id: string } | null = null;
  private hover: { paneId: string; id: string } | null = null;
  private draft: { paneId: string; d: ChartDrawing; placing: number; downX: number; downY: number } | null = null;
  private drag: {
    paneId: string; d: ChartDrawing; hit: DrawingHit;
    startX: number; startY: number; startLogical: number; startPrice: number;
    orig: ChartPoint[]; moved: boolean;
  } | null = null;
  private editor: HTMLInputElement | null = null;
  private lastColor: string | null = null;

  /** The page listens to these to update its toolbar and style bar. */
  onToolChange: (tool: DrawingTool) => void = () => {};
  onSelectionChange: (d: ChartDrawing | null) => void = () => {};
  /** Drawings that were moved (alerts follow them) or removed (alerts go too). */
  onDrawingsMoved: (ds: ChartDrawing[]) => void = () => {};
  onDrawingsRemoved: (ds: ChartDrawing[]) => void = () => {};

  private readonly onDown = (e: PointerEvent) => this.pointerDown(e);
  private readonly onMouseDown = (e: MouseEvent) => { if (this.swallow) { e.stopPropagation(); e.preventDefault(); this.swallow = false; } };
  private readonly onMove = (e: PointerEvent) => this.pointerMove(e);
  private readonly onUp = (e: PointerEvent) => this.pointerUp(e);
  private readonly onDbl = (e: MouseEvent) => this.doubleClick(e);
  private readonly onLeave = () => { if (this.hover) { this.hover = null; this.ws.redraw(); } };
  private swallow = false;

  constructor(private ws: ChartWorkspace) {
    const el = ws.root;
    el.addEventListener('pointerdown', this.onDown, true);
    el.addEventListener('mousedown', this.onMouseDown, true);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('dblclick', this.onDbl, true);
    el.addEventListener('pointerleave', this.onLeave);
  }

  destroy(): void {
    const el = this.ws.root;
    el.removeEventListener('pointerdown', this.onDown, true);
    el.removeEventListener('mousedown', this.onMouseDown, true);
    el.removeEventListener('pointermove', this.onMove);
    el.removeEventListener('dblclick', this.onDbl, true);
    el.removeEventListener('pointerleave', this.onLeave);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.closeEditor(false);
  }

  // ── Public API for the page ───────────────────────────────────────────────

  setTool(tool: DrawingTool): void {
    this.cancelDraft();
    this.tool = tool;
    this.ws.root.classList.toggle('cw-placing', tool !== 'cursor');
    this.onToolChange(tool);
  }

  selectedIdIn(paneId: string): string | null {
    return this.selected?.paneId === paneId ? this.selected.id : (this.draft?.paneId === paneId ? this.draft.d.id : null);
  }

  hoverIdIn(paneId: string): string | null {
    return this.hover?.paneId === paneId ? this.hover.id : null;
  }

  selectedDrawing(): ChartDrawing | null {
    if (!this.selected) return null;
    return this.ws.paneState(this.selected.paneId)?.drawings.find((d) => d.id === this.selected!.id) || null;
  }

  /** Drop a selection whose drawing no longer exists (after undo or pane removal). */
  validateSelection(): void {
    if (this.selected && !this.selectedDrawing()) this.select(null);
  }

  /** Apply a style edit to the selected drawing and commit it. */
  updateSelected(mut: (d: ChartDrawing) => void): void {
    const d = this.selectedDrawing();
    if (!d) return;
    mut(d);
    if (d.style.color) this.lastColor = d.style.color;
    this.ws.drawingsChanged();
    this.onSelectionChange(d);
  }

  deleteSelected(): void {
    const sel = this.selected;
    const p = sel && this.ws.paneState(sel.paneId);
    if (!sel || !p) return;
    const gone = p.drawings.filter((d) => d.id === sel.id);
    p.drawings = p.drawings.filter((d) => d.id !== sel.id);
    this.select(null);
    this.ws.drawingsChanged();
    this.onDrawingsRemoved(gone);
  }

  cloneSelected(): void {
    const d = this.selectedDrawing();
    const p = this.selected && this.ws.paneState(this.selected.paneId);
    if (!d || !p) return;
    const copy: ChartDrawing = JSON.parse(JSON.stringify(d));
    copy.id = ChartGeo.uid('d');
    copy.locked = false;
    delete copy.alertId;
    // Nudge it a few bars right so it's visibly a copy.
    copy.points = copy.points.map((pt) => ({ time: this.ws.logicalToTime(this.ws.timeToLogical(pt.time) + 5), price: pt.price }));
    p.drawings.push(copy);
    this.select({ paneId: p.id, id: copy.id });
    this.ws.drawingsChanged();
  }

  clearAll(): void {
    const total = this.ws.state.panes.reduce((n, p) => n + p.drawings.length, 0);
    if (!total || !window.confirm(`Remove all ${total} drawing(s) from this chart?`)) return;
    const gone = this.ws.state.panes.flatMap((p) => p.drawings);
    this.ws.state.panes.forEach((p) => { p.drawings = []; });
    this.select(null);
    this.ws.drawingsChanged();
    this.onDrawingsRemoved(gone);
  }

  setAllLocked(locked: boolean): void {
    this.ws.state.panes.forEach((p) => p.drawings.forEach((d) => { d.locked = locked; }));
    this.ws.drawingsChanged();
    this.onSelectionChange(this.selectedDrawing());
  }

  allLocked(): boolean {
    const all = this.ws.state.panes.flatMap((p) => p.drawings);
    return all.length > 0 && all.every((d) => d.locked);
  }

  toggleHidden(): void {
    this.allHidden = !this.allHidden;
    this.ws.redraw();
  }

  /** Esc: abandon a placement in progress, else clear the selection, else back to the cursor. */
  cancel(): boolean {
    if (this.editor) { this.closeEditor(false); return true; }
    if (this.draft) { this.setTool('cursor'); return true; }
    if (this.selected) { this.select(null); return true; }
    if (this.tool !== 'cursor') { this.setTool('cursor'); return true; }
    return false;
  }

  isEditingText(): boolean { return !!this.editor; }

  /** The drawing still being placed, which isn't part of the saved chart yet. */
  draftId(): string | null { return this.draft?.d.id ?? null; }

  // ── Selection ─────────────────────────────────────────────────────────────

  private select(sel: { paneId: string; id: string } | null): void {
    this.selected = sel;
    this.ws.redraw();
    this.onSelectionChange(this.selectedDrawing());
  }

  // ── Pointer handling ──────────────────────────────────────────────────────

  private stop(e: Event): void {
    e.preventDefault();
    e.stopPropagation();
    this.swallow = true;
  }

  private pointerDown(e: PointerEvent): void {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.cw-heads, .cw-popover, .cw-text-editor')) return;
    this.ws.closePopover();

    if (this.draft) {
      const loc = this.ws.locateIn(this.draft.paneId, e.clientX, e.clientY);
      this.stop(e);
      if (!loc) return;
      this.updateDraftPoint(loc, e.shiftKey);
      this.draft.placing++;
      this.draft.downX = e.clientX;
      this.draft.downY = e.clientY;
      const def = ChartDrawings.get(this.draft.d.type);
      if (this.draft.placing >= def.points) this.finishDraft();
      else {
        // Start the next anchor where this one landed.
        this.draft.d.points[this.draft.placing] = { ...this.draft.d.points[this.draft.placing - 1] };
        this.ws.redraw();
      }
      return;
    }

    const loc = this.ws.locate(e.clientX, e.clientY);
    if (this.tool !== 'cursor') {
      if (!loc) return;
      this.stop(e);
      this.startDraft(loc, e);
      return;
    }
    if (!loc) return;

    const found = ChartDrawings.hitTest(loc.rt.st.drawings, loc.frame, loc.x, loc.y, this.selected?.id ?? null);
    if (!found) {
      if (this.selected) this.select(null);
      return;   // let the chart pan
    }
    this.stop(e);
    this.select({ paneId: loc.rt.st.id, id: found.d.id });
    if (found.d.locked) return;
    this.drag = {
      paneId: loc.rt.st.id, d: found.d, hit: found.hit,
      startX: e.clientX, startY: e.clientY,
      startLogical: this.ws.xToLogical(loc.x),
      startPrice: loc.rt.main.coordinateToPrice(loc.y) ?? 0,
      orig: found.d.points.map((p) => ({ ...p })), moved: false,
    };
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
  }

  private startDraft(loc: NonNullable<ReturnType<ChartWorkspace['locate']>>, e: PointerEvent): void {
    const p = this.ws.pointAt(loc.rt, loc.x, loc.y, this.magnet);
    const d = ChartDrawings.create(this.tool, p, loc.frame.theme, this.lastColor || undefined);
    const def = ChartDrawings.get(this.tool);
    if (this.selected) this.select(null);
    loc.rt.st.drawings.push(d);
    this.draft = { paneId: loc.rt.st.id, d, placing: 1, downX: e.clientX, downY: e.clientY };
    if (def.points === 1) { this.finishDraft(); return; }
    window.addEventListener('pointerup', this.onUp);
    this.ws.redraw();
  }

  private updateDraftPoint(loc: NonNullable<ReturnType<ChartWorkspace['locate']>>, shift: boolean): void {
    if (!this.draft) return;
    const { d, placing } = this.draft;
    const p = this.ws.pointAt(loc.rt, loc.x, loc.y, this.magnet);
    // Shift keeps a two-point line level.
    if (shift && placing === 1 && d.points.length >= 2) p.price = d.points[0].price;
    d.points[placing] = p;
  }

  private finishDraft(): void {
    if (!this.draft) return;
    const { paneId, d } = this.draft;
    this.draft = null;
    window.removeEventListener('pointerup', this.onUp);
    this.selected = { paneId, id: d.id };
    this.setTool('cursor');
    this.ws.drawingsChanged();
    this.onSelectionChange(d);
    if (d.type === 'text') this.openEditor(paneId, d, true);
  }

  private cancelDraft(): void {
    if (!this.draft) return;
    const { paneId, d } = this.draft;
    const p = this.ws.paneState(paneId);
    if (p) p.drawings = p.drawings.filter((x) => x.id !== d.id);
    this.draft = null;
    window.removeEventListener('pointerup', this.onUp);
    this.ws.redraw();
  }

  private pointerMove(e: PointerEvent): void {
    if (this.drag) { this.dragMove(e); return; }
    if (this.draft) {
      const loc = this.ws.locateIn(this.draft.paneId, e.clientX, e.clientY);
      if (loc) { this.updateDraftPoint(loc, e.shiftKey); this.ws.redraw(); }
      return;
    }
    if (this.tool !== 'cursor') return;
    const loc = this.ws.locate(e.clientX, e.clientY);
    const found = loc && ChartDrawings.hitTest(loc.rt.st.drawings, loc.frame, loc.x, loc.y, this.selected?.id ?? null);
    const next = found && loc ? { paneId: loc.rt.st.id, id: found.d.id } : null;
    this.ws.root.classList.toggle('cw-over-handle', !!found && found.hit.part === 'handle' && !found.d.locked);
    this.ws.root.classList.toggle('cw-over-body', !!found && found.hit.part === 'body' && !found.d.locked);
    if (next?.id !== this.hover?.id) {
      this.hover = next;
      this.ws.redraw();
    }
  }

  private dragMove(e: PointerEvent): void {
    const dr = this.drag!;
    if (!dr.moved && Math.hypot(e.clientX - dr.startX, e.clientY - dr.startY) < 3) return;
    dr.moved = true;
    const loc = this.ws.locateIn(dr.paneId, e.clientX, e.clientY);
    if (!loc) return;
    if (dr.hit.part === 'handle') {
      const p = this.ws.pointAt(loc.rt, loc.x, loc.y, this.magnet);
      const def = ChartDrawings.get(dr.d.type);
      if (e.shiftKey && def.points === 2 && def.lineStyle) p.price = dr.d.points[1 - dr.hit.index].price;
      ChartDrawings.moveHandle(dr.d, dr.hit.index, p);
    } else {
      const dl = this.ws.xToLogical(loc.x) - dr.startLogical;
      const dp = (loc.rt.main.coordinateToPrice(loc.y) ?? dr.startPrice) - dr.startPrice;
      dr.d.points = dr.orig.map((p) => ({
        time: this.ws.logicalToTime(this.ws.timeToLogical(p.time) + dl),
        price: p.price + dp,
      }));
    }
    this.ws.redraw();
  }

  private pointerUp(e: PointerEvent): void {
    if (this.drag) {
      const { moved, d } = this.drag;
      this.drag = null;
      window.removeEventListener('pointermove', this.onMove);
      window.removeEventListener('pointerup', this.onUp);
      if (moved) {
        this.ws.drawingsChanged();
        this.onDrawingsMoved([d]);
      }
      return;
    }
    // Press-drag-release places a two-point tool in one gesture.
    if (this.draft && this.draft.placing === 1 &&
        Math.hypot(e.clientX - this.draft.downX, e.clientY - this.draft.downY) > 6 &&
        ChartDrawings.get(this.draft.d.type).points === 2) {
      const loc = this.ws.locateIn(this.draft.paneId, e.clientX, e.clientY);
      if (loc) this.updateDraftPoint(loc, e.shiftKey);
      this.finishDraft();
    }
  }

  private doubleClick(e: MouseEvent): void {
    if (this.tool !== 'cursor') return;
    const loc = this.ws.locate(e.clientX, e.clientY);
    if (!loc) return;
    const found = ChartDrawings.hitTest(loc.rt.st.drawings, loc.frame, loc.x, loc.y, this.selected?.id ?? null);
    if (found?.d.type === 'text' && !found.d.locked) {
      e.preventDefault();
      e.stopPropagation();
      this.openEditor(loc.rt.st.id, found.d, false);
    }
  }

  // ── Text editing ──────────────────────────────────────────────────────────

  openEditor(paneId: string, d: ChartDrawing, isNew: boolean): void {
    this.closeEditor(false);
    const loc = this.ws.locateIn(paneId, 0, 0);
    if (!loc) return;
    const x = loc.frame.toX(d.points[0].time), y = loc.frame.toY(d.points[0].price);
    if (x == null || y == null) return;
    const rootBox = this.ws.root.getBoundingClientRect();
    const paneTop = -loc.y;   // locateIn(…, 0, 0) gives y = -paneTop
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cw-text-editor';
    input.value = d.text || '';
    input.placeholder = 'Type a note…';
    input.maxLength = 140;
    input.style.left = `${x + (this.ws.root.querySelector('.cw-chart')!.getBoundingClientRect().left - rootBox.left)}px`;
    input.style.top = `${paneTop - rootBox.top + y - 13}px`;
    input.style.color = d.style.color;
    const commit = () => this.closeEditor(true);
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') commit();
      else if (ev.key === 'Escape') this.closeEditor(false);
    });
    input.addEventListener('blur', commit);
    (input as any).__target = { paneId, id: d.id, isNew };
    this.ws.root.appendChild(input);
    this.editor = input;
    input.focus();
    input.select();
  }

  private closeEditor(commit: boolean): void {
    const input = this.editor;
    if (!input) return;
    this.editor = null;
    const t = (input as any).__target as { paneId: string; id: string; isNew: boolean };
    input.remove();
    const p = this.ws.paneState(t.paneId);
    const d = p?.drawings.find((x) => x.id === t.id);
    if (!p || !d) return;
    const text = input.value.trim();
    if (commit && text) {
      if (text !== d.text) { d.text = text; this.ws.drawingsChanged(); }
    } else if (!d.text) {
      // A new note left empty is dropped.
      p.drawings = p.drawings.filter((x) => x.id !== d.id);
      this.select(null);
      this.ws.drawingsChanged();
    }
    this.ws.redraw();
  }
}
