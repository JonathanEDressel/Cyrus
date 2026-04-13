(function() {

class AccountsController {
  private accounts: AccountSummary[] = [];

  constructor() {
    this.init();
  }

  private init(): void {
    this.attachEventListeners();
    this.loadAccounts();
  }

  private attachEventListeners(): void {
    const backBtn = document.getElementById('back-to-login-btn');
    backBtn?.addEventListener('click', () => router.navigate('login'));
  }

  private setErrorMsg(msg: string): void {
    const errorAlert = document.getElementById('error-alert');
    const errorMessage = document.getElementById('error-message');
    if (errorAlert && errorMessage) {
      if (msg) {
        errorMessage.textContent = msg;
        errorAlert.classList.remove('d-none');
      } else {
        errorAlert.classList.add('d-none');
      }
    }
  }

  private formatDate(dateStr: string | null): string {
    if (!dateStr) return '—';
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
      return dateStr;
    }
  }

  async loadAccounts(): Promise<void> {
    const loading = document.getElementById('accounts-loading');
    const empty = document.getElementById('accounts-empty');
    const tableWrapper = document.getElementById('accounts-table-wrapper');

    try {
      const response = await AuthData.getAccounts();
      this.accounts = response.data;

      loading?.classList.add('d-none');

      if (!this.accounts || this.accounts.length === 0) {
        empty?.classList.remove('d-none');
        tableWrapper?.classList.add('d-none');
        return;
      }

      empty?.classList.add('d-none');
      tableWrapper?.classList.remove('d-none');
      this.renderAccounts();

    } catch (error: any) {
      loading?.classList.add('d-none');
      this.setErrorMsg(error.message || 'Failed to load accounts. Make sure the backend is running.');
    }
  }

  private renderAccounts(): void {
    const tbody = document.getElementById('accounts-list');
    if (!tbody) return;

    tbody.innerHTML = this.accounts.map(account => `
      <tr>
        <td class="account-username">
          <i class="fa-solid fa-user me-2" style="color: #06b6d4;"></i>
          ${this.escapeHtml(account.username)}
        </td>
        <td class="account-commands">${account.command_count}</td>
        <td class="account-created">${this.formatDate(account.created_at)}</td>
        <td>
          <label class="toggle-switch" title="${account.is_active ? 'Deactivate' : 'Activate'}">
            <input type="checkbox" class="toggle-input" data-user-id="${account.id}"
                   ${account.is_active ? 'checked' : ''}>
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
          </label>
        </td>
      </tr>
    `).join('');

    // Attach toggle handlers
    const toggleInputs = tbody.querySelectorAll('.toggle-input');
    toggleInputs.forEach(input => {
      input.addEventListener('change', (e) => {
        const userId = parseInt((e.currentTarget as HTMLElement).getAttribute('data-user-id') || '0', 10);
        if (userId) this.toggleActive(userId);
      });
    });
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  async toggleActive(userId: number): Promise<void> {
    this.setErrorMsg('');
    try {
      const response = await AuthData.toggleAccountActive(userId);
      const updated = response.data;

      // Update local state
      const idx = this.accounts.findIndex(a => a.id === userId);
      if (idx !== -1) {
        this.accounts[idx].is_active = updated.is_active;
      }

      this.renderAccounts();

    } catch (error: any) {
      this.setErrorMsg(error.message || 'Failed to update account status.');
    }
  }
}

new AccountsController();

})();
