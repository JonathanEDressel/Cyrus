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

  constructor() {
    this.init();
  }

  private async init(): Promise<void> {
    this.bind();
    this.watchForTeardown();
    await this.loadConnections();
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

  private async load(): Promise<void> {
    try {
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
    } catch (e: any) {
      if (this.disposed) return;
      this.showError(e?.message || 'Could not load transfer history.');
      this.renderRows([]);
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
    for (const conn of status.connections) {
      const name = conn.label || conn.exchange;
      if (!conn.supported) {
        unsupported.push(name);
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
      unsupported.length
        ? `${unsupported.join(', ')} ${unsupported.length === 1 ? 'does' : 'do'} not offer a transfer-history API, so nothing from ${unsupported.length === 1 ? 'it' : 'them'} appears here.`
        : ''
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

  // ---- small DOM helpers ----

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
}

new TransfersController();

})();
