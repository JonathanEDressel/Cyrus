(function () {

class ProfileController {
  private connections: ExchangeConnection[] = [];
  private supportedExchanges: any[] = [];

  constructor() {
    this.init();
  }

  private init(): void {
    this.loadProfile();
    this.loadConnections();
    this.loadSupportedExchanges();
    this.attachEventListeners();
  }

  private attachEventListeners(): void {
    document.getElementById('save-username-btn')?.addEventListener('click', () => this.saveUsername());
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
    });
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
      NotificationService.setEnabled(user.notifications_enabled !== false);
    } catch (error: any) {
      this.showError('username', error.message || 'Failed to load profile');
    }
  }

  private async loadSupportedExchanges(): Promise<void> {
    try {
      this.supportedExchanges = await ExchangeController.getSupportedExchanges();
      this.refreshExchangeDropdown();
    } catch {
      const select = document.getElementById('new-exchange-name') as HTMLSelectElement;
      if (select) select.innerHTML = '<option value="" disabled selected>Failed to load exchanges</option>';
    }
  }

  private refreshExchangeDropdown(): void {
    const select = document.getElementById('new-exchange-name') as HTMLSelectElement;
    if (!select) return;

    const addedIds = new Set(this.connections.map(c => c.exchange_name));
    const available = this.supportedExchanges.filter(ex => !addedIds.has(ex.id));

    select.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.selected = true;
    placeholder.textContent = available.length === 0 ? 'All exchanges already added' : 'Select an exchange...';
    select.appendChild(placeholder);

    for (const ex of available) {
      const opt = document.createElement('option');
      opt.value = ex.id;
      opt.textContent = ex.name;
      select.appendChild(opt);
    }

    const addBtn = document.getElementById('add-connection-btn') as HTMLButtonElement;
    if (addBtn) addBtn.disabled = available.length === 0;
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

    if (this.connections.length === 0) {
      list.innerHTML = '<p class="text-muted">No exchange connections configured yet. Add one below.</p>';
      return;
    }

    list.innerHTML = this.connections.map(c => {
      const statusClass = c.is_validated ? 'status-active' : 'status-inactive';
      const statusText = c.is_validated ? 'Validated' : 'Not Validated';
      const sandboxBadge = c.is_sandbox ? '<span class="badge bg-warning text-dark ms-2">Sandbox</span>' : '';
      const lastValidated = c.keys_last_validated
        ? new Date(c.keys_last_validated.endsWith('Z') ? c.keys_last_validated : c.keys_last_validated + 'Z').toLocaleString()
        : 'Never';
      const label = c.label || 'Default';

      return `<div class="connection-card" data-conn-id="${c.id}">
        <div class="connection-info mb-4">
          <span class="connection-label">${this.escapeHtml(label)} - </span>
          <span class="status-badge ${statusClass}">${statusText}</span>${sandboxBadge}
          <span class="text-muted small">Last checked: ${this.escapeHtml(lastValidated)}</span>
        </div>
        <div class="connection-actions">
          <button class="btn btn-secondary btn-sm" data-action="validate" data-conn-id="${c.id}">
            <i class="fa-solid fa-plug"></i> Test
          </button>
          <button class="btn btn-danger btn-sm" data-action="delete" data-conn-id="${c.id}">
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

    try {
      await ExchangeController.addConnection(exchangeName, label || 'Default', apiKey, privateKey, passphrase || undefined, isSandbox);
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

  private showSuccess(section: string, message: string): void {
    const errEl = document.querySelector(`[data-alert="${section}-error"]`);
    if (errEl) errEl.classList.add('d-none');
    const el = document.querySelector(`[data-alert="${section}-success"]`);
    const msgEl = el?.querySelector('span');
    if (el && msgEl) {
      msgEl.textContent = message;
      el.classList.remove('d-none');
      setTimeout(() => el.classList.add('d-none'), 4000);
    }
  }

  private showError(section: string, message: string): void {
    const successEl = document.querySelector(`[data-alert="${section}-success"]`);
    if (successEl) successEl.classList.add('d-none');
    const el = document.querySelector(`[data-alert="${section}-error"]`);
    const msgEl = el?.querySelector('span');
    if (el && msgEl) {
      msgEl.textContent = message;
      el.classList.remove('d-none');
      setTimeout(() => el.classList.add('d-none'), 4000);
    }
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  }
}

new ProfileController();

})();