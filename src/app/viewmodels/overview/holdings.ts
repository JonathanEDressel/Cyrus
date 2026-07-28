(function () {

type SortKey = 'asset' | 'price' | 'change24' | 'change7d' | 'amount'
  | 'value' | 'weight' | 'marketCap' | 'fromAth';

/** How to read each sortable column off a position row. */
const SORT_VALUES: Record<SortKey, (p: any) => number | string | null> = {
  asset:     p => p.asset,
  price:     p => p.info?.price ?? p.unit_price ?? null,
  change24:  p => p.info?.change_24h_pct ?? null,
  change7d:  p => p.info?.change_7d_pct ?? null,
  amount:    p => p.amount ?? null,
  value:     p => p.usd_value ?? null,
  weight:    p => p.weight_percent ?? null,
  marketCap: p => p.info?.market_cap ?? null,
  fromAth:   p => p.info?.ath_change_pct ?? null,
};

class HoldingsController {
  private positions: any[] = [];
  private totalUsd = 0;
  private selected: string | null = null;
  private detailCache: Record<string, any> = {};
  private loading = false;
  private sortKey: SortKey = 'value';
  private sortDir: 'asc' | 'desc' = 'desc';

  constructor() {
    this.bind();
    this.initConnections();
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  private async initConnections(): Promise<void> {
    if (ExchangeStore.connections.length === 0) {
      try { await ExchangeStore.loadConnections(); } catch { /* handled by load() */ }
    }

    const select = document.getElementById('holdings-connection') as HTMLSelectElement | null;
    if (select) {
      const options = ['<option value="all">All exchanges</option>'].concat(
        ExchangeStore.connections.map(c =>
          `<option value="${c.id}">${this.esc(ExchangeStore.getExchangeName(c.id))}</option>`));
      select.innerHTML = options.join('');
      const active = ExchangeStore.activeMode;
      select.value = typeof active === 'number' ? String(active) : 'all';
    }

    this.load();
  }

  private bind(): void {
    document.getElementById('holdings-connection')?.addEventListener('change', () => {
      this.selected = null;
      this.load();
    });
    document.getElementById('holdings-refresh')?.addEventListener('click', () => this.load());
    document.getElementById('holdings-detail-close')?.addEventListener('click', () => this.closeDetail());

    document.getElementById('holdings-tbody')?.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest('[data-asset]') as HTMLElement | null;
      if (!row) return;
      this.openDetail(row.getAttribute('data-asset') || '');
    });

    // Rows are focusable, so they answer to the keyboard too.
    document.getElementById('holdings-tbody')?.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key !== 'Enter' && ke.key !== ' ') return;
      const row = (ke.target as HTMLElement).closest('[data-asset]') as HTMLElement | null;
      if (!row) return;
      ke.preventDefault();
      this.openDetail(row.getAttribute('data-asset') || '');
    });

    const thead = document.getElementById('holdings-thead');
    thead?.addEventListener('click', (e) => {
      const th = (e.target as HTMLElement).closest('[data-sort]') as HTMLElement | null;
      if (th) this.applySort(th.getAttribute('data-sort') as SortKey);
    });
    thead?.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key !== 'Enter' && ke.key !== ' ') return;
      const th = (ke.target as HTMLElement).closest('[data-sort]') as HTMLElement | null;
      if (!th) return;
      ke.preventDefault();
      this.applySort(th.getAttribute('data-sort') as SortKey);
    });
  }

  // -------------------------------------------------------------------------
  // Sorting
  // -------------------------------------------------------------------------

  private applySort(key: SortKey): void {
    if (!key || !SORT_VALUES[key]) return;
    if (this.sortKey === key) {
      this.sortDir = this.sortDir === 'desc' ? 'asc' : 'desc';
    } else {
      this.sortKey = key;
      // Names read naturally A→Z; everything else is most-interesting-first.
      this.sortDir = key === 'asset' ? 'asc' : 'desc';
    }
    this.renderTable();
  }

  private sortedPositions(): any[] {
    const read = SORT_VALUES[this.sortKey];
    const factor = this.sortDir === 'asc' ? 1 : -1;

    return this.positions.slice().sort((a, b) => {
      const av = read(a);
      const bv = read(b);
      // Assets without market data sink to the bottom either way, rather than
      // pretending to be worth zero.
      const aMissing = av == null || (typeof av === 'number' && !isFinite(av));
      const bMissing = bv == null || (typeof bv === 'number' && !isFinite(bv));
      if (aMissing && bMissing) return b.usd_value - a.usd_value;
      if (aMissing) return 1;
      if (bMissing) return -1;
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av).localeCompare(String(bv)) * factor;
      }
      return ((av as number) - (bv as number)) * factor;
    });
  }

  private renderSortIndicators(): void {
    document.querySelectorAll<HTMLElement>('#holdings-thead [data-sort]').forEach(th => {
      const key = th.getAttribute('data-sort');
      const active = key === this.sortKey;
      const arrow = th.querySelector('.holdings-arrow');
      th.classList.toggle('holdings-sorted', active);
      th.setAttribute('aria-sort', active
        ? (this.sortDir === 'asc' ? 'ascending' : 'descending')
        : 'none');
      if (arrow) arrow.textContent = active ? (this.sortDir === 'asc' ? '▲' : '▼') : '↕';
    });
  }

  private connId(): number | 'all' {
    const select = document.getElementById('holdings-connection') as HTMLSelectElement | null;
    const value = select?.value || 'all';
    return value === 'all' ? 'all' : parseInt(value, 10);
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.hideError();
    this.setTableMessage('Loading holdings…');

    try {
      const token = AuthController.getToken();
      if (!token) throw new Error('Not authenticated');

      const response = await MarketData.getHoldings(token, this.connId());
      const data = response.data || {};
      this.positions = data.positions || [];
      this.totalUsd = Number(data.total_usd || 0);
      this.detailCache = {};

      this.renderStaleNotice(data.market_data_live !== false, Number(data.market_data_stale_seconds || 0));
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        this.showError(`Some accounts couldn't be read — ${data.errors.join('; ')}`);
      }

      this.renderSummary();
      this.renderTable();
      if (this.selected) this.openDetail(this.selected);
    } catch (err: any) {
      this.positions = [];
      this.setTableMessage('Could not load holdings.');
      this.showError(err?.message || 'Failed to load holdings');
    } finally {
      this.loading = false;
    }
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  private renderSummary(): void {
    const host = document.getElementById('holdings-summary');
    if (!host) return;

    const priced = this.positions.filter(p => !p.is_cash);
    const cashValue = this.positions
      .filter(p => p.is_cash)
      .reduce((sum, p) => sum + Number(p.usd_value || 0), 0);

    const change24 = this.positions.reduce(
      (sum, p) => sum + (Number(p.value_change_24h_usd) || 0), 0);
    const priorValue = this.totalUsd - change24;
    const change24Pct = priorValue > 0 ? (change24 / priorValue) * 100 : 0;

    const withChange = priced.filter(p => p.info?.change_24h_pct != null);
    const best = withChange.slice().sort(
      (a, b) => b.info.change_24h_pct - a.info.change_24h_pct)[0];
    const worst = withChange.slice().sort(
      (a, b) => a.info.change_24h_pct - b.info.change_24h_pct)[0];
    const largest = this.positions[0];

    const cards = [
      {
        label: 'Total value',
        value: this.fmtUsd(this.totalUsd),
        sub: `${priced.length} coin${priced.length === 1 ? '' : 's'}`
          + (cashValue > 0 ? ` · ${this.fmtUsd(cashValue)} cash` : ''),
      },
      {
        label: '24h change',
        value: `${change24 >= 0 ? '+' : '−'}${this.fmtUsd(Math.abs(change24))}`,
        sub: `${this.fmtPct(change24Pct)} of portfolio value`,
        tone: this.tone(change24),
      },
      {
        label: 'Best today',
        value: best ? `${best.asset} ${this.fmtPct(best.info.change_24h_pct)}` : '—',
        sub: best ? this.fmtUsd(best.usd_value) + ' held' : 'No market data',
        tone: best ? this.tone(best.info.change_24h_pct) : undefined,
      },
      {
        label: 'Worst today',
        value: worst ? `${worst.asset} ${this.fmtPct(worst.info.change_24h_pct)}` : '—',
        sub: worst ? this.fmtUsd(worst.usd_value) + ' held' : 'No market data',
        tone: worst ? this.tone(worst.info.change_24h_pct) : undefined,
      },
      {
        label: 'Largest position',
        value: largest ? largest.asset : '—',
        sub: largest ? `${this.fmtPct(largest.weight_percent)} of portfolio` : '',
      },
    ];

    host.innerHTML = cards.map(c => `
      <div class="holdings-card">
        <span class="holdings-card-label">${this.esc(c.label)}</span>
        <span class="holdings-card-value ${c.tone || ''}">${this.esc(c.value)}</span>
        <span class="holdings-card-sub">${this.esc(c.sub || '')}</span>
      </div>`).join('');

    const title = document.getElementById('holdings-count-title');
    if (title) title.textContent = `Assets (${this.positions.length})`;
  }

  // -------------------------------------------------------------------------
  // Table
  // -------------------------------------------------------------------------

  private renderTable(): void {
    const tbody = document.getElementById('holdings-tbody');
    if (!tbody) return;

    this.renderSortIndicators();

    if (this.positions.length === 0) {
      this.setTableMessage('No holdings on this account.');
      return;
    }

    tbody.innerHTML = this.sortedPositions().map(p => {
      const info = p.info || {};
      const selected = this.selected === p.asset ? ' holdings-row-selected' : '';

      if (p.is_cash) {
        return `<tr class="holdings-row${selected}" data-asset="${this.escAttr(p.asset)}" tabindex="0">
          <td class="holdings-asset-cell"><span class="asset-badge">${this.esc(p.asset)}</span> <span class="holdings-cash-tag">cash</span></td>
          <td colspan="4" class="holdings-muted">Fiat balance — no market data</td>
          <td class="holdings-num">${this.fmtAmount(p.amount)}</td>
          <td class="holdings-num holdings-value">${this.fmtUsd(p.usd_value)}</td>
          <td class="holdings-num">${this.fmtPct(p.weight_percent)}</td>
          <td colspan="2" class="holdings-muted">—</td>
        </tr>`;
      }

      return `<tr class="holdings-row${selected}" data-asset="${this.escAttr(p.asset)}" tabindex="0">
        <td class="holdings-asset-cell">
          <span class="asset-badge">${this.esc(p.asset)}</span>
          <span class="holdings-name">${this.esc(info.name || '')}</span>
        </td>
        <td class="holdings-num">${this.fmtPrice(info.price ?? p.unit_price)}</td>
        <td class="holdings-num ${this.tone(info.change_24h_pct)}">${this.fmtPct(info.change_24h_pct)}</td>
        <td class="holdings-num ${this.tone(info.change_7d_pct)}">${this.fmtPct(info.change_7d_pct)}</td>
        <td class="holdings-spark">${this.sparkline(info.sparkline_7d, info.change_7d_pct)}</td>
        <td class="holdings-num">${this.fmtAmount(p.amount)}</td>
        <td class="holdings-num holdings-value">${this.fmtUsd(p.usd_value)}</td>
        <td class="holdings-num">${this.fmtPct(p.weight_percent)}</td>
        <td class="holdings-num">${this.fmtCompact(info.market_cap)}</td>
        <td class="holdings-num ${info.ath_change_pct != null ? 'holdings-neg' : ''}">${this.fmtPct(info.ath_change_pct)}</td>
      </tr>`;
    }).join('');

    Repaint.nudgeTable('holdings-tbody');
  }

  /** Inline 7-day sparkline — enough to see the shape of the week. */
  private sparkline(series: number[] | undefined, change: number | null | undefined): string {
    if (!Array.isArray(series) || series.length < 2) return '<span class="holdings-muted">—</span>';
    const W = 90, H = 26, PAD = 2;
    const min = Math.min(...series);
    const max = Math.max(...series);
    const span = max - min || 1;
    const points = series.map((v, i) => {
      const x = PAD + (i / (series.length - 1)) * (W - PAD * 2);
      const y = PAD + (1 - (v - min) / span) * (H - PAD * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const cls = (change ?? 0) >= 0 ? 'holdings-spark-up' : 'holdings-spark-down';
    return `<svg class="holdings-sparkline ${cls}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"
      role="img" aria-label="7 day price trend"><polyline points="${points}" fill="none"></polyline></svg>`;
  }

  // -------------------------------------------------------------------------
  // Detail panel
  // -------------------------------------------------------------------------

  private async openDetail(asset: string): Promise<void> {
    if (!asset) return;
    this.selected = asset;
    this.renderTable();

    const section = document.getElementById('holdings-detail-section');
    const title = document.getElementById('holdings-detail-title');
    const host = document.getElementById('holdings-detail');
    if (!section || !host) return;

    section.classList.remove('d-none');
    if (title) title.textContent = `${asset} detail`;
    host.innerHTML = '<p class="holdings-muted">Loading…</p>';
    section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    try {
      if (!this.detailCache[asset]) {
        const token = AuthController.getToken();
        if (!token) throw new Error('Not authenticated');
        const response = await MarketData.getAssetDetail(token, asset);
        this.detailCache[asset] = response.data;
      }
      // A slower request for an asset the user has since clicked away from must
      // not overwrite the panel they're looking at now.
      if (this.selected !== asset) return;
      this.renderDetail(asset, this.detailCache[asset]);
    } catch (err: any) {
      if (this.selected !== asset) return;
      host.innerHTML = `<p class="holdings-muted">${this.esc(err?.message || 'Could not load details.')}</p>`;
    }
  }

  private closeDetail(): void {
    this.selected = null;
    document.getElementById('holdings-detail-section')?.classList.add('d-none');
    this.renderTable();
  }

  private renderDetail(asset: string, detail: any): void {
    const host = document.getElementById('holdings-detail');
    if (!host) return;

    const position = this.positions.find(p => p.asset === asset);
    const info = detail?.info || null;
    const exchange = detail?.exchange || null;

    const blocks: string[] = [];

    // ── Your position ──────────────────────────────────────────────────────
    const venues = (position?.venues || []) as any[];
    blocks.push(this.detailBlock('Your position', [
      ['Amount held', position ? `${this.fmtAmount(position.amount)} ${asset}` : '—'],
      ['Value', position ? this.fmtUsd(position.usd_value) : '—'],
      ['Share of portfolio', position ? this.fmtPct(position.weight_percent) : '—'],
      ['24h move on this position', position?.value_change_24h_usd != null
        ? `${position.value_change_24h_usd >= 0 ? '+' : '−'}${this.fmtUsd(Math.abs(position.value_change_24h_usd))}`
        : '—'],
      ['Average unit price paid at market', position ? this.fmtPrice(position.unit_price) : '—'],
      ['Held on', venues.length > 0
        ? venues.map(v => `${this.esc(v.exchange_label)} (${this.fmtAmount(v.amount)})`).join(', ')
        : '—'],
    ]));

    if (detail?.is_cash) {
      blocks.push('<p class="holdings-muted">Fiat balance — no market fundamentals apply.</p>');
      host.innerHTML = blocks.join('');
      return;
    }

    if (info) {
      // ── Market size ──────────────────────────────────────────────────────
      blocks.push(this.detailBlock('Market size', [
        ['Market cap', this.fmtUsd(info.market_cap)],
        ['Rank', info.market_cap_rank ? `#${info.market_cap_rank}` : '—'],
        ['Fully diluted valuation', this.fmtUsd(info.fully_diluted_valuation)],
        ['24h volume', this.fmtUsd(info.total_volume)],
        ['Volume ÷ market cap', info.volume_to_cap_pct != null
          ? `${this.fmtPct(info.volume_to_cap_pct)} — ${this.liquidityWord(info.volume_to_cap_pct)}`
          : '—'],
      ]));

      // ── Supply ───────────────────────────────────────────────────────────
      const issued = info.supply_issued_pct;
      blocks.push(this.detailBlock('Supply', [
        ['Circulating', this.fmtAmount(info.circulating_supply, 0)],
        ['Total issued', this.fmtAmount(info.total_supply, 0)],
        ['Maximum ever', info.max_supply ? this.fmtAmount(info.max_supply, 0) : 'No hard cap'],
        ['Already in circulation', issued != null ? this.supplyBar(issued) : '—'],
        ['Your share of supply', position && info.circulating_supply
          ? this.fmtSmallPct((position.amount / info.circulating_supply) * 100)
          : '—'],
      ]));

      // ── Price history ────────────────────────────────────────────────────
      blocks.push(this.detailBlock('Price history', [
        ['Price now', this.fmtPrice(info.price)],
        ['24h range', info.low_24h != null && info.high_24h != null
          ? `${this.fmtPrice(info.low_24h)} – ${this.fmtPrice(info.high_24h)}` : '—'],
        ['All-time high', info.ath != null
          ? `${this.fmtPrice(info.ath)} <span class="holdings-muted">on ${this.fmtDate(info.ath_date)}</span>` : '—'],
        ['From all-time high', this.fmtPct(info.ath_change_pct)],
        ['Back to ATH needs', info.ath != null && info.price
          ? `+${this.fmtPct(((info.ath / info.price) - 1) * 100, false)}` : '—'],
        ['All-time low', info.atl != null
          ? `${this.fmtPrice(info.atl)} <span class="holdings-muted">on ${this.fmtDate(info.atl_date)}</span>` : '—'],
      ]));

      // ── Momentum ─────────────────────────────────────────────────────────
      blocks.push(this.detailBlock('Momentum', [
        ['1 hour', this.toned(info.change_1h_pct)],
        ['24 hours', this.toned(info.change_24h_pct)],
        ['7 days', this.toned(info.change_7d_pct)],
        ['30 days', this.toned(info.change_30d_pct)],
        ['Value of your position 30d ago', position && info.change_30d_pct != null
          ? this.fmtUsd(position.usd_value / (1 + info.change_30d_pct / 100)) : '—'],
      ]));
    } else if (detail?.unlisted) {
      blocks.push('<p class="holdings-muted">CoinGecko doesn\'t list this ticker, so market cap, '
        + 'supply and all-time-high figures aren\'t available for it.</p>');
    } else {
      blocks.push('<p class="holdings-muted">Market data is unavailable right now — showing '
        + 'exchange figures only.</p>');
    }

    // ── Trading on Kraken ──────────────────────────────────────────────────
    if (exchange?.available) {
      // detailBlock escapes titles and labels, so these are passed as raw text.
      blocks.push(this.detailBlock(`Exchange history (${exchange.pair})`, [
        [`Highest since ${exchange.since}`, this.fmtPrice(exchange.high)
          + ` <span class="holdings-muted">on ${this.esc(exchange.high_date)}</span>`],
        [`Lowest since ${exchange.since}`, this.fmtPrice(exchange.low)
          + ` <span class="holdings-muted">on ${this.esc(exchange.low_date)}</span>`],
        ['52-week range', exchange.low_52w != null && exchange.high_52w != null
          ? `${this.fmtPrice(exchange.low_52w)} – ${this.fmtPrice(exchange.high_52w)}` : '—'],
        ['Minimum order', exchange.min_order_amount
          ? `${this.fmtAmount(exchange.min_order_amount)} ${asset}` : '—'],
        ['Fees (maker / taker)', exchange.maker_fee != null && exchange.taker_fee != null
          ? `${(exchange.maker_fee * 100).toFixed(2)}% / ${(exchange.taker_fee * 100).toFixed(2)}%` : '—'],
      ], 'Kraken public data — the pair\'s history on that exchange, not the asset\'s.'));
    }

    host.innerHTML = `<div class="holdings-detail-grid">${blocks.join('')}</div>`;
  }

  private detailBlock(title: string, rows: Array<[string, string]>, note?: string): string {
    const body = rows.map(([label, value]) => `
      <div class="holdings-stat">
        <span class="holdings-stat-label">${this.esc(label)}</span>
        <span class="holdings-stat-value">${value}</span>
      </div>`).join('');
    return `<section class="holdings-detail-block">
      <h3 class="holdings-detail-heading">${this.esc(title)}</h3>
      ${body}
      ${note ? `<p class="holdings-block-note">${this.esc(note)}</p>` : ''}
    </section>`;
  }

  /** Bar showing how much of the eventual supply already exists. */
  private supplyBar(pct: number): string {
    const width = Math.max(0, Math.min(100, pct));
    return `<span class="holdings-supply">
      <span class="holdings-supply-track"><span class="holdings-supply-fill" style="width:${width.toFixed(1)}%"></span></span>
      <span>${this.fmtPct(pct)}</span>
    </span>`;
  }

  private liquidityWord(pct: number): string {
    if (pct >= 20) return 'very actively traded';
    if (pct >= 5) return 'healthy turnover';
    if (pct >= 1) return 'modest turnover';
    return 'thinly traded';
  }

  private toned(pct: number | null | undefined): string {
    return `<span class="${this.tone(pct)}">${this.fmtPct(pct)}</span>`;
  }

  private tone(value: number | null | undefined): string {
    if (value == null || isNaN(value as number)) return '';
    if (value > 0) return 'holdings-pos';
    if (value < 0) return 'holdings-neg';
    return '';
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  private renderStaleNotice(live: boolean, staleSeconds: number): void {
    const box = document.getElementById('holdings-stale');
    const msg = document.getElementById('holdings-stale-message');
    if (!box || !msg) return;

    if (live) {
      box.classList.add('d-none');
      return;
    }
    const age = staleSeconds > 0 ? ` Last updated ${this.fmtAge(staleSeconds)} ago.` : '';
    msg.textContent = 'Market data provider unreachable — showing the last figures Cyrus '
      + `cached.${age} Your balances and prices are live from the exchange.`;
    box.classList.remove('d-none');
  }

  private setTableMessage(text: string): void {
    const tbody = document.getElementById('holdings-tbody');
    if (tbody) tbody.innerHTML = `<tr class="empty-row"><td colspan="10">${this.esc(text)}</td></tr>`;
  }

  private showError(message: string): void {
    const box = document.getElementById('holdings-error');
    const msg = document.getElementById('holdings-error-message');
    if (box && msg) {
      msg.textContent = message;
      box.classList.remove('d-none');
    }
  }

  private hideError(): void {
    document.getElementById('holdings-error')?.classList.add('d-none');
  }

  // -------------------------------------------------------------------------
  // Formatting
  // -------------------------------------------------------------------------

  private fmtUsd(n: number | null | undefined): string {
    if (n == null || !isFinite(n)) return '—';
    if (Math.abs(n) >= 1_000_000) return this.fmtCompact(n);
    if (Math.abs(n) >= 1) return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }

  /** Large figures (market caps, supplies) read better abbreviated. */
  private fmtCompact(n: number | null | undefined): string {
    if (n == null || !isFinite(n)) return '—';
    const abs = Math.abs(n);
    if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
    if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }

  private fmtPrice(n: number | null | undefined): string {
    if (n == null || !isFinite(n)) return '—';
    if (n >= 1000) return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (n >= 1) return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (n >= 0.01) return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 4 });
    return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 8 });
  }

  private fmtAmount(n: number | null | undefined, maxDigits?: number): string {
    if (n == null || !isFinite(n)) return '—';
    if (maxDigits != null) return n.toLocaleString(undefined, { maximumFractionDigits: maxDigits });
    if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
    return n.toLocaleString(undefined, { maximumFractionDigits: 8 });
  }

  private fmtPct(n: number | null | undefined, signed = true): string {
    if (n == null || !isFinite(n)) return '—';
    const sign = signed && n > 0 ? '+' : '';
    return `${sign}${n.toFixed(2)}%`;
  }

  /** Tiny fractions ("your share of supply") need more decimals than 2. */
  private fmtSmallPct(n: number): string {
    if (!isFinite(n)) return '—';
    if (n >= 0.01) return `${n.toFixed(3)}%`;
    if (n >= 0.000001) return `${n.toFixed(7)}%`;
    return '< 0.000001%';
  }

  private fmtDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  private fmtAge(seconds: number): string {
    if (seconds < 90) return `${Math.round(seconds)}s`;
    if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
    if (seconds < 172800) return `${Math.round(seconds / 3600)} hours`;
    return `${Math.round(seconds / 86400)} days`;
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

new HoldingsController();

})();
