(function () {

class ProfileController {
  private connections: ExchangeConnection[] = [];
  private supportedExchanges: any[] = [];
  /** Exchange the key-generator panel is currently offering a script for. */
  private keygenExchangeId: string | null = null;
  private aiConfigured = false;
  private alertTimer: number | undefined;

  constructor() {
    this.init();
  }

  private init(): void {
    this.setupTabs();
    this.loadProfile();
    this.loadConnections();
    this.loadSupportedExchanges();
    this.loadAiStatus();
    this.loadUsageStats();
    this.attachEventListeners();
  }

  /** The opt-in usage-stats card; stays hidden when the build has no collector. */
  private async loadUsageStats(): Promise<void> {
    const state = await UsageStats.state();
    const card = document.getElementById('usage-card');
    const toggle = document.getElementById('usage-toggle') as HTMLInputElement | null;
    const details = document.getElementById('usage-details-body');
    if (!card || !toggle || !state.available) return;
    if (details) details.innerHTML = UsageStats.detailsHtml();
    toggle.checked = state.consent === 'granted';
    card.classList.remove('d-none');

    toggle.addEventListener('change', async () => {
      const granted = toggle.checked;
      toggle.disabled = true;
      try {
        await UsageStats.setConsent(granted);
        this.showSuccess('usage', granted
          ? 'Thanks — anonymous usage stats are on'
          : 'Usage stats are off, and what was sent has been deleted');
      } catch {
        toggle.checked = !granted;
        this.showError('usage', 'Could not change the usage stats setting');
      } finally {
        toggle.disabled = false;
      }
    });
  }

  /** Show one pane at a time. Deep-linkable via ?tab= on the route params, so
   *  "set up the assistant" links can land on the right pane. */
  private setupTabs(): void {
    const tabs = Array.from(document.querySelectorAll<HTMLElement>('.profile-tab'));
    const panes = Array.from(document.querySelectorAll<HTMLElement>('.profile-pane'));

    const show = (name: string) => {
      tabs.forEach(t => t.classList.toggle('active', t.getAttribute('data-tab') === name));
      panes.forEach(p => p.classList.toggle('d-none', p.getAttribute('data-pane') !== name));
    };

    tabs.forEach(tab => tab.addEventListener('click', () => {
      show(tab.getAttribute('data-tab') || 'account');
    }));

    const requested = (window as any).__routeParams?.tab;
    if (requested && tabs.some(t => t.getAttribute('data-tab') === requested)) {
      show(requested);
    }
  }

  private attachEventListeners(): void {
    document.getElementById('save-username-btn')?.addEventListener('click', () => this.saveUsername());
    document.getElementById('ai-key-save')?.addEventListener('click', () => this.saveAiKey());
    document.getElementById('ai-key-remove')?.addEventListener('click', () => this.removeAiKey());
    document.getElementById('save-password-btn')?.addEventListener('click', () => this.savePassword());
    document.getElementById('add-connection-btn')?.addEventListener('click', () => this.addConnection());
    document.getElementById('notifications-toggle')?.addEventListener('change', (e) => {
      const enabled = (e.target as HTMLInputElement).checked;
      this.saveNotifications(enabled);
    });

    document.getElementById('donation-modal-toggle')?.addEventListener('change', (e) => {
      const enabled = (e.target as HTMLInputElement).checked;
      this.saveDonationModal(enabled);
    });

    document.getElementById('theme-toggle')?.addEventListener('change', (e) => {
      const isDark = (e.target as HTMLInputElement).checked;
      this.saveTheme(isDark ? 'dark' : 'light');
    });

    document.getElementById('active-toggle')?.addEventListener('change', (e) => {
      const isActive = (e.target as HTMLInputElement).checked;
      this.saveActive(isActive);
    });

    document.getElementById('save-email-btn')?.addEventListener('click', () => this.saveEmailSettings());
    document.getElementById('test-email-btn')?.addEventListener('click', () => this.sendTestEmail());
    document.getElementById('test-report-btn')?.addEventListener('click', () => this.sendTestReport());

    document.getElementById('new-exchange-name')?.addEventListener('change', () => {
      const select = document.getElementById('new-exchange-name') as HTMLSelectElement;
      const exchange = this.supportedExchanges.find(e => e.id === select.value);
      const passphraseGroup = document.getElementById('passphrase-group');
      if (passphraseGroup) {
        passphraseGroup.classList.toggle('d-none', !exchange?.requires_passphrase);
      }
      const sandboxGroup = document.getElementById('sandbox-group');
      if (sandboxGroup) {
        sandboxGroup.classList.toggle('d-none', !exchange?.has_sandbox);
        if (!exchange?.has_sandbox) {
          (document.getElementById('new-is-sandbox') as HTMLInputElement).checked = false;
        }
      }
      const guideWrapper = document.getElementById('exchange-guide-wrapper');
      const guideLink = document.getElementById('exchange-guide-link') as HTMLAnchorElement;
      if (guideWrapper && guideLink) {
        if (exchange?.guide_url) {
          guideLink.href = exchange.guide_url;
          guideWrapper.classList.remove('d-none');
        } else {
          guideWrapper.classList.add('d-none');
        }
      }

      // Pre-fill a label: it's required, and with several connections per
      // exchange it's the only thing distinguishing them.
      const labelInput = document.getElementById('new-connection-label') as HTMLInputElement | null;
      if (labelInput && !labelInput.value.trim() && exchange) {
        labelInput.value = this.suggestConnectionLabel(exchange.id);
      }

      this.updateKeygenPanel(exchange);
    });

    document.getElementById('keygen-download-btn')?.addEventListener('click', () => {
      this.downloadKeygenScript();
    });
  }

  /** Show the key-generator offer for exchanges that issue no secret. */
  private updateKeygenPanel(exchange: any): void {
    const panel = document.getElementById('keygen-panel');
    if (!panel) return;

    // The bridge only exists inside Electron, and saving needs a native dialog.
    const canSave = typeof (window as any).cyrus?.saveKeygenScript === 'function';
    const show = !!exchange?.needs_generated_keypair && canSave;
    panel.classList.toggle('d-none', !show);
    if (!show) return;

    const name = exchange.name || exchange.id;
    const nameEl = document.getElementById('keygen-exchange-name');
    if (nameEl) nameEl.textContent = name;
    const titleEl = document.getElementById('keygen-title');
    if (titleEl) titleEl.textContent = `${name} doesn't give you a secret key`;

    const portal = document.getElementById('keygen-portal-link') as HTMLAnchorElement | null;
    if (portal) {
      portal.href = exchange.api_key_url || exchange.website || '#';
      portal.textContent = `${name}'s API settings`;
    }

    this.setKeygenStatus('');
    this.keygenExchangeId = exchange.id;
  }

  private setKeygenStatus(message: string, tone: 'ok' | 'error' | '' = ''): void {
    const el = document.getElementById('keygen-status');
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('keygen-status-ok', tone === 'ok');
    el.classList.toggle('keygen-status-error', tone === 'error');
  }

  private async downloadKeygenScript(): Promise<void> {
    const bridge = (window as any).cyrus;
    if (!bridge?.saveKeygenScript || !this.keygenExchangeId) return;

    const btn = document.getElementById('keygen-download-btn') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    this.setKeygenStatus('Saving…');

    try {
      const result = await bridge.saveKeygenScript(this.keygenExchangeId);
      if (result?.canceled) {
        this.setKeygenStatus('');
      } else if (result?.saved) {
        this.setKeygenStatus('Saved — run it, then paste the keys here.', 'ok');
        // Point Explorer at it so nobody has to hunt for the file.
        bridge.showItemInFolder?.(result.path);
      } else {
        this.setKeygenStatus(result?.error || 'Could not save the file.', 'error');
      }
    } catch (err: any) {
      this.setKeygenStatus(err?.message || 'Could not save the file.', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  private async loadProfile(): Promise<void> {
    try {
      const user = await UserController.getProfile();
      const usernameInput = document.getElementById('profile-username') as HTMLInputElement;
      if (usernameInput) usernameInput.value = user.username;
      const notifToggle = document.getElementById('notifications-toggle') as HTMLInputElement;
      if (notifToggle) notifToggle.checked = user.notifications_enabled !== false;
      const notifModalToggle = document.getElementById('donation-modal-toggle') as HTMLInputElement;  
      if (notifModalToggle) notifModalToggle.checked = user.donation_modal_enabled !== false;
      const themeToggle = document.getElementById('theme-toggle') as HTMLInputElement;
      if (themeToggle) themeToggle.checked = user.theme !== 'light';
      const activeToggle = document.getElementById('active-toggle') as HTMLInputElement;
      if (activeToggle) activeToggle.checked = user.is_active !== false;
      NotificationService.setEnabled(user.notifications_enabled !== false);

      const emailToggle = document.getElementById('email-notifications-toggle') as HTMLInputElement;
      if (emailToggle) emailToggle.checked = user.email_notifications_enabled === true;
      const emailAddr = document.getElementById('email-address') as HTMLInputElement;
      if (emailAddr) emailAddr.value = user.notify_email || '';
      const emailHost = document.getElementById('email-smtp-host') as HTMLInputElement;
      if (emailHost) emailHost.value = user.smtp_host || '';
      const emailPort = document.getElementById('email-smtp-port') as HTMLInputElement;
      if (emailPort) emailPort.value = user.smtp_port != null ? String(user.smtp_port) : '';
      const emailPw = document.getElementById('email-app-password') as HTMLInputElement;
      if (emailPw) emailPw.placeholder = user.smtp_password_set ? 'Saved — leave blank to keep' : 'Enter app password';

      this.renderHero(user);
    } catch (error: any) {
      this.showError('username', error.message || 'Failed to load profile');
    }
  }

  /** The identity strip: who you are, plus the two bits of state people open
   *  this page to check (are my keys working, is email on). */
  private renderHero(user: UserModel): void {
    const initial = document.getElementById('profile-initial');
    if (initial) initial.textContent = (user.username || '?').charAt(0);

    const name = document.getElementById('profile-hero-name');
    if (name) name.textContent = user.username || 'Profile';

    const meta = document.getElementById('profile-hero-meta');
    if (meta) {
      const since = user.created_at
        ? new Date(user.created_at.endsWith('Z') ? user.created_at : user.created_at + 'Z')
            .toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
        : null;
      meta.textContent = since ? `Member since ${since}` : 'Manage your account settings';
    }

    const chips = document.getElementById('profile-hero-chips');
    if (!chips) return;

    const items: string[] = [];
    const connected = (user.exchange_connections || []).length;
    if (connected === 0) {
      items.push(`<span class="profile-chip profile-chip-warn">
        <i class="fa-solid fa-triangle-exclamation"></i>No exchanges</span>`);
    } else if (user.has_validated_connection) {
      items.push(`<span class="profile-chip profile-chip-ok">
        <i class="fa-solid fa-circle-check"></i>${connected} connected</span>`);
    } else {
      items.push(`<span class="profile-chip profile-chip-warn">
        <i class="fa-solid fa-triangle-exclamation"></i>${connected} unvalidated</span>`);
    }

    if (user.email_notifications_enabled) {
      items.push(`<span class="profile-chip"><i class="fa-solid fa-envelope"></i>Email on</span>`);
    }
    if (user.is_active === false) {
      items.push(`<span class="profile-chip profile-chip-warn">
        <i class="fa-solid fa-pause"></i>Deactivated</span>`);
    }

    chips.innerHTML = items.join('');
  }

  // ── Assistant (Anthropic API key) ─────────────────────────────────────────

  private async loadAiStatus(): Promise<void> {
    try {
      const token = AuthController.getToken();
      if (!token) return;
      const res = await AiData.getStatus(token);
      this.setAiStatus(res.data.configured, res.data.model);
    } catch {
      this.setAiStatus(false, '');
    }
  }

  private setAiStatus(configured: boolean, model: string): void {
    this.aiConfigured = configured;

    const pill = document.getElementById('ai-key-status');
    if (pill) {
      pill.textContent = configured ? `Connected · ${model}` : 'Not connected';
      pill.classList.toggle('ai-status-on', configured);
      pill.classList.toggle('ai-status-off', !configured);
    }

    const remove = document.getElementById('ai-key-remove');
    remove?.classList.toggle('d-none', !configured);

    const input = document.getElementById('ai-key-input') as HTMLInputElement;
    if (input) {
      input.value = '';
      input.placeholder = configured ? 'Saved — enter a new key to replace it' : 'sk-ant-…';
    }
  }

  private async saveAiKey(): Promise<void> {
    const input = document.getElementById('ai-key-input') as HTMLInputElement;
    const apiKey = input?.value.trim();
    if (!apiKey) {
      this.showError('ai', 'Paste your Anthropic API key first');
      return;
    }

    const btn = document.getElementById('ai-key-save') as HTMLButtonElement;
    const original = btn?.innerHTML;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying…';
    }
    try {
      const token = AuthController.getToken();
      if (!token) throw new Error('Not authenticated');
      await AiData.saveKey(apiKey, token);
      await this.loadAiStatus();
      this.showSuccess('ai', 'API key verified and saved. The assistant is ready on the Overview page.');
    } catch (error: any) {
      this.showError('ai', error.message || 'Failed to save the API key');
    } finally {
      if (btn) {
        btn.disabled = false;
        if (original) btn.innerHTML = original;
      }
    }
  }

  private async removeAiKey(): Promise<void> {
    try {
      const token = AuthController.getToken();
      if (!token) throw new Error('Not authenticated');
      await AiData.deleteKey(token);
      this.setAiStatus(false, '');
      this.showSuccess('ai', 'API key removed');
    } catch (error: any) {
      this.showError('ai', error.message || 'Failed to remove the API key');
    }
  }

  private async loadSupportedExchanges(): Promise<void> {
    try {
      this.supportedExchanges = await ExchangeController.getSupportedExchanges();
      this.refreshExchangeDropdown();
      // Connections may have rendered before this metadata arrived, in which
      // case their exchange badges fell back to the raw id. Redraw with names.
      if (this.connections.length > 0) this.renderConnections();
    } catch {
      const select = document.getElementById('new-exchange-name') as HTMLSelectElement;
      if (select) select.innerHTML = '<option value="" disabled selected>Failed to load exchanges</option>';
    }
  }

  private refreshExchangeDropdown(): void {
    const select = document.getElementById('new-exchange-name') as HTMLSelectElement;
    if (!select) return;

    // Every supported exchange stays selectable. More than one connection per
    // exchange is legitimate — a trading account beside a cold-storage one, or a
    // read-only key beside a withdraw-capable one — and the schema has always
    // keyed on (exchange, label). Adding the *same keys* twice is what's
    // rejected, by the backend, on fingerprint.
    select.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.selected = true;
    placeholder.textContent = 'Select an exchange...';
    select.appendChild(placeholder);

    for (const ex of this.supportedExchanges) {
      const existing = this.connections.filter(c => c.exchange_name === ex.id).length;
      const opt = document.createElement('option');
      opt.value = ex.id;
      opt.textContent = existing > 0
        ? `${ex.name} — ${existing} connected`
        : ex.name;
      select.appendChild(opt);
    }

    const addBtn = document.getElementById('add-connection-btn') as HTMLButtonElement;
    if (addBtn) addBtn.disabled = this.supportedExchanges.length === 0;
  }

  /** Suggest a label so a second connection doesn't collide with the first. */
  private suggestConnectionLabel(exchangeId: string): string {
    const labels = new Set(
      this.connections.filter(c => c.exchange_name === exchangeId).map(c => c.label)
    );
    if (labels.size === 0) return 'Main';
    for (const candidate of ['Second', 'Trading', 'Cold storage', 'Savings']) {
      if (!labels.has(candidate)) return candidate;
    }
    let n = 2;
    while (labels.has(`Account ${n}`)) n++;
    return `Account ${n}`;
  }

  private async loadConnections(): Promise<void> {
    try {
      this.connections = await ExchangeController.getConnections();
      this.renderConnections();
      this.refreshExchangeDropdown();
    } catch (error: any) {
      const list = document.getElementById('connections-list');
      if (list) list.innerHTML = `<p class="text-muted">Failed to load connections: ${this.escapeHtml(error.message)}</p>`;
    }
  }

  private renderConnections(): void {
    const list = document.getElementById('connections-list');
    if (!list) return;

    // Badge the tab so the count is visible from any pane.
    const count = document.getElementById('tab-count-exchanges');
    if (count) {
      count.textContent = String(this.connections.length);
      count.classList.toggle('d-none', this.connections.length === 0);
    }

    if (this.connections.length === 0) {
      list.innerHTML = '<p class="text-muted">No exchange connections yet. Add one below to start tracking a portfolio.</p>';
      return;
    }

    list.innerHTML = this.connections.map(c => {
      const statusClass = c.is_validated ? 'status-active' : 'status-inactive';
      const statusText = c.is_validated ? 'Validated' : 'Not Validated';
      const sandboxBadge = c.is_sandbox
        ? '<span class="status-badge status-unverified">Sandbox</span>' : '';
      const lastValidated = c.keys_last_validated
        ? new Date(c.keys_last_validated.endsWith('Z') ? c.keys_last_validated : c.keys_last_validated + 'Z').toLocaleString()
        : 'Never';
      const label = c.label || 'Default';
      // Without the exchange name, four connections labelled Main / Advanced /
      // Spot / Crypto give no clue which account is which.
      const meta = this.supportedExchanges.find(e => e.id === c.exchange_name);
      const exchangeName = (meta?.name || c.exchange_name || '')
        .replace(/\s*\(beta\)\s*/i, '');

      return `<div class="connection-card" data-conn-id="${c.id}">
        <div class="connection-main">
          <div class="connection-top">
            <span class="exchange-badge exchange-${this.escapeHtml(c.exchange_name)}">${this.escapeHtml(exchangeName)}</span>
            <span class="connection-label">${this.escapeHtml(label)}</span>
            <span class="status-badge ${statusClass}">${statusText}</span>${sandboxBadge}
          </div>
          <span class="connection-sub">Last checked: ${this.escapeHtml(lastValidated)}</span>
        </div>
        <div class="connection-actions">
          <button class="btn-sm" data-action="validate" data-conn-id="${c.id}">
            <i class="fa-solid fa-plug"></i> Test
          </button>
          <button class="btn btn-danger btn-sm" data-action="delete" data-conn-id="${c.id}" title="Remove connection">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      </div>`;
    }).join('');

    // Attach action handlers
    list.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = (e.currentTarget as HTMLElement);
        const action = target.getAttribute('data-action');
        const connId = parseInt(target.getAttribute('data-conn-id') || '0', 10);
        if (!connId) return;

        if (action === 'validate') this.validateConnection(connId);
        else if (action === 'delete') this.deleteConnection(connId);
      });
    });
  }

  private async addConnection(): Promise<void> {
    const exchangeName = (document.getElementById('new-exchange-name') as HTMLSelectElement)?.value;
    const label = (document.getElementById('new-connection-label') as HTMLInputElement)?.value.trim();
    const apiKey = (document.getElementById('new-api-key') as HTMLInputElement)?.value.trim();
    const privateKey = (document.getElementById('new-private-key') as HTMLInputElement)?.value.trim();
    const passphrase = (document.getElementById('new-passphrase') as HTMLInputElement)?.value.trim();
    const isSandbox = (document.getElementById('new-is-sandbox') as HTMLInputElement)?.checked ?? false;

    if (!exchangeName) {
      this.showError('keys', 'Please select an exchange');
      return;
    }
    if (!apiKey || !privateKey) {
      this.showError('keys', 'Both API key and private key are required');
      return;
    }
    if (!label) {
      this.showError('keys', 'Give this connection a label — it is how you tell '
        + 'multiple connections to the same exchange apart.');
      return;
    }

    try {
      await ExchangeController.addConnection(exchangeName, label, apiKey, privateKey, passphrase || undefined, isSandbox);
      this.showSuccess('keys', 'Exchange connection added. Validating...');

      // Clear form
      (document.getElementById('new-api-key') as HTMLInputElement).value = '';
      (document.getElementById('new-private-key') as HTMLInputElement).value = '';
      (document.getElementById('new-passphrase') as HTMLInputElement).value = '';
      (document.getElementById('new-connection-label') as HTMLInputElement).value = '';
      (document.getElementById('new-is-sandbox') as HTMLInputElement).checked = false;

      // Reload and refresh state
      await this.loadConnections();
      await UserController.refreshKeyStatus();

      // Auto-validate the last added connection
      if (this.connections.length > 0) {
        const newest = this.connections[this.connections.length - 1];
        this.validateConnection(newest.id);
      }
    } catch (error: any) {
      this.showError('keys', error.message || 'Failed to add connection');
    }
  }

  private async validateConnection(connectionId: number): Promise<void> {
    const btn = document.querySelector(`[data-action="validate"][data-conn-id="${connectionId}"]`) as HTMLButtonElement;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Testing...';
    }
    try {
      const result = await ExchangeController.validateConnection(connectionId);
      if (result.valid) {
        this.showSuccess('keys', 'Connection validated successfully!');
        await ExchangeStore.loadConnections();
        if (ExchangeStore.activeMode === null && ExchangeStore.connections.length > 0) {
          ExchangeStore.start('all');
        }
      } else {
        this.showError('keys', result.error || 'Connection validation failed');
      }
      await this.loadConnections();
      await UserController.refreshKeyStatus();
    } catch (error: any) {
      this.showError('keys', error.message || 'Failed to validate connection');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-plug"></i> Test';
      }
    }
  }

  private async deleteConnection(connectionId: number): Promise<void> {
    try {
      await ExchangeController.deleteConnection(connectionId);
      this.showSuccess('keys', 'Connection removed');
      await this.loadConnections();
      await UserController.refreshKeyStatus();
      await ExchangeStore.loadConnections();
    } catch (error: any) {
      this.showError('keys', error.message || 'Failed to delete connection');
    }
  }

  private async saveNotifications(enabled: boolean): Promise<void> {
    try {
      NotificationService.setEnabled(enabled);
      await UserController.updateNotifications(enabled);
      this.showSuccess('notifications', `Desktop notifications ${enabled ? 'enabled' : 'disabled'}`);
    } catch (error: any) {
      this.showError('notifications', error.message || 'Failed to save notification preference');
      // Revert toggle on failure
      const toggle = document.getElementById('notifications-toggle') as HTMLInputElement;
      if (toggle) toggle.checked = !enabled;
      NotificationService.setEnabled(!enabled);
    }
  }

  private async saveDonationModal(enabled: boolean): Promise<void> {
    try {
      const modal = document.getElementById('donation-widget');
      if (modal) 
        modal.style.display = enabled ? 'block' : 'none';
      await UserController.updateDonationModal(enabled);
      this.showSuccess('donation-modal', `Donation modal ${enabled ? 'enabled' : 'disabled'}`);
    } catch (error: any) {
        this.showError('donation-modal', error.message || 'Failed to save donation modal preference');
      const toggle = document.getElementById('donation-modal-toggle') as HTMLInputElement;
      if (toggle) toggle.checked = !enabled;
    }
  }

  private async saveTheme(theme: string): Promise<void> {
    try {
      applyTheme(theme);
      await UserController.updateTheme(theme);
      this.showSuccess('notifications', `Theme switched to ${theme} mode`);
    } catch (error: any) {
      this.showError('notifications', error.message || 'Failed to save theme preference');
      const revert = theme === 'dark' ? 'light' : 'dark';
      applyTheme(revert);
      const toggle = document.getElementById('theme-toggle') as HTMLInputElement;
      if (toggle) toggle.checked = revert === 'dark';
    }
  }

  private async saveActive(isActive: boolean): Promise<void> {
    try {
      await UserController.updateActive(isActive);
      const warning = document.getElementById('inactive-warning');
      if (warning) warning.classList.toggle('d-none', isActive);
      this.showSuccess('notifications', isActive ? 'Account activated' : 'Account deactivated');
    } catch (error: any) {
      this.showError('notifications', error.message || 'Failed to update account status');
      const toggle = document.getElementById('active-toggle') as HTMLInputElement;
      if (toggle) toggle.checked = !isActive;
    }
  }

  private collectEmailSettings(forceEnabled?: boolean): EmailNotificationSettings {
    const enabled = forceEnabled ?? ((document.getElementById('email-notifications-toggle') as HTMLInputElement)?.checked ?? false);
    const email = (document.getElementById('email-address') as HTMLInputElement)?.value.trim() ?? '';
    const password = (document.getElementById('email-app-password') as HTMLInputElement)?.value ?? '';
    const host = (document.getElementById('email-smtp-host') as HTMLInputElement)?.value.trim() ?? '';
    const portRaw = (document.getElementById('email-smtp-port') as HTMLInputElement)?.value.trim() ?? '';

    const settings: EmailNotificationSettings = {
      email_notifications_enabled: enabled,
      notify_email: email,
    };
    if (password) settings.smtp_password = password;       // only sent when changed
    if (host) settings.smtp_host = host;
    if (portRaw) settings.smtp_port = parseInt(portRaw, 10);
    return settings;
  }

  private async saveEmailSettings(): Promise<void> {
    const settings = this.collectEmailSettings();

    if (settings.email_notifications_enabled && !settings.notify_email) {
      this.showError('email', 'Enter an email address to enable email notifications');
      return;
    }

    try {
      const user = await UserController.updateEmailNotifications(settings);
      // Clear the password field after saving and reflect stored state.
      const pwInput = document.getElementById('email-app-password') as HTMLInputElement;
      if (pwInput) {
        pwInput.value = '';
        pwInput.placeholder = user.smtp_password_set ? 'Saved — leave blank to keep' : 'Enter app password';
      }
      this.showSuccess('email', 'Email notification settings saved');
    } catch (error: any) {
      this.showError('email', error.message || 'Failed to save email settings');
    }
  }

  private async sendTestEmail(): Promise<void> {
    const settings = this.collectEmailSettings(true);
    if (!settings.notify_email) {
      this.showError('email', 'Enter an email address first');
      return;
    }

    const btn = document.getElementById('test-email-btn') as HTMLButtonElement;
    const original = btn?.innerHTML;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending...';
    }
    try {
      const msg = await UserController.testEmail(settings);
      this.showSuccess('email', msg || 'Test email sent');
    } catch (error: any) {
      this.showError('email', error.message || 'Failed to send test email');
    } finally {
      if (btn) {
        btn.disabled = false;
        if (original) btn.innerHTML = original;
      }
    }
  }

  private async sendTestReport(): Promise<void> {
    const btn = document.getElementById('test-report-btn') as HTMLButtonElement;
    const original = btn?.innerHTML;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Building &amp; sending...';
    }
    try {
      const msg = await MonthlyReport.sendTest();
      this.showSuccess('report', msg || 'Test report sent');
    } catch (error: any) {
      this.showError('report', error.message || 'Failed to send test report');
    } finally {
      if (btn) {
        btn.disabled = false;
        if (original) btn.innerHTML = original;
      }
    }
  }

  private async saveUsername(): Promise<void> {
    const input = document.getElementById('profile-username') as HTMLInputElement;
    const username = input?.value.trim();

    if (!username || username.length < 3) {
      this.showError('username', 'Username must be at least 3 characters');
      return;
    }

    try {
      await UserController.updateUsername(username);
      this.showSuccess('username', 'Username updated successfully');
    } catch (error: any) {
      this.showError('username', error.message || 'Failed to update username');
    }
  }

  private async savePassword(): Promise<void> {
    const currentPassword = (document.getElementById('profile-current-password') as HTMLInputElement)?.value;
    const newPassword = (document.getElementById('profile-new-password') as HTMLInputElement)?.value;
    const confirmPassword = (document.getElementById('profile-confirm-password') as HTMLInputElement)?.value;

    if (!currentPassword || !newPassword || !confirmPassword) {
      this.showError('password', 'All password fields are required');
      return;
    }

    if (newPassword.length < 6) {
      this.showError('password', 'New password must be at least 6 characters');
      return;
    }

    if (newPassword !== confirmPassword) {
      this.showError('password', 'New passwords do not match');
      return;
    }

    try {
      await UserController.updatePassword(currentPassword, newPassword);
      this.showSuccess('password', 'Password updated successfully');
      (document.getElementById('profile-current-password') as HTMLInputElement).value = '';
      (document.getElementById('profile-new-password') as HTMLInputElement).value = '';
      (document.getElementById('profile-confirm-password') as HTMLInputElement).value = '';
    } catch (error: any) {
      this.showError('password', error.message || 'Failed to update password');
    }
  }

  private showSuccess(_section: string, message: string): void {
    this.showAlert(message, false);
  }

  private showError(_section: string, message: string): void {
    this.showAlert(message, true);
  }

  /**
   * One alert strip at the top of the page rather than a pair per section.
   * The section argument is kept so every call site reads the same, but with
   * tabbed panes a per-section alert could land on a pane you can't see.
   */
  private showAlert(message: string, isError: boolean): void {
    const el = document.getElementById('profile-alert');
    const msgEl = el?.querySelector('span');
    const icon = el?.querySelector('i');
    if (!el || !msgEl) return;

    msgEl.textContent = message;
    el.classList.toggle('is-error', isError);
    if (icon) {
      icon.className = isError
        ? 'fa-solid fa-triangle-exclamation'
        : 'fa-solid fa-circle-check';
    }
    el.classList.remove('d-none');
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

    window.clearTimeout(this.alertTimer);
    this.alertTimer = window.setTimeout(() => el.classList.add('d-none'), 5000);
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  }
}

new ProfileController();

})();