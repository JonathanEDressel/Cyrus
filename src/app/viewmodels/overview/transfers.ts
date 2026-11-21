(function () {

/** Rows per page. Transfer history can run to thousands over a full backfill. */
const PAGE_SIZE = 100;

/**
 * Safety net on the backfill loop. Each sync call is server-bounded to ~12s, so
 * this is roughly ten minutes of pulling — far more than any real history needs,
 * but finite, so a backend that never reports `complete` cannot spin forever.
 */
const MAX_SYNC_ROUNDS = 50;

class TransfersController {
  private connections: ExchangeConnection[] = [];
  private connId: number | 'all' = 'all';
  private kind: '' | 'deposit' | 'withdrawal' = '';
  private asset = '';
  private offset = 0;
  private total = 0;
  private syncing = false;
  /** Set when the page is torn down, so an in-flight backfill loop stops. */
  private disposed = false;

  /** Roadmap is the default: "where did my money go" is the question people open
   *  this page with. The table is the same data for when they want the detail. */
  private view: 'roadmap' | 'table' = 'roadmap';
  private flow: TransferFlow | null = null;
  private wallets: TrackedWallet[] = [];
  private suggestions: WalletSuggestion[] = [];
  private editingWalletId: number | null = null;
  private walletBusy = false;

  constructor() {
    this.init();
  }

  private async init(): Promise<void> {
    this.bind();
    this.watchForTeardown();
    this.applyView();
    try { HelpTooltip.init(); } catch { /* tooltips are decoration */ }
    await this.loadConnections();
    await this.loadWalletsQuiet();
    await this.load();

    // Anything never synced gets pulled on first visit, so the page is useful
    // without the user having to discover the refresh button.
    const status = await this.safeStatus();
    if (status && status.any_pending) {
      await this.runBackfill();
    }
  }

  /**
   * The router swaps #app-content wholesale on navigation. Watching for our own
   * table to disappear is how we know to stop a backfill loop that would
   * otherwise keep writing into a dead DOM.
   */
  private watchForTeardown(): void {
    const content = document.getElementById('app-content');
    if (!content) return;
    const observer = new MutationObserver(() => {
      if (!document.getElementById('transfers-table')) {
        this.disposed = true;
        observer.disconnect();
      }
    });
    observer.observe(content, { childList: true });
  }

  private bind(): void {
    const connSelect = document.getElementById('transfers-connection') as HTMLSelectElement | null;
    connSelect?.addEventListener('change', () => {
      const value = connSelect.value;
      this.connId = value === 'all' ? 'all' : Number(value);
      this.offset = 0;
      void this.load();
    });

    const kindSelect = document.getElementById('transfers-kind') as HTMLSelectElement | null;
    kindSelect?.addEventListener('change', () => {
      this.kind = kindSelect.value as '' | 'deposit' | 'withdrawal';
      this.offset = 0;
      void this.load();
    });

    const assetSelect = document.getElementById('transfers-asset') as HTMLSelectElement | null;
    assetSelect?.addEventListener('change', () => {
      this.asset = assetSelect.value;
      this.offset = 0;
      void this.load();
    });

    document.getElementById('transfers-refresh')?.addEventListener('click', () => {
      void this.runBackfill(true);
    });

    document.getElementById('transfers-view-tabs')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.rules-tab-btn') as HTMLElement | null;
      const next = btn?.getAttribute('data-view') as 'roadmap' | 'table' | null;
      if (!next || next === this.view) return;
      this.view = next;
      document.querySelectorAll('#transfers-view-tabs .rules-tab-btn')
        .forEach(b => b.classList.remove('active'));
      btn!.classList.add('active');
      this.applyView();
      void this.load();
    });

    document.getElementById('transfers-wallets-btn')
      ?.addEventListener('click', () => void this.openWallets());

    this.bindWallets();
    this.bindRoadmapActions();

    document.getElementById('transfers-prev')?.addEventListener('click', () => {
      if (this.offset <= 0) return;
      this.offset = Math.max(0, this.offset - PAGE_SIZE);
      void this.load();
    });

    document.getElementById('transfers-next')?.addEventListener('click', () => {
      if (this.offset + PAGE_SIZE >= this.total) return;
      this.offset += PAGE_SIZE;
      void this.load();
    });
  }

  private async loadConnections(): Promise<void> {
    try {
      this.connections = await ExchangeController.getConnections();
    } catch {
      this.connections = [];
      return;
    }
    const select = document.getElementById('transfers-connection') as HTMLSelectElement | null;
    if (!select) return;
    const options = ['<option value="all">All exchanges</option>'];
    for (const conn of this.connections) {
      options.push(
        `<option value="${conn.id}">${this.escapeHtml(conn.label || conn.exchange_name)}</option>`
      );
    }
    select.innerHTML = options.join('');
  }

  private async loadAssets(): Promise<void> {
    let assets: string[] = [];
    try {
      assets = await TransferController.getAssets();
    } catch {
      return;
    }
    const select = document.getElementById('transfers-asset') as HTMLSelectElement | null;
    if (!select) return;
    // Preserve the selection across a reload — the list grows as history syncs.
    const current = select.value;
    select.innerHTML = ['<option value="">All assets</option>']
      .concat(assets.map((a) => `<option value="${this.escapeHtml(a)}">${this.escapeHtml(a)}</option>`))
      .join('');
    if (current && assets.indexOf(current) !== -1) select.value = current;
  }

  /** Show the panel for the active view and hide the other. */
  private applyView(): void {
    const roadmap = this.view === 'roadmap';
    document.getElementById('transfers-roadmap-view')?.classList.toggle('d-none', !roadmap);
    document.getElementById('transfers-table-view')?.classList.toggle('d-none', roadmap);
    // Paging belongs to the table; the roadmap renders every hop.
    if (roadmap) document.getElementById('transfers-pager')?.classList.add('d-none');
  }

  private async load(): Promise<void> {
    try {
      // The table view is paged and filtered per-connection; the roadmap is
      // inherently cross-connection, since a hop's whole point is that it spans
      // two of them. So the connection filter only applies to the table.
      const page = await TransferController.getTransfers({
        connId: this.connId,
        kind: this.kind || undefined,
        asset: this.asset || undefined,
        limit: PAGE_SIZE,
        offset: this.offset,
      });
      if (this.disposed) return;

      this.total = page.total;
      this.hideError();
      this.renderRows(page.items);
      this.updateCountTitle(page.total);
      this.renderPager();
      this.renderStatusNotices(page.sync);
      this.setRefreshLabel(`Updated ${new Date().toLocaleTimeString()}`);
      await this.loadAssets();

      if (this.view === 'roadmap') await this.loadFlow();
    } catch (e: any) {
      if (this.disposed) return;
      this.showError(e?.message || 'Could not load transfer history.');
      this.renderRows([]);
    }
  }

  private async loadFlow(): Promise<void> {
    try {
      this.flow = await TransferController.getFlow(this.asset || undefined);
      if (this.disposed) return;
      this.renderRoadmap();
      this.renderMatchSummary();
    } catch (e: any) {
      if (this.disposed) return;
      this.showError(e?.message || 'Could not build the transfer roadmap.');
    }
  }

  /**
   * Drive the chunked sync to completion.
   *
   * Each POST does a bounded slice of work and reports whether more remains, so
   * "run the backfill" is a client-side loop rather than one long request. The
   * table is re-read between rounds so rows appear as they land instead of all
   * at the end.
   */
  private async runBackfill(force = false): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.setRefreshSpinning(true);

    try {
      for (let round = 0; round < MAX_SYNC_ROUNDS; round++) {
        if (this.disposed) return;

        const result = await TransferController.sync(this.connId);
        if (this.disposed) return;

        this.renderProgress(result.sync);
        this.renderStatusNotices(result.sync);

        if (result.already_running) {
          // Another request holds the lock. Its work still lands in the table,
          // so re-read and stop rather than fighting it for the same API key.
          break;
        }
        if (result.new_rows > 0) {
          await this.load();
          if (this.disposed) return;
        }
        if (result.complete) break;
      }
      await this.load();
    } catch (e: any) {
      if (!this.disposed) this.showError(e?.message || 'Sync failed.');
    } finally {
      this.syncing = false;
      this.setRefreshSpinning(false);
      this.hideProgress();
      if (force && !this.disposed) this.setRefreshLabel(`Synced ${new Date().toLocaleTimeString()}`);
    }
  }

  private async safeStatus(): Promise<TransferSyncStatus | null> {
    try {
      return await TransferController.getStatus();
    } catch {
      return null;
    }
  }

  // ---- rendering ----

  private renderRows(rows: TransferRow[]): void {
    const tbody = document.getElementById('transfers-tbody');
    if (!tbody) return;

    if (!rows.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No transfers found</td></tr>';
      Repaint.nudgeTable('transfers-tbody');
      return;
    }

    tbody.innerHTML = rows.map((row) => {
      const inbound = row.kind === 'deposit';
      const sign = inbound ? '+' : '−';
      const label = row.exchange_label || row.exchange_name;
      const internal = row.is_internal === 1
        ? ' <span class="transfers-tag" title="A move between your own accounts on this exchange">internal</span>'
        : '';
      return `
        <tr>
          <td><span class="exchange-badge">${this.escapeHtml(label)}</span></td>
          <td class="${inbound ? 'transfer-in' : 'transfer-out'}">
            <i class="fa-solid ${inbound ? 'fa-arrow-down' : 'fa-arrow-up'}"></i>
            ${inbound ? 'Deposit' : 'Withdrawal'}${internal}
          </td>
          <td><span class="transfers-asset">${this.escapeHtml(row.asset)}</span></td>
          <td class="holdings-num ${inbound ? 'transfer-in' : 'transfer-out'}">${sign}${this.escapeHtml(this.fmtAmount(row.amount))}</td>
          <td class="holdings-num holdings-muted">${this.fmtFee(row)}</td>
          <td>${this.statusBadge(row.status)}</td>
          <td>${this.escapeHtml(this.fmtTime(row.occurred_at))}</td>
          <td class="transfers-txid" title="${this.escapeHtml(row.txid || row.external_id || '')}">${this.fmtTxid(row)}</td>
        </tr>`;
    }).join('');

    // Electron on Windows leaves freshly-inserted rows unpainted until
    // something else forces a reflow.
    Repaint.nudgeTable('transfers-tbody');
  }

  // ---- roadmap ----

  private renderMatchSummary(): void {
    const el = document.getElementById('transfers-match-summary');
    if (!el || !this.flow) return;
    const c = this.flow.counts || {};
    const parts: string[] = [];
    if (c.internal) parts.push(`${c.internal} paired`);
    if (c.suggested) parts.push(`${c.suggested} to review`);
    if (c.unknown_counterparty) parts.push(`${c.unknown_counterparty} with an unknown end`);
    el.textContent = parts.length
      ? `${this.flow.hops.length} movements — ${parts.join(', ')}`
      : `${this.flow.hops.length} movements`;
  }

  /**
   * One block per movement, newest first, grouped under a date heading.
   *
   * A paired hop draws both ends and the fee the network took. An unpaired one
   * draws the end we know and states that the other is unknown — deliberately
   * not styled as an error, because for a genuine deposit from outside there is
   * nothing to fix.
   */
  private renderRoadmap(): void {
    const host = document.getElementById('transfers-roadmap');
    if (!host) return;

    const hops = this.flow?.hops || [];
    if (!hops.length) {
      host.innerHTML = `<p class="transfers-roadmap-empty">
        ${this.escapeHtml(this.total ? 'No movements match this filter.'
          : 'Nothing synced yet — use the refresh button to pull your transfer history.')}
      </p>`;
      return;
    }

    let lastDay = '';
    const blocks: string[] = [];
    for (const hop of hops) {
      const day = this.dayKey(hop.occurred_at);
      if (day !== lastDay) {
        lastDay = day;
        blocks.push(`<div class="roadmap-day">${this.escapeHtml(day)}</div>`);
      }
      blocks.push(this.hopHtml(hop));
    }
    host.innerHTML = blocks.join('');
    Repaint.nudge(host);
  }

  private hopHtml(hop: FlowHop): string {
    const paired = hop.kind === 'internal';
    const suggestion = hop.suggestion;

    const badge = paired
      ? `<span class="roadmap-badge roadmap-badge-paired" title="${this.escapeAttr(this.matchExplanation(hop))}">
           <i class="fa-solid fa-link"></i> ${this.escapeHtml(this.confidenceLabel(hop))}</span>`
      : suggestion
        ? `<span class="roadmap-badge roadmap-badge-review">
             <i class="fa-solid fa-question"></i> Possible match</span>`
        : hop.match_source === 'wallet'
          ? `<span class="roadmap-badge roadmap-badge-wallet"><i class="fa-solid fa-wallet"></i> Labelled</span>`
          : '';

    const fee = paired && hop.network_fee
      ? `<span class="roadmap-fee" title="Difference between what left and what arrived">
           −${this.escapeHtml(this.fmtAmount(String(hop.network_fee)))} ${this.escapeHtml(hop.asset)} fee</span>`
      : '';

    const arrived = paired && hop.arrived_at && hop.arrived_at !== hop.occurred_at
      ? `<span class="roadmap-arrived">arrived ${this.escapeHtml(this.gapLabel(hop.occurred_at, hop.arrived_at))} later</span>`
      : '';

    return `<div class="roadmap-hop roadmap-hop-${hop.kind}">
      <div class="roadmap-time">${this.escapeHtml(this.fmtTimeOnly(hop.occurred_at))}</div>
      <div class="roadmap-body">
        <div class="roadmap-route">
          ${this.endpointHtml(hop.from)}
          <span class="roadmap-arrow">
            <i class="fa-solid fa-arrow-right"></i>
            <span class="roadmap-amount">${this.escapeHtml(this.fmtAmount(hop.amount))} ${this.escapeHtml(hop.asset)}</span>
          </span>
          ${this.endpointHtml(hop.to)}
        </div>
        <div class="roadmap-meta">
          ${badge}${fee}${arrived}
          ${this.statusBadge(hop.status || 'ok')}
        </div>
        ${suggestion ? this.suggestionHtml(hop, suggestion) : ''}
      </div>
    </div>`;
  }

  private endpointHtml(end: FlowEndpoint): string {
    if (end.type === 'exchange') {
      return `<span class="roadmap-node roadmap-node-exchange">
        <i class="fa-solid fa-building-columns"></i> ${this.escapeHtml(end.label)}</span>`;
    }
    if (end.type === 'wallet') {
      const icon = end.is_own ? 'fa-wallet' : 'fa-user';
      return `<span class="roadmap-node roadmap-node-wallet${end.is_own ? '' : ' roadmap-node-external'}"
        title="${this.escapeAttr(end.address || '')}">
        <i class="fa-solid ${icon}"></i> ${this.escapeHtml(end.label)}</span>`;
    }
    // Unknown: offer the one action that resolves it, when there's an address
    // to label. Without an address there is nothing the user can do.
    const label = end.address
      ? `<button type="button" class="roadmap-node roadmap-node-unknown roadmap-label-btn"
           data-label-address="${this.escapeAttr(end.address)}"
           title="Click to give this address a name">
           <i class="fa-solid fa-circle-question"></i> ${this.escapeHtml(this.shortAddress(end.address))}
           <span class="roadmap-label-cta">name it</span></button>`
      : `<span class="roadmap-node roadmap-node-unknown">
           <i class="fa-solid fa-circle-question"></i> ${this.escapeHtml(end.label)}</span>`;
    return label;
  }

  private suggestionHtml(hop: FlowHop, s: FlowSuggestion): string {
    const pct = s.confidence != null ? `${Math.round(s.confidence * 100)}%` : '';
    return `<div class="roadmap-suggestion">
      <span class="roadmap-suggestion-text">
        Looks like the same movement as a ${this.escapeHtml(s.kind)} of
        <strong>${this.escapeHtml(this.fmtAmount(s.amount))} ${this.escapeHtml(s.asset)}</strong>
        on <strong>${this.escapeHtml(s.exchange)}</strong>
        ${pct ? `(${this.escapeHtml(pct)} confident)` : ''}.
      </span>
      <span class="roadmap-suggestion-actions">
        <button type="button" class="btn-primary limit-btn-sm"
                data-confirm-w="${s.withdrawal_id}" data-confirm-d="${s.deposit_id}">
          <i class="fa-solid fa-check"></i> Same
        </button>
        <button type="button" class="btn-secondary limit-btn-sm"
                data-reject-w="${s.withdrawal_id}" data-reject-d="${s.deposit_id}">
          Not the same
        </button>
      </span>
    </div>`;
  }

  private matchExplanation(hop: FlowHop): string {
    if (hop.match_source === 'txid') {
      return 'Both sides report the same on-chain transaction — this is certain.';
    }
    if (hop.match_source === 'user') return 'You confirmed this pairing.';
    if (hop.match_source === 'heuristic') {
      return 'Matched on amount and timing, allowing for the network fee. '
        + 'No other transfer was a plausible alternative.';
    }
    return '';
  }

  private confidenceLabel(hop: FlowHop): string {
    if (hop.match_source === 'txid') return 'Same transaction';
    if (hop.match_source === 'user') return 'Confirmed';
    if (hop.confidence != null) return `${Math.round(hop.confidence * 100)}% match`;
    return 'Paired';
  }

  private bindRoadmapActions(): void {
    document.getElementById('transfers-roadmap')?.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      const confirm = target.closest('[data-confirm-w]') as HTMLElement | null;
      if (confirm) {
        void this.resolveMatch(
          Number(confirm.getAttribute('data-confirm-w')),
          Number(confirm.getAttribute('data-confirm-d')), true);
        return;
      }
      const reject = target.closest('[data-reject-w]') as HTMLElement | null;
      if (reject) {
        void this.resolveMatch(
          Number(reject.getAttribute('data-reject-w')),
          Number(reject.getAttribute('data-reject-d')), false);
        return;
      }
      const label = target.closest('[data-label-address]') as HTMLElement | null;
      if (label) {
        void this.openWallets(label.getAttribute('data-label-address') || '');
      }
    });
  }

  private async resolveMatch(withdrawalId: number, depositId: number,
                             same: boolean): Promise<void> {
    try {
      if (same) await TransferController.confirmMatch(withdrawalId, depositId);
      else await TransferController.rejectMatch(withdrawalId, depositId);
      if (this.disposed) return;
      // Rejecting can promote a different candidate to unambiguous, so the
      // whole flow is re-derived rather than patched.
      if (!same) await TransferController.rematch();
      await this.loadFlow();
    } catch (e: any) {
      if (!this.disposed) this.showError(e?.message || 'Could not update that match.');
    }
  }

  private renderPager(): void {
    const pager = document.getElementById('transfers-pager');
    const label = document.getElementById('transfers-pager-label');
    if (!pager || !label) return;

    if (this.total <= PAGE_SIZE) {
      pager.classList.add('d-none');
      return;
    }
    pager.classList.remove('d-none');
    const first = this.offset + 1;
    const last = Math.min(this.offset + PAGE_SIZE, this.total);
    label.textContent = `${first}–${last} of ${this.total}`;

    (document.getElementById('transfers-prev') as HTMLButtonElement | null)
      ?.toggleAttribute('disabled', this.offset <= 0);
    (document.getElementById('transfers-next') as HTMLButtonElement | null)
      ?.toggleAttribute('disabled', last >= this.total);
  }

  private renderProgress(status: TransferSyncStatus | undefined): void {
    const box = document.getElementById('transfers-progress');
    const fill = document.getElementById('transfers-progress-fill');
    const pct = document.getElementById('transfers-progress-pct');
    const label = document.getElementById('transfers-progress-label');
    if (!box || !fill || !pct || !label || !status) return;

    const active = status.connections.flatMap((c) =>
      Object.values(c.kinds).filter((k) => k.state === 'backfilling' || k.state === 'not_started'));
    if (!active.length) {
      box.classList.add('d-none');
      return;
    }

    const average = Math.round(
      active.reduce((sum, k) => sum + (k.progress_pct || 0), 0) / active.length);
    box.classList.remove('d-none');
    fill.style.width = `${Math.max(2, average)}%`;
    pct.textContent = `${average}%`;
    label.textContent = 'Fetching history from your exchanges…';
  }

  private hideProgress(): void {
    document.getElementById('transfers-progress')?.classList.add('d-none');
  }

  /**
   * Surface the two states a user can actually act on: a key missing the
   * funding-history permission, and an exchange with no transfer API at all.
   * Without these, both render as an empty table and read as "Cyrus is broken".
   */
  private renderStatusNotices(status: TransferSyncStatus | undefined): void {
    if (!status) return;

    const blocked: string[] = [];
    const unsupported: string[] = [];
    // Exchanges that do have a transfer API, which Cyrus doesn't read yet.
    const notYet: string[] = [];
    const NOT_YET = ['kucoin'];
    for (const conn of status.connections) {
      const name = conn.label || conn.exchange;
      if (!conn.supported) {
        (NOT_YET.indexOf(conn.exchange) !== -1 ? notYet : unsupported).push(name);
        continue;
      }
      for (const kindStatus of Object.values(conn.kinds)) {
        if (kindStatus.state === 'disabled' && kindStatus.disabled_reason) {
          const message = `${name}: ${kindStatus.disabled_reason}`;
          if (blocked.indexOf(message) === -1) blocked.push(message);
        }
      }
    }

    this.toggleNotice('transfers-permission', 'transfers-permission-message', blocked.join(' '));
    this.toggleNotice(
      'transfers-unsupported', 'transfers-unsupported-message',
      [
        unsupported.length
          ? `${unsupported.join(', ')} ${unsupported.length === 1 ? 'does' : 'do'} not offer a transfer-history API, so nothing from ${unsupported.length === 1 ? 'it' : 'them'} appears here.`
          : '',
        notYet.length
          ? `Cyrus doesn't import transfer history from ${notYet.join(', ')} yet.`
          : '',
      ].filter(Boolean).join(' ')
    );
  }

  private toggleNotice(boxId: string, messageId: string, message: string): void {
    const box = document.getElementById(boxId);
    const target = document.getElementById(messageId);
    if (!box || !target) return;
    if (message) {
      target.textContent = message;
      box.classList.remove('d-none');
    } else {
      box.classList.add('d-none');
    }
  }

  private statusBadge(status: string | null): string {
    const value = (status || 'unknown').toLowerCase();
    const cls = value === 'ok' ? 'ok'
      : value === 'pending' ? 'pending'
      : (value === 'failed' || value === 'canceled') ? 'bad' : 'unknown';
    const text = value === 'ok' ? 'Complete' : value.charAt(0).toUpperCase() + value.slice(1);
    return `<span class="transfers-status transfers-status-${cls}">${this.escapeHtml(text)}</span>`;
  }

  private fmtTxid(row: TransferRow): string {
    const value = row.txid || row.external_id;
    if (!value) return '<span class="holdings-muted">—</span>';
    const short = value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
    return this.escapeHtml(short);
  }

  private fmtFee(row: TransferRow): string {
    if (!row.fee_amount || Number(row.fee_amount) === 0) return '—';
    const currency = row.fee_currency || row.asset;
    return this.escapeHtml(`${this.fmtAmount(row.fee_amount)} ${currency}`);
  }

  /**
   * Formats for reading while keeping the exact value. Amounts arrive as
   * decimal text and stay text — routing them through a float to format would
   * quietly lose precision on the small end.
   */
  private fmtAmount(value: string): string {
    const n = Number(value);
    if (!isFinite(n)) return value;
    if (n === 0) return '0';
    if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
    return n.toLocaleString(undefined, { maximumFractionDigits: 8 });
  }

  private fmtTime(epochSeconds: number): string {
    if (!epochSeconds) return 'Unknown';
    return new Date(epochSeconds * 1000).toLocaleString();
  }

  // ---- wallets ----

  private bindWallets(): void {
    document.getElementById('wallets-close')?.addEventListener('click', () => this.closeWallets());
    document.getElementById('wallets-done')?.addEventListener('click', () => this.closeWallets());
    document.getElementById('wallet-save')?.addEventListener('click', () => void this.saveWallet());
    document.getElementById('wallet-cancel-edit')?.addEventListener('click', () => this.resetWalletForm());

    document.getElementById('wallets-suggestions')?.addEventListener('click', (e) => {
      const chip = (e.target as HTMLElement).closest('[data-suggest]') as HTMLElement | null;
      if (!chip) return;
      this.fillWalletForm(chip.getAttribute('data-suggest') || '',
                          chip.getAttribute('data-suggest-chain') || '');
    });

    document.getElementById('wallet-template-btn')
      ?.addEventListener('click', () => void this.downloadTemplate(false));
    document.getElementById('wallet-export-btn')
      ?.addEventListener('click', () => void this.downloadTemplate(true));

    // The visible button drives a hidden <input type="file">, so the control
    // matches the rest of the app rather than the browser's default widget.
    const picker = document.getElementById('wallet-import-input') as HTMLInputElement | null;
    document.getElementById('wallet-import-btn')?.addEventListener('click', () => picker?.click());
    picker?.addEventListener('change', () => {
      const file = picker.files?.[0];
      // Reset immediately so picking the SAME file twice still fires a change
      // event — otherwise a failed import can't be retried without switching
      // files first.
      picker.value = '';
      if (file) void this.previewImport(file);
    });

    document.getElementById('wallet-import-cancel')
      ?.addEventListener('click', () => this.cancelImport());
    document.getElementById('wallet-import-confirm')
      ?.addEventListener('click', () => void this.commitImport());

    document.getElementById('wallets-list')?.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const edit = target.closest('[data-edit-wallet]') as HTMLElement | null;
      if (edit) { this.startEditWallet(Number(edit.getAttribute('data-edit-wallet'))); return; }
      const del = target.closest('[data-delete-wallet]') as HTMLElement | null;
      if (del) void this.deleteWallet(Number(del.getAttribute('data-delete-wallet')));
    });
  }

  private async openWallets(prefillAddress = ''): Promise<void> {
    document.getElementById('wallets-overlay')?.classList.remove('d-none');
    this.resetWalletForm();
    if (prefillAddress) this.fillWalletForm(prefillAddress, '');
    await this.loadWallets();
  }

  private closeWallets(): void {
    if (this.walletBusy) return;
    document.getElementById('wallets-overlay')?.classList.add('d-none');
    this.resetWalletForm();
  }

  /** Wallet count for the toolbar button, without opening the dialog. */
  private async loadWalletsQuiet(): Promise<void> {
    try {
      this.wallets = await WalletController.getWallets();
      if (!this.disposed) this.renderWalletCount();
    } catch {
      /* the button just shows no count */
    }
  }

  private async loadWallets(): Promise<void> {
    try {
      const [wallets, suggestions] = await Promise.all([
        WalletController.getWallets(),
        WalletController.getSuggestions(),
      ]);
      if (this.disposed) return;
      this.wallets = wallets;
      this.suggestions = suggestions;
      this.renderWallets();
      this.renderSuggestions();
      this.renderWalletCount();
    } catch (e: any) {
      if (!this.disposed) this.showWalletError(e?.message || 'Could not load wallets.');
    }
  }

  private renderWalletCount(): void {
    const el = document.getElementById('transfers-wallets-count');
    if (el) el.textContent = this.wallets.length ? `(${this.wallets.length})` : '';
  }

  private renderWallets(): void {
    const host = document.getElementById('wallets-list');
    if (!host) return;
    if (!this.wallets.length) {
      host.innerHTML = '<p class="wallets-empty">No wallets saved yet.</p>';
      return;
    }
    host.innerHTML = this.wallets.map((w) => `
      <div class="wallet-row">
        <div class="wallet-row-main">
          <span class="wallet-row-label">
            <i class="fa-solid ${w.is_own ? 'fa-wallet' : 'fa-user'}"></i>
            ${this.escapeHtml(w.label)}
            ${w.is_own ? '' : '<span class="wallet-tag">not mine</span>'}
          </span>
          <span class="wallet-row-address" title="${this.escapeAttr(w.address)}">${this.escapeHtml(w.address)}</span>
        </div>
        <div class="wallet-row-side">
          <span class="wallet-row-count">${w.transfer_count} transfer${w.transfer_count === 1 ? '' : 's'}</span>
          ${w.chain ? `<span class="wallet-row-chain">${this.escapeHtml(w.chain)}</span>` : ''}
          <button type="button" class="btn-icon" data-edit-wallet="${w.id}" title="Edit">
            <i class="fa-solid fa-pen"></i></button>
          <button type="button" class="btn-icon" data-delete-wallet="${w.id}" title="Remove">
            <i class="fa-solid fa-trash"></i></button>
        </div>
      </div>`).join('');
  }

  private renderSuggestions(): void {
    const block = document.getElementById('wallets-suggestions-block');
    const host = document.getElementById('wallets-suggestions');
    if (!block || !host) return;
    block.classList.toggle('d-none', this.suggestions.length === 0);
    if (!this.suggestions.length) return;

    host.innerHTML = this.suggestions.map((s) => {
      const direction = s.withdrawals && s.deposits ? 'both ways'
        : s.withdrawals ? `${s.withdrawals} sent` : `${s.deposits} received`;
      return `<button type="button" class="wallet-suggestion"
        data-suggest="${this.escapeAttr(s.address)}"
        data-suggest-chain="${this.escapeAttr(s.network || '')}">
        <span class="wallet-suggestion-addr">${this.escapeHtml(this.shortAddress(s.address))}</span>
        <span class="wallet-suggestion-meta">
          ${this.escapeHtml(s.assets.join(', ') || '—')} · ${this.escapeHtml(direction)}
        </span>
      </button>`;
    }).join('');
  }

  private fillWalletForm(address: string, chain: string): void {
    const addr = document.getElementById('wallet-address') as HTMLInputElement | null;
    const ch = document.getElementById('wallet-chain') as HTMLInputElement | null;
    if (addr) addr.value = address;
    if (ch && chain && !ch.value) ch.value = chain;
    (document.getElementById('wallet-label') as HTMLInputElement | null)?.focus();
  }

  private startEditWallet(id: number): void {
    const wallet = this.wallets.find(w => w.id === id);
    if (!wallet) return;
    this.editingWalletId = id;
    (document.getElementById('wallet-label') as HTMLInputElement).value = wallet.label;
    (document.getElementById('wallet-address') as HTMLInputElement).value = wallet.address;
    (document.getElementById('wallet-chain') as HTMLInputElement).value = wallet.chain || '';
    (document.getElementById('wallet-tag') as HTMLInputElement).value = wallet.tag || '';
    (document.getElementById('wallet-asset') as HTMLInputElement).value = wallet.asset || '';
    (document.getElementById('wallet-notes') as HTMLInputElement).value = wallet.notes || '';
    (document.getElementById('wallet-is-own') as HTMLInputElement).checked = wallet.is_own;
    const label = document.getElementById('wallet-save-label');
    if (label) label.textContent = 'Save changes';
    document.getElementById('wallet-cancel-edit')?.classList.remove('d-none');
  }

  private resetWalletForm(): void {
    this.editingWalletId = null;
    (document.getElementById('wallet-label') as HTMLInputElement | null)?.setAttribute('value', '');
    for (const id of ['wallet-label', 'wallet-address', 'wallet-chain',
                      'wallet-tag', 'wallet-asset', 'wallet-notes']) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.value = '';
    }
    const own = document.getElementById('wallet-is-own') as HTMLInputElement | null;
    if (own) own.checked = true;
    const label = document.getElementById('wallet-save-label');
    if (label) label.textContent = 'Add wallet';
    document.getElementById('wallet-cancel-edit')?.classList.add('d-none');
    this.hideWalletMessages();
  }

  private async saveWallet(): Promise<void> {
    if (this.walletBusy) return;
    const label = (document.getElementById('wallet-label') as HTMLInputElement | null)?.value || '';
    const address = (document.getElementById('wallet-address') as HTMLInputElement | null)?.value || '';
    const chain = (document.getElementById('wallet-chain') as HTMLInputElement | null)?.value || '';
    const tag = (document.getElementById('wallet-tag') as HTMLInputElement | null)?.value || '';
    const asset = (document.getElementById('wallet-asset') as HTMLInputElement | null)?.value || '';
    const notes = (document.getElementById('wallet-notes') as HTMLInputElement | null)?.value || '';
    const isOwn = (document.getElementById('wallet-is-own') as HTMLInputElement | null)?.checked ?? true;

    if (!label.trim()) { this.showWalletError('Give the wallet a label you will recognise.'); return; }
    if (!address.trim()) { this.showWalletError('Paste the wallet address.'); return; }

    this.walletBusy = true;
    this.hideWalletMessages();
    try {
      const body: WalletInput = { label, address, chain: chain || null,
                                  tag: tag || null, asset: asset || null,
                                  notes: notes || null, is_own: isOwn };
      const result = this.editingWalletId
        ? await WalletController.updateWallet(this.editingWalletId, body)
        : await WalletController.createWallet(body);
      if (this.disposed) return;

      const attributed = result.match?.wallet_resolved ?? 0;
      this.showWalletSuccess(attributed
        ? `Saved. ${attributed} transfer${attributed === 1 ? '' : 's'} now attributed.`
        : 'Saved. No transfers match this address yet.');
      this.resetWalletForm();
      await this.loadWallets();
      // The roadmap is what the wallet was added for — refresh it behind the dialog.
      await this.loadFlow();
    } catch (e: any) {
      if (!this.disposed) this.showWalletError(e?.message || 'Could not save that wallet.');
    } finally {
      this.walletBusy = false;
    }
  }

  private async deleteWallet(id: number): Promise<void> {
    const wallet = this.wallets.find(w => w.id === id);
    if (!wallet || this.walletBusy) return;
    // Deleting un-names every transfer it explained, so say how many before doing it.
    const warning = wallet.transfer_count
      ? `Remove "${wallet.label}"? ${wallet.transfer_count} transfer`
        + `${wallet.transfer_count === 1 ? '' : 's'} will go back to showing an unknown address.`
      : `Remove "${wallet.label}"?`;
    if (!window.confirm(warning)) return;

    this.walletBusy = true;
    try {
      await WalletController.deleteWallet(id);
      if (this.disposed) return;
      await this.loadWallets();
      await this.loadFlow();
    } catch (e: any) {
      if (!this.disposed) this.showWalletError(e?.message || 'Could not remove that wallet.');
    } finally {
      this.walletBusy = false;
    }
  }

  // ---- template download / bulk import ----

  /** Pending parsed file, held between the preview and the confirm. */
  private importPending: { filename: string; base64: string; count: number } | null = null;

  private async downloadTemplate(includeExisting: boolean): Promise<void> {
    const bridge = (window as any).cyrus;
    this.hideWalletMessages();
    try {
      const template = await WalletController.getTemplate(includeExisting);
      if (this.disposed) return;

      if (includeExisting && template.exported === 0) {
        this.showWalletError('There are no saved wallets to export yet.');
        return;
      }

      // Outside Electron (or on an older build without the bridge) fall back to
      // a browser download rather than refusing — the file is the point.
      if (typeof bridge?.saveFile !== 'function') {
        this.browserDownload(template.filename, template.content_base64);
        this.showWalletSuccess(`${template.filename} downloaded.`);
        return;
      }

      const result = await bridge.saveFile({
        defaultName: template.filename,
        base64: template.content_base64,
        filterName: 'Excel workbook',
        extensions: ['xlsx'],
      });
      if (this.disposed) return;
      if (result?.canceled) return;
      if (!result?.saved) {
        this.showWalletError(result?.error || 'Could not save the template.');
        return;
      }
      this.showWalletSuccess(includeExisting
        ? `Exported ${template.exported} wallet${template.exported === 1 ? '' : 's'}. Edit it and import it back.`
        : 'Template saved. Fill in one row per wallet, then import it.');
      if (typeof bridge?.showItemInFolder === 'function' && result.path) {
        bridge.showItemInFolder(result.path);
      }
    } catch (e: any) {
      if (!this.disposed) this.showWalletError(e?.message || 'Could not build the template.');
    }
  }

  /** Anchor-and-blob download, for when the Electron bridge isn't there. */
  private browserDownload(filename: string, base64: string): void {
    const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    // Revoked on a timer rather than immediately: Chromium needs the URL to
    // still resolve when it starts the download, which is after this returns.
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  private async fileToBase64(file: File): Promise<string> {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    // Chunked: String.fromCharCode(...bytes) on a large array blows the
    // argument limit and throws a RangeError.
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
    }
    return btoa(binary);
  }

  private async previewImport(file: File): Promise<void> {
    this.hideWalletMessages();
    this.setImportStatus(`Reading ${file.name}…`);
    try {
      const base64 = await this.fileToBase64(file);
      const result = await WalletController.importFile(file.name, base64, true);
      if (this.disposed) return;
      this.importPending = { filename: file.name, base64,
                             count: result.would_create.length };
      this.renderImportPreview(result);
    } catch (e: any) {
      if (this.disposed) return;
      this.cancelImport();
      this.showWalletError(e?.message || 'That file could not be read.');
    }
  }

  private async commitImport(): Promise<void> {
    if (!this.importPending || this.walletBusy) return;
    this.walletBusy = true;
    const button = document.getElementById('wallet-import-confirm') as HTMLButtonElement | null;
    if (button) button.disabled = true;
    try {
      const { filename, base64 } = this.importPending;
      const result = await WalletController.importFile(filename, base64, false);
      if (this.disposed) return;
      this.cancelImport();
      const attributed = result.match?.wallet_resolved ?? 0;
      this.showWalletSuccess(
        `Imported ${result.created} wallet${result.created === 1 ? '' : 's'}.`
        + (attributed ? ` ${attributed} transfer${attributed === 1 ? '' : 's'} now attributed.` : ''));
      await this.loadWallets();
      await this.loadFlow();
    } catch (e: any) {
      if (!this.disposed) this.showWalletError(e?.message || 'The import failed.');
    } finally {
      this.walletBusy = false;
      if (button) button.disabled = false;
    }
  }

  private cancelImport(): void {
    this.importPending = null;
    document.getElementById('wallet-import-preview')?.classList.add('d-none');
    this.setImportStatus('');
  }

  private setImportStatus(text: string): void {
    const el = document.getElementById('wallet-import-status');
    if (!el) return;
    if (text) {
      el.textContent = text;
    } else {
      el.textContent = 'Download the template, fill in one row per wallet, then import it '
        + "back. Column order doesn't matter and re-importing the same file is safe.";
    }
  }

  /**
   * Show what the import would do, before it does it.
   *
   * Everything is reported, not just the failures: a run where six of forty rows
   * were malformed needs to say which six and why, with the spreadsheet row
   * number so the user can go and look at it.
   */
  private renderImportPreview(result: WalletImportResult): void {
    const box = document.getElementById('wallet-import-preview');
    const summary = document.getElementById('wallet-preview-summary');
    const lists = document.getElementById('wallet-preview-lists');
    const confirm = document.getElementById('wallet-import-confirm') as HTMLButtonElement | null;
    const confirmLabel = document.getElementById('wallet-import-confirm-label');
    if (!box || !summary || !lists) return;

    const newCount = result.would_create.length;
    const chips: string[] = [];
    if (newCount) chips.push(`<span class="preview-chip preview-chip-new">${newCount} new</span>`);
    if (result.duplicates.length) {
      chips.push(`<span class="preview-chip preview-chip-dupe">${result.duplicates.length} already saved</span>`);
    }
    if (result.errors.length) {
      chips.push(`<span class="preview-chip preview-chip-error">${result.errors.length} problem${result.errors.length === 1 ? '' : 's'}</span>`);
    }
    if (result.warnings.length) {
      chips.push(`<span class="preview-chip preview-chip-warn">${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}</span>`);
    }
    summary.innerHTML = chips.join('') || '<span class="preview-chip">Nothing to import</span>';

    const sections: string[] = [];

    if (newCount) {
      sections.push(`<div class="preview-section">
        <h5>Will be added</h5>
        <ul>${result.would_create.slice(0, 12).map(w => `<li>
          <span class="preview-row">row ${w.row}</span>
          <strong>${this.escapeHtml(w.label)}</strong>
          <span class="preview-addr">${this.escapeHtml(this.shortAddress(w.address))}</span>
          ${w.is_own ? '' : '<span class="wallet-tag">not mine</span>'}
        </li>`).join('')}
        ${newCount > 12 ? `<li class="preview-more">…and ${newCount - 12} more</li>` : ''}</ul>
      </div>`);
    }

    if (result.errors.length) {
      sections.push(`<div class="preview-section preview-section-error">
        <h5>Skipped</h5>
        <ul>${result.errors.map(e => `<li>
          ${e.row ? `<span class="preview-row">row ${e.row}</span>` : ''}
          ${this.escapeHtml(e.message)}</li>`).join('')}</ul>
      </div>`);
    }

    if (result.warnings.length) {
      sections.push(`<div class="preview-section preview-section-warn">
        <h5>Worth checking</h5>
        <ul>${result.warnings.map(w => `<li>
          ${w.row ? `<span class="preview-row">row ${w.row}</span>` : ''}
          ${this.escapeHtml(w.message)}</li>`).join('')}</ul>
      </div>`);
    }

    if (result.duplicates.length) {
      sections.push(`<div class="preview-section">
        <h5>Already saved — will be skipped</h5>
        <ul>${result.duplicates.slice(0, 8).map(d => `<li>
          <span class="preview-row">row ${d.row}</span>
          ${this.escapeHtml(d.label)} is already saved as
          <strong>${this.escapeHtml(d.existing_label)}</strong></li>`).join('')}
        ${result.duplicates.length > 8 ? `<li class="preview-more">…and ${result.duplicates.length - 8} more</li>` : ''}</ul>
      </div>`);
    }

    if (result.unknown_columns.length) {
      sections.push(`<div class="preview-section">
        <h5>Columns ignored</h5>
        <ul><li>${result.unknown_columns.map(c => this.escapeHtml(c)).join(', ')}
          — not recognised, so they were left out.</li></ul>
      </div>`);
    }

    lists.innerHTML = sections.join('');
    box.classList.remove('d-none');
    this.setImportStatus(`${this.importPending?.filename || 'File'} — review below.`);

    if (confirm) confirm.disabled = newCount === 0;
    if (confirmLabel) {
      confirmLabel.textContent = newCount
        ? `Import ${newCount} wallet${newCount === 1 ? '' : 's'}`
        : 'Nothing to import';
    }
  }

  private showWalletError(message: string): void {
    const el = document.getElementById('wallets-error');
    if (!el) return;
    el.textContent = message;
    el.classList.remove('d-none');
    document.getElementById('wallets-success')?.classList.add('d-none');
  }

  private showWalletSuccess(message: string): void {
    const el = document.getElementById('wallets-success');
    if (!el) return;
    el.textContent = message;
    el.classList.remove('d-none');
    document.getElementById('wallets-error')?.classList.add('d-none');
  }

  private hideWalletMessages(): void {
    document.getElementById('wallets-error')?.classList.add('d-none');
    document.getElementById('wallets-success')?.classList.add('d-none');
  }

  // ---- small DOM helpers ----

  private shortAddress(address: string): string {
    if (!address) return 'unknown';
    return address.length > 22 ? `${address.slice(0, 10)}…${address.slice(-8)}` : address;
  }

  private dayKey(epochSeconds: number): string {
    if (!epochSeconds) return 'Undated';
    const d = new Date(epochSeconds * 1000);
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86400000);
    const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
    if (same(d, today)) return 'Today';
    if (same(d, yesterday)) return 'Yesterday';
    return d.toLocaleDateString(undefined, {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  }

  private fmtTimeOnly(epochSeconds: number): string {
    if (!epochSeconds) return '—';
    return new Date(epochSeconds * 1000)
      .toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  private gapLabel(from: number, to: number): string {
    const seconds = Math.max(0, (to || 0) - (from || 0));
    if (seconds < 90) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 36) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
  }

  private updateCountTitle(count: number): void {
    const title = document.getElementById('transfers-count-title');
    if (title) title.textContent = count ? `History (${count})` : 'History';
  }

  private setRefreshLabel(text: string): void {
    const label = document.getElementById('transfers-refresh-label');
    if (label) label.textContent = text;
  }

  private setRefreshSpinning(spinning: boolean): void {
    const button = document.getElementById('transfers-refresh') as HTMLButtonElement | null;
    if (!button) return;
    button.toggleAttribute('disabled', spinning);
    button.querySelector('i')?.classList.toggle('fa-spin', spinning);
  }

  private showError(message: string): void {
    const box = document.getElementById('transfers-error');
    const target = document.getElementById('transfers-error-message');
    if (box && target) {
      target.textContent = message;
      box.classList.remove('d-none');
    }
  }

  private hideError(): void {
    document.getElementById('transfers-error')?.classList.add('d-none');
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  /**
   * Escape for use inside a double-quoted attribute.
   *
   * Not the same job as escapeHtml: textContent/innerHTML leaves quotes alone,
   * because inside element text they are harmless. In an attribute a quote ends
   * the value early, so anything exchange-supplied — an address, a wallet label,
   * an error string — has to have them encoded too.
   */
  private escapeAttr(str: string): string {
    return this.escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
}

new TransfersController();

})();
