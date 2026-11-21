/**
 * The Terminal design's top bar: the holdings price ticker, the automation
 * worker pill and the page search ("/" focuses it). Ctrl K (⌘K on macOS) stays the
 * assistant's shortcut, handled in aiassistant.ts.
 *
 * Loaded once from index.html after router.js. Nothing here fetches unless the
 * app chrome is showing and someone is signed in, so the login screens stay
 * quiet. The router calls onChromeShown() whenever a page with chrome opens.
 */

interface TopBarPage {
  route: string;
  label: string;
  icon: string;
  group: string;
  /** Extra words the search matches on. */
  keywords: string;
}

class TopBar {
  /** Every destination the search can jump to, in rail order. */
  private static readonly PAGES: TopBarPage[] = [
    { route: 'home', label: 'Overview', icon: 'fa-table-cells-large', group: 'Portfolio', keywords: 'home dashboard portfolio' },
    { route: 'holdings', label: 'Holdings', icon: 'fa-coins', group: 'Portfolio', keywords: 'assets balances coins' },
    { route: 'openorders', label: 'Open Orders', icon: 'fa-clock', group: 'Portfolio', keywords: 'orders active' },
    { route: 'limitorders', label: 'Limit Orders', icon: 'fa-arrow-right-arrow-left', group: 'Portfolio', keywords: 'ladder staggered buy sell resting' },
    { route: 'transfers', label: 'Transfers', icon: 'fa-right-left', group: 'Portfolio', keywords: 'deposits withdrawals wallets' },
    { route: 'taxes', label: 'Taxes', icon: 'fa-receipt', group: 'Portfolio', keywords: 'gains cost basis 8949 koinly' },
    { route: 'commands', label: 'Automations', icon: 'fa-bolt', group: 'Automation', keywords: 'rules triggers worker log' },
    { route: 'rebalancer', label: 'Balancer', icon: 'fa-scale-balanced', group: 'Automation', keywords: 'rebalance caps allocation' },
    { route: 'profile', label: 'Profile', icon: 'fa-user', group: 'Account', keywords: 'settings api keys exchanges email notifications password theme' },
    { route: 'affiliates', label: 'Partners', icon: 'fa-shield-halved', group: 'Account', keywords: 'affiliates' },
    { route: 'about', label: 'About', icon: 'fa-circle-info', group: 'Account', keywords: 'mission' },
    { route: 'privacy', label: 'Privacy', icon: 'fa-user-secret', group: 'Legal', keywords: 'policy data' },
    { route: 'terms', label: 'Terms', icon: 'fa-file-contract', group: 'Legal', keywords: 'license' },
  ];

  private static readonly TICKER_MS = 5 * 60 * 1000;
  private static readonly WORKER_MS = 30 * 1000;
  /** Marquee speed, in px per second. */
  private static readonly TICKER_SPEED = 38;

  private static tickerAt = 0;
  private static workerAt = 0;
  private static tickerBusy = false;
  private static workerBusy = false;
  private static matches: TopBarPage[] = [];
  private static active = 0;

