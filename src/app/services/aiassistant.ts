/**
 * The assistant drawer.
 *
 * Reachable from anywhere: the launcher lives in the sidebar (global chrome,
 * so it survives route changes) and Ctrl/Cmd-K opens it from any page. The
 * panel is appended to <body> and built once, so a conversation survives
 * navigation; AiHistory carries it across restarts.
 *
 * Nothing here knows anything about the portfolio: the question goes up, the
 * answer comes back, and the backend does the gathering. See
 * `helper/ai_assistant.py`.
 */

class AiAssistant {
  private static panel: HTMLElement | null = null;
  private static conversation: AiTurn[] = [];
  private static busy = false;
  private static configured: boolean | null = null;
  private static model = '';
  /** First question after opening re-gathers balances instead of reusing the cache. */
  private static wantsFresh = true;
  private static closeTimer: number | undefined;
  /** Actions awaiting the user's yes/no. Nothing has run while this is set. */
  private static pending: AiPending | null = null;
  private static view: 'chat' | 'history' = 'chat';
  /** Which saved conversation the open thread belongs to, once it has one. */
  private static conversationId: string | null = null;

  private static readonly SUGGESTIONS = [
    'What are my biggest positions?',
    'How has my portfolio changed this month?',
    'Cancel all my BTC sell limit orders',
    'Explain my automations in plain English',
  ];

