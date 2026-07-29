(function () {

interface BalancerRow {
  asset: string;
  amount: number;
  usdValue: number;
  weight: number;          // current % of portfolio
  held: boolean;
  enabled: boolean;
  max: number | null;      // null = no cap configured for this asset
  target: number | null;
  convertTo: string;
  targets: string[];
}

const DEFAULT_HYSTERESIS = 5;      // points below the cap a rebalance lands
const PREFERRED_TARGETS = ['USDC', 'USD', 'USDT', 'DAI'];

class BalancerController {
  private connections: any[] = [];
  private connId: number | null = null;
  private rows: BalancerRow[] = [];
  private totalUsd = 0;
  private cooldown = 1440;
  private minTrade = 25;
  private dryRun = false;
  private scaleMode: '100' | 'fit' = '100';
  private baseline = '';
  private loading = false;

  constructor() {
    this.bind();
    // Turns the static labels' data-help attributes into the app's "?" tooltips.
    HelpTooltip.init();
    this.initConnections();
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  private async initConnections(): Promise<void> {
    // Deep-linking straight to this route can beat the store's first load.
    if (ExchangeStore.connections.length === 0 || ExchangeStore.supportedExchanges.length === 0) {
      try { await ExchangeStore.loadConnections(); } catch { /* fall through to the empty state */ }
    }

    // Only exchanges that can price holdings AND place market orders. The flag
    // comes from the backend registry, so a future read-only integration is
    // excluded here without touching this page.
    this.connections = ExchangeStore.connections.filter((c: any) => {
      const meta = ExchangeStore.supportedExchanges.find((e: any) => e.id === c.exchange_name);
      return !meta || meta.supports_rebalance === true;
    });

    if (this.connections.length === 0) {
      document.getElementById('balancer-unsupported')?.classList.remove('d-none');
      document.getElementById('balancer-main')?.classList.add('d-none');
      const text = document.getElementById('balancer-unsupported-text');
      if (text && ExchangeStore.connections.length > 0) {
        text.textContent = 'None of your connected exchanges support automated rebalancing. '
          + 'Kraken, Coinbase Advanced, Binance and Robinhood all do.';
      }
      return;
    }

    document.getElementById('balancer-unsupported')?.classList.add('d-none');
    document.getElementById('balancer-main')?.classList.remove('d-none');

    const select = document.getElementById('balancer-connection') as HTMLSelectElement;
    if (select) {
      select.innerHTML = this.connections
        .map(c => `<option value="${c.id}">${this.esc(ExchangeStore.getExchangeName(c.id))}</option>`)
        .join('');
      const active = typeof ExchangeStore.activeMode === 'number' ? ExchangeStore.activeMode : null;
      const preselect = this.connections.find(c => c.id === active) || this.connections[0];
      select.value = String(preselect.id);
      this.connId = preselect.id;
    }

    this.load();
  }

  private bind(): void {
    document.getElementById('balancer-connection')?.addEventListener('change', (e) => {
      this.connId = parseInt((e.target as HTMLSelectElement).value, 10);
      this.load();
    });

    document.getElementById('balancer-refresh')?.addEventListener('click', () => this.load());
    document.getElementById('balancer-reset')?.addEventListener('click', () => this.load());
    document.getElementById('balancer-save')?.addEventListener('click', () => this.save());

    document.getElementById('balancer-scale-toggle')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-scale]') as HTMLElement | null;
      if (!btn) return;
      this.scaleMode = (btn.getAttribute('data-scale') as '100' | 'fit') || '100';
      document.querySelectorAll('#balancer-scale-toggle .rules-tab-btn')
        .forEach(b => b.classList.toggle('active', b === btn));
      this.renderChart();
    });

    document.getElementById('balancer-cooldown')?.addEventListener('input', (e) => {
      const raw = parseFloat((e.target as HTMLInputElement).value);
      this.cooldown = isNaN(raw) ? 0 : raw;
      this.markDirty();
    });

    document.getElementById('balancer-min-trade')?.addEventListener('input', (e) => {
      const raw = parseFloat((e.target as HTMLInputElement).value);
      this.minTrade = isNaN(raw) ? 0 : raw;
      // Only the preview column depends on this — refresh those cells rather
      // than rebuilding the table on every keystroke.
      this.rows.forEach(r => this.updatePreviewCell(r));
      this.markDirty();
    });

    document.getElementById('balancer-dry-run')?.addEventListener('change', (e) => {
      this.dryRun = (e.target as HTMLInputElement).checked;
      this.markDirty();
    });

    // Table edits (delegated — rows are re-rendered often).
    const tbody = document.getElementById('balancer-tbody');
    tbody?.addEventListener('input', (e) => this.onTableInput(e));
    tbody?.addEventListener('change', (e) => this.onTableChange(e));
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  private async load(): Promise<void> {
    if (this.connId == null || this.loading) return;
    this.loading = true;
    this.hideMessages();
    this.setTableMessage('Loading holdings…');

    try {
      const data = await AutomationController.getAllocations(this.connId);
      this.totalUsd = Number(data.total_usd || 0);
      const settings = data.settings || {};
      this.cooldown = Number(settings.cooldown_minutes ?? 1440);
      this.minTrade = Number(settings.min_trade_usd ?? 25);
      this.dryRun = !!settings.dry_run;

      this.rows = (data.positions || []).map((p: any): BalancerRow => ({
        asset: String(p.asset || '').toUpperCase(),
        amount: Number(p.amount || 0),
        usdValue: Number(p.usd_value || 0),
        weight: Number(p.weight_percent || 0),
        held: !!p.held,
        enabled: !!p.enabled,
        max: p.max_percent == null ? null : Number(p.max_percent),
        target: p.target_percent == null ? null : Number(p.target_percent),
        convertTo: p.convert_to_asset || '',
        targets: Array.isArray(p.convert_targets) ? p.convert_targets : [],
      }));

      this.syncSettingInputs();
      this.render();
      this.baseline = this.snapshot();
      this.markDirty();
    } catch (err: any) {
      this.rows = [];
      this.renderChart();
      this.setTableMessage('Could not load holdings.');
      this.showError(err?.message || 'Failed to load balancer configuration');
    } finally {
      this.loading = false;
    }
  }

  private async save(): Promise<void> {
    if (this.connId == null) return;
    const problem = this.validate();
    if (problem) {
      this.showError(problem);
      return;
    }

    const payload = {
      settings: {
        cooldown_minutes: Math.max(1, Math.round(this.cooldown)),
        min_trade_usd: Math.max(0, this.minTrade),
        dry_run: this.dryRun,
      },
      positions: this.rows
        .filter(r => r.max != null)
        .map(r => ({
          asset: r.asset,
          max_percent: r.max,
          target_percent: r.target,
          convert_to_asset: r.convertTo,
          enabled: r.enabled,
        })),
    };

    const btn = document.getElementById('balancer-save') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    try {
      await AutomationController.saveAllocations(this.connId, payload);
      this.showSuccess(payload.positions.length === 0
        ? 'Balancer cleared — no caps are active on this account.'
        : `Balancer saved — ${payload.positions.length} cap${payload.positions.length === 1 ? '' : 's'} active.`);
      await this.load();
    } catch (err: any) {
      this.showError(err?.message || 'Failed to save balancer');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /** Mirrors the server's checks so the common mistakes are caught inline. */
  private validate(): string | null {
    for (const r of this.rows) {
      if (r.max == null) continue;
      if (!(r.max > 0) || r.max > 100) return `${r.asset}: maximum must be between 0 and 100%.`;
      if (r.target == null || r.target < 0) return `${r.asset}: "down to" must be 0 or more.`;
      if (r.target >= r.max) {
        return `${r.asset}: "down to" (${r.target}%) must be below the maximum (${r.max}%), `
          + 'or the rule fires again every cycle.';
      }
      if (!r.convertTo) {
        return r.targets.length === 0
          ? `${r.asset}: this exchange has no market to convert ${r.asset} into, so it can't be capped.`
          : `${r.asset}: choose an asset to convert into.`;
      }
      if (r.convertTo === r.asset) return `${r.asset}: cannot convert into itself.`;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Editing
  // -------------------------------------------------------------------------

  private rowFor(el: HTMLElement): BalancerRow | undefined {
    const asset = el.getAttribute('data-asset') || '';
    return this.rows.find(r => r.asset === asset);
  }

  private onTableInput(e: Event): void {
    const input = e.target as HTMLInputElement;
    const row = this.rowFor(input);
    if (!row) return;
    const field = input.getAttribute('data-field');
    const raw = input.value.trim();

    if (field === 'max') {
      if (raw === '') {
        row.max = null;
        row.target = null;
        row.enabled = false;
      } else {
        row.max = this.clamp(parseFloat(raw), 0.5, 100);
        if (row.target == null || row.target >= row.max) {
          row.target = Math.max(0, Number((row.max - Math.min(DEFAULT_HYSTERESIS, row.max / 2)).toFixed(2)));
        }
        if (!row.convertTo) row.convertTo = this.defaultTarget(row);
        row.enabled = true;
      }
      // Typing a cap into an uncapped row also enables its "down to" and
      // destination controls, so refresh the rest of the row too.
      this.updateRowState(row, 'max');
      this.renderChart();
      this.markDirty();
      return;
    }

    if (field === 'target') {
      row.target = raw === '' ? null : Math.max(0, parseFloat(raw));
      this.updateRowState(row, 'target');
      this.renderChart();
      this.markDirty();
    }
  }

  private onTableChange(e: Event): void {
    const el = e.target as HTMLElement;
    const row = this.rowFor(el);
    if (!row) return;
    const field = el.getAttribute('data-field');

    if (field === 'enabled') {
      const on = (el as HTMLInputElement).checked;
      row.enabled = on;
      if (on && row.max == null) {
        // Seed a sensible cap so there's something to drag: a little above where
        // the position sits today, rounded to a whole percent.
        row.max = this.clamp(Math.ceil(row.weight + DEFAULT_HYSTERESIS), 1, 100);
        row.target = Math.max(0, row.max - DEFAULT_HYSTERESIS);
        if (!row.convertTo) row.convertTo = this.defaultTarget(row);
      }
      // Update this row in place — rebuilding the table would drop the focus
      // ring off the checkbox that was just clicked.
      this.updateRowState(row);
      this.renderChart();
      this.renderTotal();
      this.markDirty();
      return;
    }

    if (field === 'convertTo') {
      row.convertTo = (el as HTMLSelectElement).value;
      this.updatePreviewCell(row);   // the preview names the destination
      this.renderChart();
      this.markDirty();
    }
  }

  private defaultTarget(row: BalancerRow): string {
    for (const pref of PREFERRED_TARGETS) {
      if (row.targets.includes(pref) && pref !== row.asset) return pref;
    }
    return row.targets.find(t => t !== row.asset) || '';
  }

  private clamp(value: number, min: number, max: number): number {
    if (isNaN(value)) return min;
    return Math.max(min, Math.min(max, value));
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private render(): void {
    this.renderChart();
    this.renderTable();
    this.renderTotal();
  }

  private renderChart(): void {
    const host = document.getElementById('balancer-chart');
    if (!host) return;

    const bars = this.rows.map(r => ({
      asset: r.asset,
      weight: r.weight,
      cap: r.max,
      target: r.max != null ? r.target : null,
      enabled: r.enabled,
      held: r.held,
      convertTo: r.max != null ? r.convertTo : null,
    }));

    const axisMax = this.scaleMode === 'fit' ? AllocationChart.fitAxisMax(bars) : 100;

    AllocationChart.render(host, bars, {
      axisMax,
      onCapChange: (asset: string, pct: number) => {
        const row = this.rows.find(r => r.asset === asset);
        if (!row) return;
        row.max = pct;
        if (row.target == null || row.target >= pct) {
          row.target = Math.max(0, Number((pct - Math.min(DEFAULT_HYSTERESIS, pct / 2)).toFixed(2)));
        }
        if (!row.convertTo) row.convertTo = this.defaultTarget(row);
        row.enabled = true;
        this.syncRowInputs(row);
        this.updatePreviewCell(row);
        this.markDirty();
      },
      // Redraw the chart (the target line and handler state settle here), but
      // leave the table's DOM alone — its inputs were kept in step during the
      // drag, and a rebuild mid-interaction is what makes rows flicker.
      onCapCommit: (asset: string) => {
        const row = this.rows.find(r => r.asset === asset);
        if (row) this.updateRowState(row);
        this.renderChart();
        this.renderTotal();
      },
    });
  }

  private renderTable(): void {
    const tbody = document.getElementById('balancer-tbody');
    if (!tbody) return;

    if (this.rows.length === 0) {
      this.setTableMessage('No priced holdings on this account.');
      return;
    }

    tbody.innerHTML = this.rows.map(r => {
      const capped = r.max != null;
      const targetOptions = this.targetOptions(r);
      const heldAmount = r.held
        ? this.fmtAmount(r.amount)
        : '<span class="balancer-muted">not held</span>';
      const heldValue = r.held
        ? this.fmtUsd(r.usdValue)
        : '<span class="balancer-muted">—</span>';

      return `<tr class="${capped && r.enabled ? '' : 'balancer-row-off'}">
        <td>
          <input type="checkbox" data-field="enabled" data-asset="${this.escAttr(r.asset)}"
                 ${r.enabled ? 'checked' : ''} aria-label="Enable cap for ${this.escAttr(r.asset)}">
        </td>
        <td><span class="asset-badge">${this.esc(r.asset)}</span></td>
        <td class="balancer-amount">${heldAmount}</td>
        <td class="balancer-value">${heldValue}</td>
        <td class="balancer-weight ${this.isOver(r) ? 'balancer-over' : ''}">${r.weight.toFixed(2)}%</td>
        <td>
          <input class="balancer-num" type="number" min="0.5" max="100" step="0.5"
                 data-field="max" data-asset="${this.escAttr(r.asset)}"
                 value="${capped ? r.max : ''}" placeholder="—"
                 aria-label="Maximum percent for ${this.escAttr(r.asset)}">
        </td>
        <td>
          <input class="balancer-num" type="number" min="0" max="100" step="0.5"
                 data-field="target" data-asset="${this.escAttr(r.asset)}"
                 value="${capped && r.target != null ? r.target : ''}" placeholder="—"
                 ${capped ? '' : 'disabled'}
                 aria-label="Rebalance down to percent for ${this.escAttr(r.asset)}">
        </td>
        <td>
          <select class="balancer-select" data-field="convertTo" data-asset="${this.escAttr(r.asset)}"
                  ${capped ? '' : 'disabled'} aria-label="Convert ${this.escAttr(r.asset)} into">
            ${targetOptions}
          </select>
        </td>
        <td class="balancer-preview" data-preview="${this.escAttr(r.asset)}">${this.previewText(r)}</td>
      </tr>`;
    }).join('');

    Repaint.nudgeTable('balancer-tbody');
  }

  private targetOptions(row: BalancerRow): string {
    const options = row.targets.slice();
    // Keep a previously-saved destination selectable even if the exchange's
    // market list no longer offers it — silently switching it would be worse.
    if (row.convertTo && !options.includes(row.convertTo)) options.unshift(row.convertTo);
    if (options.length === 0) return '<option value="">No pair available</option>';
    return ['<option value="">Choose…</option>']
      .concat(options.map(t =>
        `<option value="${this.escAttr(t)}" ${t === row.convertTo ? 'selected' : ''}>${this.esc(t)}</option>`))
      .join('');
  }

  private isOver(row: BalancerRow): boolean {
    return row.max != null && row.weight >= row.max;
  }

  /** What the worker would do on its next pass, with the values on screen. */
  private previewText(row: BalancerRow): string {
    if (row.max == null) return '<span class="balancer-muted">—</span>';
    if (!row.enabled) return '<span class="balancer-muted">paused</span>';
    if (!this.isOver(row)) return '<span class="balancer-muted">under cap</span>';

    const target = row.target ?? 0;
    const excess = (row.weight - target) / 100 * this.totalUsd;
    if (excess < this.minTrade) {
      return `<span class="balancer-muted">${this.fmtUsd(excess)} — under minimum</span>`;
    }
    const unitPrice = row.amount > 0 ? row.usdValue / row.amount : 0;
    const amount = unitPrice > 0 ? Math.min(excess / unitPrice, row.amount) : 0;
    const verb = this.dryRun ? 'Would simulate' : 'Sell';
    // Four significant figures is plenty here — the exact fill size is decided
    // at execution anyway, and eight decimals just makes the row hard to read.
    return `<span class="balancer-trim">${verb} ${this.fmtTradeAmount(amount)} ${this.esc(row.asset)}`
      + ` → ${this.esc(row.convertTo || '?')} <span class="balancer-muted">(${this.fmtUsd(excess)})</span></span>`;
  }

  private updatePreviewCell(row: BalancerRow): void {
    const cell = document.querySelector(`[data-preview="${CSS.escape(row.asset)}"]`);
    if (cell) cell.innerHTML = this.previewText(row);
    const weightCell = cell?.parentElement?.querySelector('.balancer-weight');
    if (weightCell) weightCell.classList.toggle('balancer-over', this.isOver(row));
  }

  /** Bring one row's DOM back in step with its state, without a table rebuild.
   *
   * Everything the table shows for a row is either an input (synced here) or a
   * derived cell (the preview), so a targeted update is enough — and it keeps
   * focus and the scroll position where the user left them.
   */
  private updateRowState(row: BalancerRow, skip?: 'max' | 'target'): void {
    this.syncRowInputs(row, skip);

    const select = document.querySelector<HTMLSelectElement>(
      `select[data-field="convertTo"][data-asset="${CSS.escape(row.asset)}"]`);
    if (select) {
      select.disabled = row.max == null;
      if (select.value !== row.convertTo) {
        const known = Array.from(select.options).some(o => o.value === row.convertTo);
        if (!known && row.convertTo) {
          select.add(new Option(row.convertTo, row.convertTo), 1);
        }
        select.value = row.convertTo;
      }
    }

    const tr = select?.closest('tr')
      || document.querySelector(`[data-preview="${CSS.escape(row.asset)}"]`)?.closest('tr');
    tr?.classList.toggle('balancer-row-off', !(row.max != null && row.enabled));

    this.updatePreviewCell(row);
  }

  /** Push state back into a row's inputs (used while dragging the chart).
   *
   * ``skip`` leaves one field alone: writing a parsed number back into the box
   * someone is still typing in would eat a half-typed "40." on the keystroke.
   */
  private syncRowInputs(row: BalancerRow, skip?: 'max' | 'target'): void {
    const maxInput = document.querySelector<HTMLInputElement>(
      `input[data-field="max"][data-asset="${CSS.escape(row.asset)}"]`);
    if (maxInput && skip !== 'max') maxInput.value = row.max == null ? '' : String(row.max);

    const targetInput = document.querySelector<HTMLInputElement>(
      `input[data-field="target"][data-asset="${CSS.escape(row.asset)}"]`);
    if (targetInput) {
      if (skip !== 'target') targetInput.value = row.target == null ? '' : String(row.target);
      targetInput.disabled = row.max == null;
    }

    const enabledInput = document.querySelector<HTMLInputElement>(
      `input[data-field="enabled"][data-asset="${CSS.escape(row.asset)}"]`);
    if (enabledInput) enabledInput.checked = row.enabled;
  }

  private syncSettingInputs(): void {
    const cooldown = document.getElementById('balancer-cooldown') as HTMLInputElement | null;
    if (cooldown) cooldown.value = String(this.cooldown);
    const minTrade = document.getElementById('balancer-min-trade') as HTMLInputElement | null;
    if (minTrade) minTrade.value = String(this.minTrade);
    const dry = document.getElementById('balancer-dry-run') as HTMLInputElement | null;
    if (dry) dry.checked = this.dryRun;
  }

  private renderTotal(): void {
    const el = document.getElementById('balancer-total');
    if (el) el.textContent = `Account total: ${this.fmtUsd(this.totalUsd)}`;

    const subtitle = document.getElementById('balancer-subtitle');
    if (subtitle && this.connId != null) {
      const active = this.rows.filter(r => r.max != null && r.enabled).length;
      subtitle.textContent = `Cap how much of your ${ExchangeStore.getExchangeName(this.connId)} `
        + `portfolio any one coin is allowed to become — ${active} cap${active === 1 ? '' : 's'} active.`;
    }
  }

  private setTableMessage(text: string): void {
    const tbody = document.getElementById('balancer-tbody');
    if (tbody) tbody.innerHTML = `<tr class="empty-row"><td colspan="9">${this.esc(text)}</td></tr>`;
  }

  // -------------------------------------------------------------------------
  // Dirty state + messages
  // -------------------------------------------------------------------------

  private snapshot(): string {
    return JSON.stringify({
      cooldown: this.cooldown,
      minTrade: this.minTrade,
      dryRun: this.dryRun,
      rows: this.rows.map(r => [r.asset, r.max, r.target, r.convertTo, r.enabled]),
    });
  }

  private markDirty(): void {
    const dirty = this.baseline !== '' && this.snapshot() !== this.baseline;
    document.getElementById('balancer-dirty')?.classList.toggle('d-none', !dirty);
  }

  private showError(message: string): void {
    const box = document.getElementById('balancer-error');
    const msg = document.getElementById('balancer-error-message');
    if (box && msg) {
      msg.textContent = message;
      box.classList.remove('d-none');
    }
    document.getElementById('balancer-success')?.classList.add('d-none');
  }

  private showSuccess(message: string): void {
    const box = document.getElementById('balancer-success');
    const msg = document.getElementById('balancer-success-message');
    if (box && msg) {
      msg.textContent = message;
      box.classList.remove('d-none');
    }
    document.getElementById('balancer-error')?.classList.add('d-none');
  }

  private hideMessages(): void {
    document.getElementById('balancer-error')?.classList.add('d-none');
    document.getElementById('balancer-success')?.classList.add('d-none');
  }

  // -------------------------------------------------------------------------
  // Formatting
  // -------------------------------------------------------------------------

  private fmtUsd(n: number): string {
    if (!isFinite(n)) return '$0';
    if (Math.abs(n) >= 1000) return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (Math.abs(n) >= 1) return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }

  /** Compact amount for the "would trim now" sentence: four significant
   *  figures, since the exact fill size is decided at execution anyway and
   *  eight decimals just makes the row hard to read. */
  private fmtTradeAmount(n: number): string {
    if (!isFinite(n) || n === 0) return '0';
    return Number(n.toPrecision(4)).toLocaleString(undefined, { maximumFractionDigits: 8 });
  }

  private fmtAmount(n: number): string {
    if (!isFinite(n)) return '0';
    if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
    return n.toLocaleString(undefined, { maximumFractionDigits: 8 });
  }

  private esc(str: any): string {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  }

  private escAttr(str: any): string {
    return this.esc(str).replace(/"/g, '&quot;');
  }
}

new BalancerController();

})();
