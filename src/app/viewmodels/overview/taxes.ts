(function () {

/**
 * Safety net on each sync loop. Every call is server-bounded to ~12s, so this
 * is several minutes of pulling per connection — finite, so a backend that
 * never reports `complete` cannot spin forever.
 */
const MAX_SYNC_ROUNDS = 40;

const EXCHANGE_NAMES: Record<string, string> = {
  kraken: 'Kraken',
  coinbase: 'Coinbase',
  binance: 'Binance',
  robinhood: 'Robinhood',
};

class TaxesController {
  private method: CostBasisMethod = TaxController.getPreferredMethod();
  private year: number | undefined;
  private gains: TaxGains | null = null;
  private status: TaxSyncStatus | null = null;
  private syncing = false;
  private exporting = false;
  /** Set when the page is torn down, so an in-flight sync loop stops. */
  private disposed = false;

  /** Table filter: only sales missing a cost or a USD price. */
  private needsInfoOnly = false;
  /** The fix the dialog is open for; kind 'new' is a free-standing purchase. */
  private fixing: TaxFix | { kind: 'new' } | null = null;
  private saving = false;

  constructor() {
    void this.init();
  }

  private async init(): Promise<void> {
    this.bind();
    this.bindFixes();
    this.watchForTeardown();
    this.applyMethodTabs();
    await Promise.all([this.loadGains(), this.loadManual()]);

    // A connection that has never been synced gets pulled on first visit, so
    // the page is useful without the user discovering the button.
    if (this.status?.any_pending) {
      await this.runSync();
    }
  }

  private watchForTeardown(): void {
    const content = document.getElementById('app-content');
    if (!content) return;
    const observer = new MutationObserver(() => {
      if (!document.getElementById('taxes-table')) {
        this.disposed = true;
        // The dialog's overlay sits outside the page container; make sure
        // the keydown listener goes with the page.
        document.removeEventListener('keydown', this.onKeydown);
        observer.disconnect();
      }
    });
    observer.observe(content, { childList: true });
  }

  private bind(): void {
    document.getElementById('taxes-method-tabs')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.rules-tab-btn') as HTMLElement | null;
      const next = btn?.getAttribute('data-method') as CostBasisMethod | null;
      if (!next || next === this.method) return;
      this.method = next;
      TaxController.setPreferredMethod(next);
      this.applyMethodTabs();
      void this.loadGains();
    });

    const yearSelect = document.getElementById('taxes-year') as HTMLSelectElement | null;
    yearSelect?.addEventListener('change', () => {
      this.year = Number(yearSelect.value) || undefined;
      void this.loadGains();
    });

    document.getElementById('taxes-sync-btn')?.addEventListener('click', () => void this.runSync());
    document.getElementById('taxes-export-8949')?.addEventListener('click', () => void this.exportCsv('8949'));
    document.getElementById('taxes-export-koinly')?.addEventListener('click', () => void this.exportCsv('koinly'));
  }

  private applyMethodTabs(): void {
    document.querySelectorAll('#taxes-method-tabs .rules-tab-btn').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-method') === this.method);
    });
  }

  // ---- data ----

  private async loadGains(): Promise<void> {
    try {
      const gains = await TaxController.getGains(this.method, this.year, this.needsInfoOnly);
      if (this.disposed) return;
      this.gains = gains;
      this.year = gains.year;
      this.status = gains.sync;
      this.hideError();
      this.renderYears(gains);
      this.renderNeedsInfo(gains);
      this.renderConnections(gains.sync);
      this.renderSummary(gains);
      this.renderWarnings(gains);
      this.renderRows(gains);
    } catch (e: any) {
      if (this.disposed) return;
      this.showError(e?.message || 'Could not load gains.');
      const tbody = document.getElementById('taxes-tbody');
      if (tbody) tbody.innerHTML = '<tr class="empty-row"><td colspan="10">Gains could not be loaded</td></tr>';
    }
  }

  /**
   * Pull new fills for every connection that has a trade-history API, then
   * the transfer history the cost basis also depends on (an internal move is
   * what carries a coin's cost from one exchange to another).
   */
  private async runSync(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.setSyncBusy(true);
    this.hideError();
    this.hideSuccess();

    const errors: string[] = [];
    let newTrades = 0;
    try {
      const status = this.status || await TaxController.getStatus();
      const targets = status.connections.filter(c => c.trades.state !== 'unsupported'
                                                   && c.trades.state !== 'disabled');
      for (const conn of targets) {
        const name = this.connName(conn);
        for (let round = 0; round < MAX_SYNC_ROUNDS; round++) {
          if (this.disposed) return;
          this.showProgress(`Syncing trades from ${name}…`,
            newTrades ? `${newTrades.toLocaleString()} new` : '');
          const result = await TaxController.sync(conn.connection_id);
          if (this.disposed) return;
          newTrades += result.new_rows;
          this.renderConnections(result.sync);
          if (result.errors.length) errors.push(...result.errors);
          if (result.already_running || result.complete || result.errors.length) break;
        }
      }

      for (let round = 0; round < MAX_SYNC_ROUNDS; round++) {
        if (this.disposed) return;
        this.showProgress('Syncing deposits and withdrawals…',
          newTrades ? `${newTrades.toLocaleString()} new trades` : '');
        const result = await TransferController.sync('all');
        if (this.disposed) return;
        if (result.already_running || result.complete) break;
      }

      await this.loadGains();
      if (this.disposed) return;
      if (errors.length) {
        this.showError(Array.from(new Set(errors)).join(' '));
      } else {
        this.showSuccess(newTrades
          ? `Synced ${newTrades.toLocaleString()} new trade${newTrades === 1 ? '' : 's'}.`
          : 'Trade history is up to date.');
      }
    } catch (e: any) {
      if (!this.disposed) this.showError(e?.message || 'Sync failed.');
    } finally {
      this.syncing = false;
      if (!this.disposed) {
        this.setSyncBusy(false);
        this.hideProgress();
      }
    }
  }

  private async exportCsv(format: TaxExportFormat): Promise<void> {
    if (this.exporting) return;
    this.exporting = true;
    this.hideError();
    this.hideSuccess();
    try {
      const file = await TaxController.exportFile(format, this.method, this.year);
      if (this.disposed) return;
      const result = await FileSave.save({
        filename: file.filename,
        base64: file.content_base64,
        mime: 'text/csv',
        filterName: 'CSV file',
        extensions: ['csv'],
      });
      if (this.disposed || result.canceled) return;
      if (!result.saved) {
        this.showError(result.error || 'Could not save the file.');
        return;
      }
      const what = format === '8949'
        ? `${file.rows.toLocaleString()} sale${file.rows === 1 ? '' : 's'} for ${this.year} (${this.method.toUpperCase()})`
        : `${file.rows.toLocaleString()} trades and transfers for Koinly. Import it as one wallet`;
      this.showSuccess(`Exported ${what}.`);
    } catch (e: any) {
      if (!this.disposed) this.showError(e?.message || 'Export failed.');
    } finally {
      this.exporting = false;
    }
  }

  // ---- rendering ----

  private renderYears(gains: TaxGains): void {
    const select = document.getElementById('taxes-year') as HTMLSelectElement | null;
    if (!select) return;
    select.innerHTML = gains.years
      .map(y => `<option value="${y}"${y === gains.year ? ' selected' : ''}>${y}</option>`)
      .join('');
  }

  private connName(conn: TaxConnectionStatus): string {
    const name = EXCHANGE_NAMES[conn.exchange] || conn.exchange;
    return conn.label ? `${name} (${conn.label})` : name;
  }

  private renderConnections(status: TaxSyncStatus): void {
    this.status = status;
    const host = document.getElementById('taxes-connections');
    if (!host) return;
    if (!status.connections.length) {
      host.innerHTML = '<div class="taxes-empty">No validated exchange connections yet. '
        + 'Add one on the Profile page to sync its trade history.</div>';
      return;
    }

    host.innerHTML = status.connections.map((conn) => {
      const t = conn.trades;
      const [badgeClass, badgeText] = this.badgeFor(t.state);
      const meta: string[] = [];
      if (t.state !== 'unsupported') {
        meta.push(`${conn.trade_count.toLocaleString()} trade${conn.trade_count === 1 ? '' : 's'}`);
      }
      if (t.age_seconds !== undefined && t.age_seconds !== null) {
        meta.push(`synced ${this.fmtAge(t.age_seconds)}`);
      }
      if (t.skipped_markets) {
        meta.push(`${t.skipped_markets} market${t.skipped_markets === 1 ? '' : 's'} skipped`);
      }

      let reason = '';
      if (t.state === 'disabled' && t.disabled_reason) reason = t.disabled_reason;
      else if (t.state === 'error' && t.last_error) reason = t.last_error;
      else if (t.state === 'unsupported') reason = 'This exchange has no trade-history API.';
      else if (conn.exchange === 'binance') {
        reason = 'Binance only reports trades market by market, so Cyrus checks the '
          + 'markets for coins you hold, have moved, or have traded before.';
      } else if (conn.exchange === 'robinhood') {
        reason = 'Robinhood has no fills endpoint; each filled order counts as one trade.';
      }

      return `
        <div class="taxes-conn">
          <div class="taxes-conn-head">
            <span class="taxes-conn-name" title="${this.escapeAttr(this.connName(conn))}">${this.escapeHtml(this.connName(conn))}</span>
            <span class="taxes-badge ${badgeClass}">${badgeText}</span>
          </div>
          ${meta.length ? `<div class="taxes-conn-meta">${this.escapeHtml(meta.join(' · '))}</div>` : ''}
          ${reason ? `<div class="taxes-conn-reason">${this.escapeHtml(reason)}</div>` : ''}
        </div>`;
    }).join('');
  }

  private badgeFor(state: TradeSyncState): [string, string] {
    switch (state) {
      case 'idle': return ['taxes-badge-ok', 'Up to date'];
      case 'backfilling': return ['taxes-badge-pending', 'Partly synced'];
      case 'not_started': return ['taxes-badge-pending', 'Not synced'];
      case 'error': return ['taxes-badge-bad', 'Sync error'];
      case 'disabled': return ['taxes-badge-bad', 'Needs permission'];
      default: return ['taxes-badge-muted', 'Not available'];
    }
  }

  private renderSummary(gains: TaxGains): void {
    const host = document.getElementById('taxes-summary');
    if (!host) return;
    const s = gains.summary;
    const sales = `${s.disposals.toLocaleString()} sale${s.disposals === 1 ? '' : 's'} in ${gains.year}`;
    const missing = s.missing_basis
      ? `${s.missing_basis.toLocaleString()} missing cost basis, not counted`
      : sales;
    const tile = (label: string, value: string, sub: string, cls = '') => `
      <div class="taxes-tile">
        <div class="taxes-tile-label">${label}</div>
        <div class="taxes-tile-value ${cls}">${this.escapeHtml(value)}</div>
        <div class="taxes-tile-sub">${this.escapeHtml(sub)}</div>
      </div>`;
    host.innerHTML = [
      tile('Net gain / loss', this.fmtSigned(s.gain_usd), missing, this.pnlClass(s.gain_usd)),
      tile('Short-term', this.fmtSigned(s.short_term_gain_usd), 'Held one year or less',
        this.pnlClass(s.short_term_gain_usd)),
      tile('Long-term', this.fmtSigned(s.long_term_gain_usd), 'Held more than one year',
        this.pnlClass(s.long_term_gain_usd)),
      tile('Proceeds', this.fmtUsd(s.proceeds_usd), sales),
      tile('Cost basis', this.fmtUsd(s.cost_usd), `${gains.method.toUpperCase()} lot matching`),
    ].join('');
  }

  private renderWarnings(gains: TaxGains): void {
    const host = document.getElementById('taxes-warnings');
    if (!host) return;
    const items = gains.warnings.map(w => `<li>${this.escapeHtml(w.message)}</li>`);
    const unsynced = gains.sync.connections.filter(c =>
      c.trades.state === 'not_started' || c.trades.state === 'backfilling');
    if (unsynced.length) {
      items.unshift(`<li>${this.escapeHtml(unsynced.map(c => this.connName(c)).join(', '))} `
        + `${unsynced.length === 1 ? "hasn't" : "haven't"} finished syncing, so these figures `
        + `may be incomplete.</li>`);
    }
    if (!items.length) {
      host.classList.add('d-none');
      host.innerHTML = '';
      return;
    }
    host.innerHTML = `
      <div class="taxes-warnings-title"><i class="fa-solid fa-triangle-exclamation"></i>
        Check before filing</div>
      <ul>${items.join('')}</ul>`;
    host.classList.remove('d-none');
  }

  private renderRows(gains: TaxGains): void {
    const tbody = document.getElementById('taxes-tbody');
    const note = document.getElementById('taxes-table-note');
    if (!tbody) return;

    if (!gains.disposals.length) {
      const why = gains.needs_info_only
        ? `Every sale in ${gains.year} has its cost and price. Nothing left to fill in.`
        : gains.trade_count
          ? `No sales in ${gains.year}.`
          : 'No trade history yet. Sync history above to pull your trades.';
      tbody.innerHTML = `<tr class="empty-row"><td colspan="10">${this.escapeHtml(why)}</td></tr>`;
      note?.classList.add('d-none');
      Repaint.nudgeTable('taxes-tbody');
      return;
    }

    tbody.innerHTML = gains.disposals.map((d, i) => {
      const manualTag = d.basis_source === 'manual' || d.basis_source === 'manual_deposit'
        ? '<span class="taxes-manual-tag" title="Cost basis you entered by hand">manual</span>' : '';
      const fixLabel = d.fix?.kind === 'price' ? 'Add price' : 'Fix';
      const fixBtn = d.fix
        ? `<button type="button" class="btn-secondary taxes-fix-btn" data-fix="${i}"
             title="${this.escapeAttr(this.fixTitle(d.fix))}">${fixLabel}</button>`
        : '';
      const pair = d.kind === 'fee'
        ? `<span class="taxes-pair">fee on ${this.escapeHtml(d.pair || '')}</span>`
        : (d.pair ? `<span class="taxes-pair">${this.escapeHtml(d.pair)}</span>` : '');
      const missingTitle = d.basis_source === 'no_history'
        ? 'Sold beyond the purchase history Cyrus has'
        : 'Arrived by deposit from outside your connected exchanges';
      const cost = d.cost_usd === null
        ? `<span class="taxes-missing" title="${this.escapeAttr(missingTitle)}">missing</span>`
        : this.escapeHtml(this.fmtUsd(d.cost_usd)) + manualTag;
      const gain = d.gain_usd === null
        ? '<span class="taxes-missing">—</span>'
        : `<span class="${this.pnlClass(d.gain_usd)}">${this.escapeHtml(this.fmtSigned(d.gain_usd))}</span>`;
      const proceeds = d.proceeds_usd === null
        ? '<span class="taxes-missing" title="This fill could not be valued in USD">unpriced</span>'
        : this.escapeHtml(this.fmtUsd(d.proceeds_usd));
      return `
        <tr>
          <td><span class="taxes-asset">${this.escapeHtml(d.asset)}</span>${pair}</td>
          <td class="taxes-num">${this.escapeHtml(this.fmtAmount(d.amount))}</td>
          <td>${d.acquired_at ? this.escapeHtml(this.fmtDate(d.acquired_at)) : '<span class="taxes-missing">unknown</span>'}</td>
          <td>${this.escapeHtml(this.fmtDate(d.sold_at))}</td>
          <td class="taxes-num">${proceeds}</td>
          <td class="taxes-num">${cost}</td>
          <td class="taxes-num">${gain}</td>
          <td><span class="taxes-term">${d.term ? (d.term === 'long' ? 'Long' : 'Short') : '—'}</span></td>
          <td>${this.escapeHtml(d.connection)}</td>
          <td class="taxes-fix-col">${fixBtn}</td>
        </tr>`;
    }).join('');
    Repaint.nudgeTable('taxes-tbody');

    if (note) {
      if (gains.disposals_total > gains.disposals.length) {
        note.textContent = `Showing the latest ${gains.disposals.length.toLocaleString()} of `
          + `${gains.disposals_total.toLocaleString()} sales. The Form 8949 export includes all of them.`;
        note.classList.remove('d-none');
      } else {
        note.classList.add('d-none');
      }
    }
  }

  private renderNeedsInfo(gains: TaxGains): void {
    const btn = document.getElementById('taxes-needs-info');
    const count = document.getElementById('taxes-needs-count');
    if (!btn) return;
    if (count) count.textContent = String(gains.needs_info);
    // Kept visible while the filter is on, even at zero, so it can be switched off.
    btn.classList.toggle('d-none', gains.needs_info === 0 && !this.needsInfoOnly);
    btn.classList.toggle('active', this.needsInfoOnly);
    btn.setAttribute('aria-pressed', String(this.needsInfoOnly));
  }

  // ---- resolving missing info ----

  private bindFixes(): void {
    document.getElementById('taxes-needs-info')?.addEventListener('click', () => {
      this.needsInfoOnly = !this.needsInfoOnly;
      void this.loadGains();
    });

    document.getElementById('taxes-tbody')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-fix]') as HTMLElement | null;
      if (!btn || !this.gains) return;
      const row = this.gains.disposals[Number(btn.getAttribute('data-fix'))];
      if (row?.fix) this.openFix(row.fix);
    });

    document.getElementById('taxes-add-lot')?.addEventListener('click', () => this.openFix({ kind: 'new' }));

    document.getElementById('taxes-manual')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-undo]') as HTMLElement | null;
      if (!btn) return;
      void this.undoManual(btn.getAttribute('data-undo') as 'lot' | 'deposit' | 'price',
        Number(btn.getAttribute('data-id')));
    });

    document.getElementById('taxes-fix-close')?.addEventListener('click', () => this.closeFix());
    document.getElementById('taxes-fix-cancel')?.addEventListener('click', () => this.closeFix());
    document.getElementById('taxes-fix-save')?.addEventListener('click', () => void this.saveFix());
    document.getElementById('taxes-fix-overlay')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'taxes-fix-overlay') this.closeFix();
    });
    document.getElementById('taxes-fix-form')?.addEventListener('input', () => this.updateFixPreview());
    document.addEventListener('keydown', this.onKeydown);
  }

  private onKeydown = (e: KeyboardEvent): void => {
    const open = !document.getElementById('taxes-fix-overlay')?.classList.contains('d-none');
    if (!open) return;
    if (e.key === 'Escape') this.closeFix();
    if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName === 'INPUT') {
      e.preventDefault();
      void this.saveFix();
    }
  };

  private fixTitle(fix: TaxFix): string {
    if (fix.kind === 'deposit') return 'Enter what you originally paid for these deposited coins';
    if (fix.kind === 'lot') return 'Add the purchase these coins came from';
    return `Enter the USD price of ${fix.quote} at the time of this trade`;
  }

  private connectionName(connId: number): string {
    const conn = this.status?.connections.find(c => c.connection_id === connId);
    return conn ? this.connName(conn) : 'this exchange';
  }

  /** `YYYY-MM-DD` for a date input, in UTC (dates everywhere here are UTC). */
  private isoDay(epochSec: number): string {
    return new Date(epochSec * 1000).toISOString().slice(0, 10);
  }

  /** A date input's value as epoch seconds at UTC midnight, or null. */
  private dayToEpoch(value: string): number | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    if (!m) return null;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000;
  }

  private field(id: string, label: string, input: string, hint = '', optional = false): string {
    return `
      <div class="form-group">
        <label for="${id}">${label}${optional ? '<span class="taxes-optional">optional</span>' : ''}</label>
        ${input}
        ${hint ? `<span class="form-hint">${hint}</span>` : ''}
      </div>`;
  }

  private openFix(fix: TaxFix | { kind: 'new' }): void {
    this.fixing = fix;
    const title = document.getElementById('taxes-fix-title');
    const subtitle = document.getElementById('taxes-fix-subtitle');
    const context = document.getElementById('taxes-fix-context');
    const form = document.getElementById('taxes-fix-form');
    if (!title || !subtitle || !context || !form) return;
    this.hideFixError();

    const today = this.isoDay(Math.floor(Date.now() / 1000));
    const note = this.field('fix-note', 'Note',
      '<input type="text" id="fix-note" maxlength="200" autocomplete="off" placeholder="e.g. Bought on Gemini, see statement">',
      '', true);
    const costInput = '<input type="number" id="fix-cost" min="0" step="any" inputmode="decimal" placeholder="0.00">';

    if (fix.kind === 'deposit') {
      title.textContent = 'What did these coins cost?';
      subtitle.textContent = 'Original cost of a deposit from outside your connected exchanges';
      context.innerHTML = `<strong>${this.escapeHtml(this.fmtAmount(fix.amount))} ${this.escapeHtml(fix.asset)}</strong> `
        + `arrived on ${this.escapeHtml(this.connectionName(fix.connection_id))} on `
        + `${this.escapeHtml(this.fmtDate(fix.occurred_at))}, from somewhere Cyrus can't see. `
        + `Enter what you originally paid for it and when you bought it. Every sale of these `
        + `coins will use this cost.`;
      form.innerHTML = `
        <div class="form-row">
          ${this.field('fix-cost', 'Total cost (USD)', costInput, 'Including any fees you paid to buy it')}
          ${this.field('fix-date', 'Purchase date',
            `<input type="date" id="fix-date" max="${this.isoDay(fix.occurred_at)}">`,
            'When you bought it, not when it arrived. This decides short- or long-term.')}
        </div>
        <p class="form-hint">If these coins came from several purchases, enter the total cost and
          the <em>most recent</em> purchase date. That's the cautious choice, since it never
          makes a holding look older than it is.</p>
        ${note}`;
    } else if (fix.kind === 'price') {
      const verb = fix.side === 'sell' ? 'sold' : 'bought';
      const total = fix.amount * fix.price;
      title.textContent = `What was ${fix.quote} worth?`;
      subtitle.textContent = 'USD price for a trade priced in another coin';
      context.innerHTML = `On ${this.escapeHtml(this.fmtDate(fix.occurred_at))}, `
        + `${this.escapeHtml(this.fmtAmount(fix.amount))} ${this.escapeHtml(fix.symbol.split('/')[0])} was ${verb} for `
        + `<strong>${this.escapeHtml(this.fmtAmount(total))} ${this.escapeHtml(fix.quote)}</strong>, `
        + `but Cyrus couldn't find a USD price for ${this.escapeHtml(fix.quote)} at that time. `
        + `Enter what one ${this.escapeHtml(fix.quote)} was worth in USD then. A daily close from `
        + `any price site is fine.`;
      form.innerHTML = this.field('fix-price', `USD price of 1 ${this.escapeHtml(fix.quote)}`,
        '<input type="number" id="fix-price" min="0" step="any" inputmode="decimal" placeholder="0.00">');
    } else {
      const lot = fix.kind === 'lot' ? fix : null;
      title.textContent = lot ? 'Add the missing purchase' : 'Add a purchase';
      subtitle.textContent = 'A purchase Cyrus has no record of';
      context.innerHTML = lot
        ? `Cyrus has no purchase record for <strong>${this.escapeHtml(this.fmtAmount(lot.amount))} `
          + `${this.escapeHtml(lot.asset)}</strong> sold on ${this.escapeHtml(this.connectionName(lot.connection_id))} `
          + `on ${this.escapeHtml(this.fmtDate(lot.before))}. Add the purchase those coins came from. `
          + `It only counts for coins held on that same exchange account.`
        : 'Record coins you bought that Cyrus never saw: before an exchange\'s history starts, '
          + 'on another platform and later moved in, or on a market Cyrus didn\'t check. '
          + 'It counts toward sales on the exchange you pick.';
      const conns = (this.status?.connections || [])
        .map(c => `<option value="${c.connection_id}"${lot && c.connection_id === lot.connection_id ? ' selected' : ''}>`
          + `${this.escapeHtml(this.connName(c))}</option>`).join('');
      const maxDay = lot ? this.isoDay(lot.before) : today;
      form.innerHTML = `
        <div class="form-row">
          ${this.field('fix-conn', 'Held on', `<select id="fix-conn">${conns}</select>`)}
          ${this.field('fix-asset', 'Coin',
            `<input type="text" id="fix-asset" maxlength="20" autocomplete="off" placeholder="e.g. BTC"
              value="${lot ? this.escapeAttr(lot.asset) : ''}">`)}
        </div>
        <div class="form-row">
          ${this.field('fix-amount', 'Amount',
            `<input type="number" id="fix-amount" min="0" step="any" inputmode="decimal"
              value="${lot ? this.escapeAttr(String(lot.amount)) : ''}">`)}
          ${this.field('fix-cost', 'Total cost (USD)', costInput, 'Including any fees you paid')}
        </div>
        ${this.field('fix-date', 'Purchase date', `<input type="date" id="fix-date" max="${maxDay}">`,
          lot ? 'On or before the sale' : '')}
        ${note}`;
    }

    this.updateFixPreview();
    document.getElementById('taxes-fix-overlay')?.classList.remove('d-none');
    // Focus the first field still to fill in (prefilled ones are skipped).
    const inputs = Array.from(form.querySelectorAll('input')) as HTMLInputElement[];
    (inputs.find(i => !i.value) || inputs[0])?.focus();
  }

  private closeFix(): void {
    if (this.saving) return;
    this.fixing = null;
    document.getElementById('taxes-fix-overlay')?.classList.add('d-none');
  }

  private val(id: string): string {
    return ((document.getElementById(id) as HTMLInputElement | null)?.value || '').trim();
  }

  /** Live "what this means" line under the form. */
  private updateFixPreview(): void {
    const el = document.getElementById('taxes-fix-preview');
    const fix = this.fixing;
    if (!el || !fix) return;
    let text = '';
    if (fix.kind === 'price') {
      const price = Number(this.val('fix-price'));
      if (price > 0) {
        const value = fix.amount * fix.price * price;
        text = `${fix.side === 'sell' ? 'Proceeds' : 'Cost'}: ${this.fmtUsd(value)}`;
      }
    } else {
      const cost = Number(this.val('fix-cost'));
      const amount = fix.kind === 'deposit' ? fix.amount : Number(this.val('fix-amount'));
      const asset = fix.kind === 'deposit' ? fix.asset : this.val('fix-asset').toUpperCase();
      if (this.val('fix-cost') !== '' && cost >= 0 && amount > 0) {
        text = `= ${this.fmtUsd(cost / amount)} per ${asset || 'coin'}`;
      }
    }
    el.textContent = text;
  }

  private async saveFix(): Promise<void> {
    const fix = this.fixing;
    if (!fix || this.saving) return;
    this.hideFixError();

    const cost = this.val('fix-cost');
    const date = this.dayToEpoch(this.val('fix-date'));
    const note = this.val('fix-note') || undefined;
    const fail = (msg: string) => { this.showFixError(msg); };

    let action: () => Promise<void>;
    let done: string;
    if (fix.kind === 'price') {
      const price = Number(this.val('fix-price'));
      if (!(price > 0)) return fail(`Enter the USD price of one ${fix.quote}.`);
      action = () => TaxController.setTradePrice(fix.trade_id, price);
      done = `Saved the ${fix.quote} price.`;
    } else {
      if (cost === '' || !(Number(cost) >= 0)) return fail('Enter the total cost in USD (0 is allowed, e.g. for a gift you paid nothing for).');
      if (date === null) return fail('Pick the purchase date.');
      if (fix.kind === 'deposit') {
        action = () => TaxController.setDepositCost(fix.transfer_id,
          { total_cost_usd: Number(cost), acquired_at: date, note });
        done = `Saved the cost of ${this.fmtAmount(fix.amount)} ${fix.asset}.`;
      } else {
        const asset = this.val('fix-asset').toUpperCase();
        const amount = Number(this.val('fix-amount'));
        const connId = Number(this.val('fix-conn'));
        if (!asset) return fail('Enter the coin, e.g. BTC.');
        if (!(amount > 0)) return fail('Enter how many coins you bought.');
        if (!connId) return fail('Pick the exchange the coins were held on.');
        action = async () => {
          await TaxController.addLot({ connection_id: connId, asset, amount,
            total_cost_usd: Number(cost), acquired_at: date, note });
        };
        done = `Added a purchase of ${this.fmtAmount(amount)} ${asset}.`;
      }
    }

    this.saving = true;
    const btn = document.getElementById('taxes-fix-save') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    try {
      await action();
      if (this.disposed) return;
      this.saving = false;
      this.closeFix();
      this.showSuccess(`${done} Gains have been recalculated.`);
      await Promise.all([this.loadGains(), this.loadManual()]);
    } catch (e: any) {
      if (!this.disposed) fail(e?.message || 'Could not save.');
    } finally {
      this.saving = false;
      if (btn) btn.disabled = false;
    }
  }

  private async loadManual(): Promise<void> {
    try {
      const manual = await TaxController.getManual();
      if (this.disposed) return;
      this.renderManual(manual);
    } catch {
      // Non-essential: the gains above already include whatever is saved.
      const host = document.getElementById('taxes-manual');
      if (host) host.innerHTML = '<div class="taxes-empty">Could not load the entries you made by hand.</div>';
    }
  }

  private renderManual(manual: ManualCostBasis): void {
    const host = document.getElementById('taxes-manual');
    const title = document.getElementById('taxes-manual-title');
    if (!host) return;
    const total = manual.lots.length + manual.deposits.length + manual.prices.length;
    if (title) title.textContent = total ? `Entered by hand (${total})` : 'Entered by hand';
    if (!total) {
      host.innerHTML = '<div class="taxes-empty">Nothing entered yet. Use <strong>Fix</strong> on a '
        + 'flagged sale, or add a purchase Cyrus has no record of.</div>';
      return;
    }

    const row = (kind: string, main: string, note: string | null, value: string,
                 undo: string, id: number, what: string) => `
      <div class="taxes-manual-row">
        <span class="taxes-manual-kind">${kind}</span>
        <span class="taxes-manual-main">${main}
          ${note ? `<span class="taxes-manual-note">${this.escapeHtml(note)}</span>` : ''}</span>
        <span class="taxes-manual-value">${this.escapeHtml(value)}</span>
        <button type="button" class="btn-icon" data-undo="${undo}" data-id="${id}"
                title="Remove ${this.escapeAttr(what)}" aria-label="Remove ${this.escapeAttr(what)}">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </div>`;

    host.innerHTML = [
      ...manual.lots.map(l => row('Purchase',
        `<strong>${this.escapeHtml(this.fmtAmount(l.amount))} ${this.escapeHtml(l.asset)}</strong> on `
        + `${this.escapeHtml(l.connection)}, bought ${this.escapeHtml(this.fmtDate(l.acquired_at))}`,
        l.note, this.fmtUsd(l.total_cost_usd), 'lot', l.id,
        `the purchase of ${this.fmtAmount(l.amount)} ${l.asset}`)),
      ...manual.deposits.map(d => row('Deposit cost',
        `<strong>${this.escapeHtml(this.fmtAmount(d.amount_num))} ${this.escapeHtml(d.asset)}</strong> deposited to `
        + `${this.escapeHtml(d.connection)} ${this.escapeHtml(this.fmtDate(d.occurred_at))}, bought `
        + `${this.escapeHtml(this.fmtDate(d.acquired_at))}`,
        d.note, this.fmtUsd(d.total_cost_usd), 'deposit', d.transfer_id,
        `the cost of the ${d.asset} deposit`)),
      ...manual.prices.map(p => row('USD price',
        `<strong>1 ${this.escapeHtml(p.quote)}</strong> on ${this.escapeHtml(this.fmtDate(p.occurred_at))} `
        + `(${this.escapeHtml(p.side)} ${this.escapeHtml(p.symbol)} on ${this.escapeHtml(p.connection)})`,
        null, this.fmtUsd(p.quote_usd_price), 'price', p.trade_id,
        `the ${p.quote} price`)),
    ].join('');
  }

  private async undoManual(kind: 'lot' | 'deposit' | 'price', id: number): Promise<void> {
    const label = kind === 'lot' ? 'this purchase' : kind === 'deposit' ? 'this deposit cost' : 'this price';
    if (!window.confirm(`Remove ${label}? The affected sales will show as missing information again.`)) return;
    this.hideError();
    this.hideSuccess();
    try {
      if (kind === 'lot') await TaxController.deleteLot(id);
      else if (kind === 'deposit') await TaxController.deleteDepositCost(id);
      else await TaxController.deleteTradePrice(id);
      if (this.disposed) return;
      this.showSuccess('Removed. Gains have been recalculated.');
      await Promise.all([this.loadGains(), this.loadManual()]);
    } catch (e: any) {
      if (!this.disposed) this.showError(e?.message || 'Could not remove it.');
    }
  }

  private showFixError(message: string): void {
    const el = document.getElementById('taxes-fix-error');
    if (!el) return;
    el.textContent = message;
    el.classList.remove('d-none');
  }

  private hideFixError(): void {
    document.getElementById('taxes-fix-error')?.classList.add('d-none');
  }

  // ---- status UI ----

  private setSyncBusy(busy: boolean): void {
    const btn = document.getElementById('taxes-sync-btn') as HTMLButtonElement | null;
    if (!btn) return;
    btn.disabled = busy;
    btn.querySelector('i')?.classList.toggle('fa-spin', busy);
  }

  private showProgress(label: string, count: string): void {
    const wrap = document.getElementById('taxes-progress');
    const labelEl = document.getElementById('taxes-progress-label');
    const countEl = document.getElementById('taxes-progress-count');
    if (labelEl) labelEl.textContent = label;
    if (countEl) countEl.textContent = count;
    wrap?.classList.remove('d-none');
  }

  private hideProgress(): void {
    document.getElementById('taxes-progress')?.classList.add('d-none');
  }

  private showError(message: string): void {
    const box = document.getElementById('taxes-error');
    const text = document.getElementById('taxes-error-message');
    if (text) text.textContent = message;
    box?.classList.remove('d-none');
  }

  private hideError(): void {
    document.getElementById('taxes-error')?.classList.add('d-none');
  }

  private showSuccess(message: string): void {
    const box = document.getElementById('taxes-success');
    const text = document.getElementById('taxes-success-message');
    if (text) text.textContent = message;
    box?.classList.remove('d-none');
  }

  private hideSuccess(): void {
    document.getElementById('taxes-success')?.classList.add('d-none');
  }

  // ---- formatting ----

  private static readonly USD = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
  });

  private fmtUsd(value: number): string {
    return TaxesController.USD.format(value || 0);
  }

  private fmtSigned(value: number): string {
    const v = value || 0;
    if (Math.abs(v) < 0.005) return TaxesController.USD.format(0);
    return (v > 0 ? '+' : '−') + TaxesController.USD.format(Math.abs(v));
  }

  private pnlClass(value: number | null): string {
    if (value === null || Math.abs(value) < 0.005) return '';
    return value > 0 ? 'pnl-positive' : 'pnl-negative';
  }

  private fmtAmount(value: number): string {
    return Number(value).toLocaleString('en-US', { maximumFractionDigits: 8 });
  }

  /** Dates in UTC, matching the export and the tax-year boundaries. */
  private fmtDate(epochSec: number): string {
    return new Date(epochSec * 1000).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
    });
  }

  private fmtAge(seconds: number): string {
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
    return `${Math.floor(seconds / 86400)} d ago`;
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  private escapeAttr(str: string): string {
    return this.escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
}

new TaxesController();

})();