  static init(): void {
    TopBar.applyPlatformHints();
    TopBar.bindSearch();
    TopBar.bindShortcuts();
    // One cheap tick decides whether anything is due; fetches stay rare.
    window.setInterval(() => TopBar.tick(), 10000);
    // Whether the holdings fit (and so whether they scroll) depends on width.
    let resizeTimer: number | undefined;
    window.addEventListener('resize', () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        const el = document.getElementById('app-ticker');
        if (el) TopBar.setupMarquee(el);
      }, 200);
    });
  }

  /** Shortcut hints say ⌘K on macOS; the handler already accepts ⌘ and Ctrl. */
  private static applyPlatformHints(): void {
    const bridge = (window as any).cyrus;
    if (!bridge || bridge.platform !== 'darwin') return;
    document.querySelectorAll<HTMLElement>('[data-ai-open]').forEach(btn => {
      if (btn.title) btn.title = btn.title.replace('Ctrl K', '⌘K');
      const kbd = btn.querySelector('.kbd');
      if (kbd) kbd.textContent = '⌘K';
    });
  }

  /** The router opened a page with chrome: refresh whatever is stale. */
  static onChromeShown(): void {
    TopBar.tick();
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  private static isLive(): boolean {
    const chrome = document.getElementById('app-header');
    return !!chrome && !chrome.classList.contains('d-none')
        && typeof AuthController !== 'undefined' && AuthController.isAuthenticated();
  }

  private static tick(): void {
    if (!TopBar.isLive()) return;
    const now = Date.now();
    if (now - TopBar.tickerAt > TopBar.TICKER_MS) void TopBar.refreshTicker();
    if (now - TopBar.workerAt > TopBar.WORKER_MS) void TopBar.refreshWorker();
  }

  private static async refreshTicker(): Promise<void> {
    if (TopBar.tickerBusy) return;
    TopBar.tickerBusy = true;
    TopBar.tickerAt = Date.now();
    const el = document.getElementById('app-ticker');
    try {
      const token = AuthController.getToken();
      if (!token || !el) return;
      // Looked up at call time, so demo mode's patch applies.
      const response = await MarketData.getHoldings(token, 'all');
      TopBar.renderTicker(el, response?.data || {});
    } catch {
      // Keep the last good strip; say nothing louder than a dim note.
      if (el && !el.childElementCount) {
        el.innerHTML = '<span class="ticker-flat">Prices unavailable — retrying shortly</span>';
      }
      TopBar.tickerAt = Date.now() - TopBar.TICKER_MS + 60000;
    } finally {
      TopBar.tickerBusy = false;
    }
  }

  private static renderTicker(el: HTMLElement, data: any): void {
    const positions: any[] = Array.isArray(data.positions) ? data.positions : [];
    const total = Number(data.total_usd || 0);
    const change = positions.reduce((s, p) => s + (Number(p.value_change_24h_usd) || 0), 0);
    const prior = total - change;
    const changePct = prior > 0 ? (change / prior) * 100 : 0;

    // The portfolio total stays put on the left; every holding, largest
    // first, runs past it (setupMarquee) when they don't all fit.
    const port = total > 0
      ? `<span class="ticker-item ticker-port">PORT <b>${TopBar.esc(TopBar.fmtUsd(total))}</b> `
        + `${TopBar.changeHtml(changePct)}</span>`
      : '';

    const coins = positions
      .filter(p => !p.is_cash && Number(p.usd_value) > 0)
      .sort((a, b) => Number(b.usd_value) - Number(a.usd_value))
      .map(p => {
        const price = p.info?.price ?? p.unit_price;
        const pct = p.info?.change_24h_pct;
        return `<span class="ticker-item">${TopBar.esc(String(p.asset || '').toUpperCase())} `
          + `<b>${TopBar.esc(price != null ? TopBar.fmtPrice(Number(price)) : '—')}</b> `
          + `${pct != null ? TopBar.changeHtml(Number(pct)) : ''}</span>`;
      });

    const track = coins.length
      ? coins.join('')
      : (port ? '' : '<span class="ticker-flat">No holdings to show yet</span>');

    const names = (ExchangeStore.connections || []).map(c =>
      ExchangeStore.getExchangeName(c.id).toUpperCase());
    const live = data.market_data_live !== false;
    const end = `<span class="ticker-end">${TopBar.esc(names.join(' · '))} `
      + `<span class="${live ? 'ticker-up' : 'ticker-flat'}">● ${live ? 'LIVE' : 'STALE'}</span></span>`;

    el.innerHTML = `${port}<div class="ticker-items"><div class="ticker-track">${track}</div></div>${end}`;
    TopBar.setupMarquee(el);
  }

  /**
   * Scroll the holdings when they're wider than the strip: the set is
   * repeated once and the track slides by exactly one set, so it loops
   * seamlessly. Hover pauses it (CSS); with reduced motion on it doesn't move.
   */
  private static setupMarquee(el: HTMLElement): void {
    const box = el.querySelector('.ticker-items') as HTMLElement | null;
    const track = el.querySelector('.ticker-track') as HTMLElement | null;
    if (!box || !track) return;
    track.querySelectorAll('[data-clone]').forEach(n => n.remove());
    box.classList.remove('is-scrolling');
    track.style.removeProperty('--ticker-shift');
    track.style.removeProperty('--ticker-dur');

    const items = Array.from(track.children) as HTMLElement[];
    if (!items.length || box.clientWidth === 0) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const setWidth = track.scrollWidth;
    if (setWidth <= box.clientWidth) return;

    const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
    items.forEach(n => {
      const copy = n.cloneNode(true) as HTMLElement;
      copy.setAttribute('data-clone', '');
      copy.setAttribute('aria-hidden', 'true');
      track.appendChild(copy);
    });
    const shift = setWidth + gap;
    track.style.setProperty('--ticker-shift', `${shift}px`);
    track.style.setProperty('--ticker-dur', `${(shift / TopBar.TICKER_SPEED).toFixed(1)}s`);
    box.classList.add('is-scrolling');
  }

  private static async refreshWorker(): Promise<void> {
    if (TopBar.workerBusy) return;
    TopBar.workerBusy = true;
    TopBar.workerAt = Date.now();
    const pill = document.getElementById('worker-pill');
    const text = document.getElementById('worker-pill-text');
    try {
      const s = await AutomationController.getWorkerStatus();
      const state = String(s?.state || '');
      const up = state === 'healthy' || state === 'starting';
      let label = 'WORKER';
      if (state === 'healthy' && s.age_seconds != null) {
        label = `WORKER · ${Math.round(Number(s.age_seconds))}s`;
      } else if (state === 'starting') {
        label = 'WORKER · STARTING';
      } else if (state) {
        label = `WORKER · ${state.replace('_', ' ').toUpperCase()}`;
      }
      if (text) text.textContent = label;
      pill?.classList.toggle('is-up', up);
      pill?.classList.toggle('is-down', !up);
      if (pill) {
        pill.title = up
          ? `Automation worker running — checks every ${s?.poll_interval || 60}s`
          : 'The automation worker is not checking your rules. Open Automations for details.';
      }
    } catch {
      if (text) text.textContent = 'WORKER · ?';
      pill?.classList.remove('is-up', 'is-down');
    } finally {
      TopBar.workerBusy = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Page search
  // ---------------------------------------------------------------------------

  private static bindSearch(): void {
    const input = document.getElementById('command-search') as HTMLInputElement | null;
    const list = document.getElementById('command-results');
    if (!input || !list) return;

    input.addEventListener('input', () => TopBar.showMatches(input.value));
    input.addEventListener('focus', () => TopBar.showMatches(input.value));
    input.addEventListener('blur', () => {
      // Let a click on a result land before the list goes.
      window.setTimeout(() => TopBar.hideMatches(), 150);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!TopBar.matches.length) return;
        const step = e.key === 'ArrowDown' ? 1 : -1;
        TopBar.active = (TopBar.active + step + TopBar.matches.length) % TopBar.matches.length;
        TopBar.renderMatches();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const page = TopBar.matches[TopBar.active];
        if (page) TopBar.go(page.route);
      } else if (e.key === 'Escape') {
        input.value = '';
        input.blur();
      }
    });
    list.addEventListener('mousedown', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-command-route]') as HTMLElement | null;
      if (!btn) return;
      e.preventDefault();
      TopBar.go(btn.getAttribute('data-command-route') || '');
    });
  }

  private static showMatches(query: string): void {
    const q = query.trim().toLowerCase();
    TopBar.matches = q
      ? TopBar.PAGES.filter(p => `${p.label} ${p.keywords} ${p.group}`.toLowerCase().includes(q))
      : TopBar.PAGES.slice();
    TopBar.active = 0;
    TopBar.renderMatches();
  }

  private static renderMatches(): void {
    const list = document.getElementById('command-results');
    const input = document.getElementById('command-search');
    if (!list) return;
    list.innerHTML = TopBar.matches.length
      ? TopBar.matches.map((p, i) =>
          `<button type="button" class="command-item${i === TopBar.active ? ' is-active' : ''}" `
          + `role="option" aria-selected="${i === TopBar.active}" data-command-route="${p.route}">`
          + `<i class="fa-solid ${p.icon}" aria-hidden="true"></i>${TopBar.esc(p.label)}`
          + `<span class="command-group">${TopBar.esc(p.group)}</span></button>`).join('')
      : '<div class="command-empty">No page matches that.</div>';
    list.classList.remove('d-none');
    input?.setAttribute('aria-expanded', 'true');
  }

  private static hideMatches(): void {
    document.getElementById('command-results')?.classList.add('d-none');
    document.getElementById('command-search')?.setAttribute('aria-expanded', 'false');
  }

  private static go(route: string): void {
    const input = document.getElementById('command-search') as HTMLInputElement | null;
    if (input) { input.value = ''; input.blur(); }
    TopBar.hideMatches();
    if (route && typeof router !== 'undefined') void router.navigate(route);
  }

  /** "/" focuses the page search, unless you're already typing somewhere. */
  private static bindShortcuts(): void {
    document.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!TopBar.isLive()) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable
          || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      e.preventDefault();
      (document.getElementById('command-search') as HTMLInputElement | null)?.focus();
    });
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------

  private static changeHtml(pct: number): string {
    if (!isFinite(pct) || Math.abs(pct) < 0.005) {
      return '<span class="ticker-flat">— 0.00%</span>';
    }
    return pct > 0
      ? `<span class="ticker-up">▲ ${pct.toFixed(2)}%</span>`
      : `<span class="ticker-down">▼ ${Math.abs(pct).toFixed(2)}%</span>`;
  }

  private static fmtUsd(n: number): string {
    return '$' + n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : 2 });
  }

  private static fmtPrice(n: number): string {
    if (!isFinite(n)) return '—';
    if (n >= 1) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (n >= 0.01) return n.toFixed(4);
    return n.toPrecision(3);
  }

  private static esc(s: string): string {
    return s.replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
  }
}

TopBar.init();