  /** One delegated listener, installed at load — the button lives in a view
   *  that the router swaps in and out, so binding it directly would break. */
  static install(): void {
    document.addEventListener('click', (e) => {
      const trigger = (e.target as HTMLElement).closest('[data-ai-open]');
      if (trigger) {
        e.preventDefault();
        AiAssistant.open();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && AiAssistant.isOpen()) {
        AiAssistant.close();
        return;
      }
      // Ctrl/Cmd-K from any page. Only while signed in — the sidebar (and so
      // the launcher) is hidden on the login and account screens.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey
          && e.key.toLowerCase() === 'k' && AuthController.isAuthenticated()) {
        e.preventDefault();
        AiAssistant.isOpen() ? AiAssistant.close() : AiAssistant.open();
      }
    });
  }

  static isOpen(): boolean {
    return !!AiAssistant.panel && !AiAssistant.panel.classList.contains('d-none');
  }

  static open(): void {
    if (!AiAssistant.panel) AiAssistant.build();
    // The tutorial drawer uses the same slot.
    if (typeof Tutorials !== 'undefined') Tutorials.close();
    // Cancel a close that's still mid-transition, or its timer would re-hide
    // the panel we're reopening.
    window.clearTimeout(AiAssistant.closeTimer);
    AiAssistant.panel!.classList.remove('d-none');
    document.getElementById('ai-fab-wrap')?.classList.add('is-hidden');
    // Next frame, so the transition has a start state to animate from.
    requestAnimationFrame(() => AiAssistant.panel!.classList.add('ai-open'));
    AiAssistant.wantsFresh = true;
    AiAssistant.refreshStatus();
    (document.getElementById('ai-input') as HTMLTextAreaElement)?.focus();
  }

  static close(): void {
    if (!AiAssistant.panel) return;
    AiAssistant.panel.classList.remove('ai-open');
    document.getElementById('ai-fab-wrap')?.classList.remove('is-hidden');
    window.clearTimeout(AiAssistant.closeTimer);
    AiAssistant.closeTimer = window.setTimeout(
      () => AiAssistant.panel?.classList.add('d-none'), 200);
  }

  // ── Construction ────────────────────────────────────────────────────────

  private static build(): void {
    const el = document.createElement('div');
    el.className = 'ai-drawer d-none';
    el.innerHTML = `
      <div class="ai-scrim" data-ai-close></div>
      <aside class="ai-panel" role="dialog" aria-label="Portfolio assistant">
        <header class="ai-panel-head">
          <div class="ai-panel-title">
            ${AiAssistant.markSvg('ai-grad-panel', 'ai-panel-mark')}
            <div class="ai-panel-title-text">
              <span class="ai-panel-name">Assistant</span>
              <span class="ai-panel-sub" id="ai-model-chip"></span>
            </div>
          </div>
          <div class="ai-panel-actions">
            <button class="ai-icon-btn" id="ai-history" title="Conversation history">
              <i class="fa-solid fa-clock-rotate-left"></i>
            </button>
            <button class="ai-icon-btn" id="ai-reset" title="New conversation">
              <i class="fa-solid fa-pen-to-square"></i>
            </button>
            <button class="ai-icon-btn" data-ai-close title="Close">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
        </header>

        <div class="ai-body" id="ai-body"></div>

        <footer class="ai-composer" id="ai-composer">
          <textarea id="ai-input" class="ai-input" rows="1"
                    placeholder="Ask anything about your portfolio…"></textarea>
          <button class="ai-send" id="ai-send" title="Send">
            <i class="fa-solid fa-arrow-up"></i>
          </button>
        </footer>
        <p class="ai-disclaimer">
          Claude can read your portfolio and place, cancel and automate on your behalf.
          Nothing runs until you confirm it. Check what you're approving — answers and
          actions can both be wrong.
        </p>
      </aside>`;

    document.body.appendChild(el);
    AiAssistant.panel = el;

    el.querySelectorAll('[data-ai-close]').forEach(b =>
      b.addEventListener('click', () => AiAssistant.close()));
    document.getElementById('ai-reset')?.addEventListener('click', () => AiAssistant.reset());
    document.getElementById('ai-history')?.addEventListener('click', () => {
      AiAssistant.view = AiAssistant.view === 'history' ? 'chat' : 'history';
      AiAssistant.render();
    });
    document.getElementById('ai-send')?.addEventListener('click', () => AiAssistant.send());

    const input = document.getElementById('ai-input') as HTMLTextAreaElement;
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        AiAssistant.send();
      }
    });
    input?.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    });
  }

  /**
   * The four-point sparkle, as inline SVG so it renders under the app's CSP and
   * can pick up the accent gradient in both themes. Gradient ids must be unique
   * per instance on the page, hence the parameter.
   */
  private static markSvg(gradientId: string, cls: string): string {
    return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="${gradientId}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="var(--accent-cyan-light)"/>
          <stop offset="100%" stop-color="var(--accent-purple)"/>
        </linearGradient>
      </defs>
      <path fill="url(#${gradientId})"
            d="M12 0c0 6.6 5.4 12 12 12-6.6 0-12 5.4-12 12 0-6.6-5.4-12-12-12C6.6 12 12 6.6 12 0Z"/>
      <path fill="url(#${gradientId})" opacity="0.65"
            d="M19.5 15.5c0 2.5 2 4.5 4.5 4.5-2.5 0-4.5 2-4.5 4.5 0-2.5-2-4.5-4.5-4.5 2.5 0 4.5-2 4.5-4.5Z"/>
    </svg>`;
  }

  // ── State ───────────────────────────────────────────────────────────────

  private static async refreshStatus(): Promise<void> {
    try {
      const token = AuthController.getToken();
      if (!token) return;
      const res = await AiData.getStatus(token);
      AiAssistant.configured = res.data.configured;
      AiAssistant.model = res.data.model;
      const chip = document.getElementById('ai-model-chip');
      if (chip) chip.textContent = res.data.configured ? res.data.model : 'Not set up';
    } catch {
      AiAssistant.configured = null;
    }
    AiAssistant.render();
  }

  /** Start a fresh thread. The current one is already saved, so this is a
   *  switch, not a discard. */
  private static reset(): void {
    AiAssistant.conversation = [];
    AiAssistant.conversationId = null;
    AiAssistant.pending = null;
    AiAssistant.wantsFresh = true;
    AiAssistant.view = 'chat';
    AiAssistant.render();
    (document.getElementById('ai-input') as HTMLTextAreaElement)?.focus();
  }

  private static persist(): void {
    AiAssistant.conversationId =
      AiHistory.save(AiAssistant.conversationId, AiAssistant.conversation);
  }

  private static openConversation(id: string): void {
    const saved = AiHistory.get(id);
    if (!saved) return;
    AiAssistant.conversation = saved.turns;
    AiAssistant.conversationId = saved.id;
    AiAssistant.pending = null;      // any pending action expired long ago
    AiAssistant.wantsFresh = true;   // re-gather before answering anything new
    AiAssistant.view = 'chat';
    AiAssistant.render();
  }

  private static setBusy(busy: boolean): void {
    AiAssistant.busy = busy;
    const send = document.getElementById('ai-send') as HTMLButtonElement;
    const input = document.getElementById('ai-input') as HTMLTextAreaElement;
    if (send) send.disabled = busy;
    if (input) input.disabled = busy;
  }

  // ── Sending ─────────────────────────────────────────────────────────────

  private static async send(question?: string): Promise<void> {
    if (AiAssistant.busy) return;

    const input = document.getElementById('ai-input') as HTMLTextAreaElement;
    const text = (question ?? input?.value ?? '').trim();
    if (!text) return;

    if (input && question === undefined) {
      input.value = '';
      input.style.height = 'auto';
    }

    // Asking something new abandons an unanswered confirmation rather than
    // leaving a stale "Do it" button under a fresh question.
    AiAssistant.pending = null;
    AiAssistant.conversation.push({ role: 'user', content: text });
    AiAssistant.render();
    AiAssistant.showThinking();
    AiAssistant.setBusy(true);

    try {
      const token = AuthController.getToken();
      if (!token) throw new Error('Not authenticated');

      // Everything before this turn — the backend appends the question itself.
      const history = AiAssistant.conversation.slice(0, -1);
      const res = await AiData.ask(text, history, AiAssistant.wantsFresh, token);
      AiAssistant.wantsFresh = false;
      AiAssistant.absorb(res.data);
    } catch (err: any) {
      AiAssistant.render();
      AiAssistant.showError(err?.message || 'Something went wrong asking Claude.');
    } finally {
      AiAssistant.setBusy(false);
      (document.getElementById('ai-input') as HTMLTextAreaElement)?.focus();
    }
  }

  /** Fold a reply into the thread: text becomes a turn, results attach to it,
   *  and a pending confirmation becomes the card at the bottom. */
  private static absorb(reply: AiReply): void {
    const results = reply.results || [];
    if (reply.answer || results.length) {
      AiAssistant.conversation.push({
        role: 'assistant',
        content: reply.answer || '',
        results: results.length ? results : undefined,
      });
    }
    AiAssistant.pending = reply.pending || null;
    AiAssistant.persist();
    AiAssistant.render();
  }

  private static async decide(approved: boolean): Promise<void> {
    const pending = AiAssistant.pending;
    if (!pending || AiAssistant.busy) return;

    AiAssistant.pending = null;
    AiAssistant.render();
    AiAssistant.showThinking();
    AiAssistant.setBusy(true);

    try {
      const token = AuthController.getToken();
      if (!token) throw new Error('Not authenticated');
      const res = await AiData.confirm(pending.token, approved, token);
      AiAssistant.absorb(res.data);
    } catch (err: any) {
      AiAssistant.render();
      AiAssistant.showError(err?.message || 'Something went wrong completing that.');
    } finally {
      AiAssistant.setBusy(false);
    }
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  private static render(): void {
    const body = document.getElementById('ai-body');
    const composer = document.getElementById('ai-composer');
    if (!body) return;

    const historyBtn = document.getElementById('ai-history');
    historyBtn?.classList.toggle('is-active', AiAssistant.view === 'history');

    // History first: a conversation stays readable even after the key is
    // removed, which is when someone is most likely to go looking for it.
    if (AiAssistant.view === 'history') {
      composer?.classList.add('d-none');
      AiAssistant.renderHistory(body);
      return;
    }

    if (AiAssistant.configured === false) {
      composer?.classList.add('d-none');
      body.innerHTML = `
        <div class="ai-setup">
          ${AiAssistant.markSvg('ai-grad-setup', 'ai-setup-mark')}
          <h3>Connect your Anthropic account</h3>
          <p>
            Ask about your portfolio, or tell it what to do — cancel orders, place limits,
            set up automations. It runs on Claude using your own Anthropic API key, so it's
            billed to your account and your portfolio never passes through anyone else's
            servers.
          </p>
          <button class="ai-setup-btn" id="ai-goto-setup">
            Set it up in Profile <i class="fa-solid fa-arrow-right"></i>
          </button>
        </div>`;
      document.getElementById('ai-goto-setup')?.addEventListener('click', () => {
        AiAssistant.close();
        router.navigate('profile');
      });
      return;
    }

    composer?.classList.remove('d-none');

    if (AiAssistant.conversation.length === 0) {
      body.innerHTML = `
        <div class="ai-empty">
          ${AiAssistant.markSvg('ai-grad-empty', 'ai-empty-mark')}
          <p class="ai-empty-title">Ask about your portfolio, or say what to do</p>
          <div class="ai-suggestions">
            ${AiAssistant.SUGGESTIONS.map(s =>
              `<button class="ai-suggestion" data-q="${AiAssistant.escape(s)}">${AiAssistant.escape(s)}</button>`
            ).join('')}
          </div>
          <p class="ai-shortcut-hint">
            Press ${AiAssistant.shortcutHtml()} to open this from any page
          </p>
        </div>`;
      body.querySelectorAll('.ai-suggestion').forEach(btn =>
        btn.addEventListener('click', () =>
          AiAssistant.send((btn as HTMLElement).getAttribute('data-q') || '')));
      return;
    }

    body.innerHTML = AiAssistant.conversation.map(turn => {
      if (turn.role === 'user') {
        return `<div class="ai-msg ai-msg-user">${AiAssistant.escape(turn.content)}</div>`;
      }
      const bubble = turn.content
        ? `<div class="ai-msg ai-msg-bot">${AiAssistant.markdown(turn.content)}</div>`
        : '';
      return bubble + AiAssistant.resultsHtml(turn.results);
    }).join('') + AiAssistant.pendingHtml();

    body.querySelector('#ai-approve')?.addEventListener('click', () => AiAssistant.decide(true));
    body.querySelector('#ai-decline')?.addEventListener('click', () => AiAssistant.decide(false));
    AiAssistant.scrollToEnd();
  }

  private static renderHistory(body: HTMLElement): void {
    const conversations = AiHistory.list();

    if (conversations.length === 0) {
      body.innerHTML = `
        <div class="ai-empty">
          <i class="fa-solid fa-clock-rotate-left ai-empty-icon"></i>
          <p class="ai-empty-title">No saved conversations yet</p>
          <p class="ai-history-hint">Conversations are saved on this device as you go.</p>
        </div>`;
      return;
    }

    const rows = conversations.map(c => {
      const active = c.id === AiAssistant.conversationId ? ' is-current' : '';
      const turns = c.turns.length;
      return `<li class="ai-history-row${active}" data-conv="${AiAssistant.escape(c.id)}">
        <button class="ai-history-open" data-conv="${AiAssistant.escape(c.id)}">
          <span class="ai-history-title">${AiAssistant.escape(c.title)}</span>
          <span class="ai-history-meta">
            ${AiHistory.relativeTime(c.updatedAt)} · ${turns} message${turns === 1 ? '' : 's'}
          </span>
        </button>
        <button class="ai-history-del" data-del="${AiAssistant.escape(c.id)}" title="Delete">
          <i class="fa-solid fa-trash"></i>
        </button>
      </li>`;
    }).join('');

    body.innerHTML = `
      <div class="ai-history">
        <div class="ai-history-head">
          <span>${conversations.length} conversation${conversations.length === 1 ? '' : 's'}</span>
          <button class="ai-history-clear" id="ai-history-clear">Clear all</button>
        </div>
        <ul class="ai-history-list">${rows}</ul>
      </div>`;

    body.querySelectorAll<HTMLElement>('.ai-history-open').forEach(btn =>
      btn.addEventListener('click', () =>
        AiAssistant.openConversation(btn.getAttribute('data-conv') || '')));

    body.querySelectorAll<HTMLElement>('.ai-history-del').forEach(btn =>
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-del') || '';
        AiHistory.remove(id);
        // Deleting the thread you're looking at leaves the panel on a
        // conversation that no longer exists — start a fresh one instead.
        if (id === AiAssistant.conversationId) {
          AiAssistant.conversation = [];
          AiAssistant.conversationId = null;
          AiAssistant.pending = null;
        }
        AiAssistant.render();
      }));

    document.getElementById('ai-history-clear')?.addEventListener('click', () => {
      AiHistory.clear();
      AiAssistant.conversationId = null;
      AiAssistant.render();
    });
  }

  /** What happened to each action the user approved — drawn from the server's
   *  own result, not from the model's account of it. */
  private static resultsHtml(results?: AiResult[]): string {
    if (!results?.length) return '';
    const rows = results.map(r => {
      const state = r.declined ? 'declined' : (r.ok ? 'ok' : 'failed');
      const icon = r.declined ? 'fa-ban' : (r.ok ? 'fa-circle-check' : 'fa-circle-xmark');
      const reason = !r.ok && !r.declined && r.error
        ? `<span class="ai-result-error">${AiAssistant.escape(r.error)}</span>` : '';
      return `<div class="ai-result ai-result-${state}">
        <i class="fa-solid ${icon}"></i>
        <div class="ai-result-body">
          <span class="ai-result-title">${AiAssistant.escape(r.title)}</span>
          ${reason}
        </div>
      </div>`;
    }).join('');
    return `<div class="ai-results">${rows}</div>`;
  }

  /** The confirmation card. Every line is rendered from the arguments the
   *  server will actually send, so approving it approves the real thing. */
  private static pendingHtml(): string {
    const pending = AiAssistant.pending;
    if (!pending) return '';

    const danger = pending.actions.some(a => a.danger);
    const rows = pending.actions.map(a => `
      <li class="ai-action${a.danger ? ' ai-action-danger' : ''}">
        <span class="ai-action-title">${AiAssistant.escape(a.title)}</span>
        <span class="ai-action-detail">${AiAssistant.escape(a.detail)}</span>
      </li>`).join('');

    const count = pending.actions.length;
    return `<div class="ai-confirm${danger ? ' ai-confirm-danger' : ''}">
      <div class="ai-confirm-head">
        <i class="fa-solid ${danger ? 'fa-triangle-exclamation' : 'fa-circle-question'}"></i>
        <span>Confirm ${count} action${count === 1 ? '' : 's'}</span>
      </div>
      <ul class="ai-action-list">${rows}</ul>
      <div class="ai-confirm-actions">
        <button class="ai-confirm-no" id="ai-decline">Cancel</button>
        <button class="ai-confirm-yes" id="ai-approve">
          <i class="fa-solid fa-check"></i> Do it
        </button>
      </div>
    </div>`;
  }

  private static showThinking(): void {
    const body = document.getElementById('ai-body');
    if (!body) return;
    const el = document.createElement('div');
    el.className = 'ai-msg ai-msg-bot ai-thinking';
    el.id = 'ai-thinking';
    el.innerHTML = '<span></span><span></span><span></span>';
    body.appendChild(el);
    AiAssistant.scrollToEnd();
  }

  private static showError(message: string): void {
    const body = document.getElementById('ai-body');
    if (!body) return;
    const el = document.createElement('div');
    el.className = 'ai-error';
    el.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i><span>${AiAssistant.escape(message)}</span>`;
    body.appendChild(el);
    AiAssistant.scrollToEnd();
  }

  private static scrollToEnd(): void {
    const body = document.getElementById('ai-body');
    if (body) body.scrollTop = body.scrollHeight;
  }

  // ── Text ────────────────────────────────────────────────────────────────

  /** The open/close shortcut, as keycaps. Lives in here rather than on the
   *  launcher button — the button is a plain icon, so this is where anyone
   *  finds out the shortcut exists. */
  private static shortcutHtml(): string {
    const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
    const modifier = isMac ? '⌘' : 'Ctrl';
    return `<kbd class="ai-kbd">${modifier}</kbd><kbd class="ai-kbd">K</kbd>`;
  }

  /** Escapes quotes as well as angle brackets, because this is also used for
   *  attribute values (the suggestion buttons' data-q). */
  private static escape(str: string): string {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Just enough markdown for what the system prompt asks Claude to produce:
   * paragraphs, bullet and numbered lists, bold, and inline code. Escaping
   * happens first, so the patterns below only ever match literal text.
   */
  private static markdown(raw: string): string {
    const inline = (s: string) =>
      AiAssistant.escape(s)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');

    return raw.split(/\n{2,}/).map(block => {
      const lines = block.split('\n').filter(l => l.trim());
      if (!lines.length) return '';

      if (lines.every(l => /^\s*[-*•]\s+/.test(l))) {
        const items = lines.map(l => `<li>${inline(l.replace(/^\s*[-*•]\s+/, ''))}</li>`).join('');
        return `<ul>${items}</ul>`;
      }
      if (lines.every(l => /^\s*\d+[.)]\s+/.test(l))) {
        const items = lines.map(l => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('');
        return `<ol>${items}</ol>`;
      }
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    }).join('');
  }
}

AiAssistant.install();
