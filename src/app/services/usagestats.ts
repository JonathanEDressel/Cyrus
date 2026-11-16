/**
 * Opt-in anonymous usage stats (renderer side).
 *
 * The main process (src/usagestats.ts) owns everything that's sent. This side
 * only:
 *  - tells it whether someone is signed in (AuthController and app.ts call
 *    UsageStats.signedIn / signedOut),
 *  - asks once, after the first sign-in, whether they want to share, and
 *  - backs the toggle on Profile.
 *
 * Until a collector is configured for the build (`available`), nothing here
 * shows: no prompt and no Profile card.
 */

interface UsageStatsState {
  available: boolean;
  consent: 'granted' | 'declined' | null;
}

class UsageStats {
  /** What's sent, word for word the same in the prompt and on Profile. */
  static readonly SENT = [
    'A random install ID, created when you opt in. It isn\'t linked to your account.',
    'The Cyrus version, and Windows or macOS (Intel or Apple silicon)',
    'Whether the window is open or Cyrus is running in the tray',
    'Whether someone is signed in, and when Cyrus starts, signs in or quits',
    'Your country, which the server works out from your connection',
  ];
  static readonly NEVER = 'Never your username, email, IP address, city or precise location, balances, exchanges, API keys, orders or rules.';

  private static overlay: HTMLElement | null = null;
  /** Closed without choosing: don't ask again until the next launch. */
  private static deferred = false;
  private static promptTimer: number | undefined;

  private static bridge(): any {
    return (window as any).cyrus?.usage || null;
  }

  static async state(): Promise<UsageStatsState> {
    const bridge = UsageStats.bridge();
    if (!bridge) return { available: false, consent: null };
    try {
      return await bridge.state();
    } catch {
      return { available: false, consent: null };
    }
  }

  static async setConsent(granted: boolean): Promise<UsageStatsState> {
    const bridge = UsageStats.bridge();
    if (!bridge) return { available: false, consent: null };
    return bridge.setConsent(granted);
  }

  /** `fresh`: they just typed their password, as opposed to a restored session. */
  static signedIn(fresh: boolean): void {
    const bridge = UsageStats.bridge();
    if (!bridge) return;
    bridge.setSignedIn(true, fresh).then((s: UsageStatsState) => {
      if (s?.available && s.consent === null && !UsageStats.deferred) {
        // Let the landing page settle first.
        window.clearTimeout(UsageStats.promptTimer);
        UsageStats.promptTimer = window.setTimeout(() => UsageStats.ask(), 2500);
      }
    }).catch(() => {});
  }

  static signedOut(): void {
    window.clearTimeout(UsageStats.promptTimer);
    UsageStats.close();
    UsageStats.bridge()?.setSignedIn(false, false).catch(() => {});
  }

  /** The list of what's sent, as HTML. Static strings only. */
  static detailsHtml(): string {
    return `<ul class="usage-list">${UsageStats.SENT.map(s => `<li>${s}</li>`).join('')}</ul>
      <p class="usage-never"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i>${UsageStats.NEVER}</p>`;
  }

  private static ask(): void {
    if (UsageStats.deferred || !AuthController.isAuthenticated()) return;
    // One modal at a time: wait for the update notice to be dealt with.
    if (typeof UpdateNotice !== 'undefined' && UpdateNotice.isOpen()) {
      UsageStats.promptTimer = window.setTimeout(() => UsageStats.ask(), 5000);
      return;
    }
    if (!UsageStats.overlay) UsageStats.build();
    UsageStats.overlay!.classList.remove('d-none');
  }

  private static close(): void {
    UsageStats.overlay?.classList.add('d-none');
  }

  private static async choose(granted: boolean): Promise<void> {
    UsageStats.close();
    try {
      await UsageStats.setConsent(granted);
    } catch {
      // The main process didn't answer; it asks again next launch.
    }
  }

  private static build(): void {
    const el = document.createElement('div');
    el.className = 'upd-overlay d-none';
    el.innerHTML = `
      <div class="upd-modal" role="dialog" aria-modal="true" aria-labelledby="usage-title">
        <header class="upd-head">
          <span class="upd-mark" aria-hidden="true"><i class="fa-solid fa-chart-simple"></i></span>
          <div class="upd-head-text">
            <span class="upd-kicker">Optional</span>
            <h2 class="upd-title" id="usage-title">Help count how many people use Cyrus?</h2>
          </div>
          <button type="button" class="ai-icon-btn" data-usage-later aria-label="Ask me later" title="Ask me later (Esc)">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </header>
        <div class="upd-body">
          <p class="usage-lead">
            If you agree, Cyrus sends a small anonymous check-in every few minutes while it's running.
            It only tells us how many copies are in use, which helps decide what to work on next.
            This is all it sends:
          </p>
          ${UsageStats.detailsHtml()}
        </div>
        <footer class="upd-foot">
          <p class="upd-hint">You can change this any time in Profile → Account. Turning it off deletes what was collected.</p>
          <div class="upd-actions">
            <button type="button" class="btn-secondary" id="usage-decline">No thanks</button>
            <button type="button" class="btn-secondary" id="usage-accept">Share anonymous stats</button>
          </div>
        </footer>
      </div>`;
    document.body.appendChild(el);
    UsageStats.overlay = el;

    el.querySelector('#usage-decline')?.addEventListener('click', () => UsageStats.choose(false));
    el.querySelector('#usage-accept')?.addEventListener('click', () => UsageStats.choose(true));
    el.querySelector('[data-usage-later]')?.addEventListener('click', () => UsageStats.later());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && UsageStats.overlay && !UsageStats.overlay.classList.contains('d-none')) {
        UsageStats.later();
      }
    });
  }

  /** Closed without answering: nothing is sent, and it asks again next launch. */
  private static later(): void {
    UsageStats.deferred = true;
    UsageStats.close();
  }
}
