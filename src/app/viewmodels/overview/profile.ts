(function () {

class ProfileController {
  constructor() {
    this.init();
  }

  private init(): void {
    this.loadProfile();
    this.attachEventListeners();
  }

  private attachEventListeners(): void {
    document.getElementById('save-username-btn')?.addEventListener('click', () => this.saveUsername());
    document.getElementById('save-keys-btn')?.addEventListener('click', () => this.saveKeys());
    document.getElementById('save-password-btn')?.addEventListener('click', () => this.savePassword());
    document.getElementById('validate-keys-btn')?.addEventListener('click', () => this.validateKeys());
  }

  private async loadProfile(): Promise<void> {
    try {
      const user = await UserController.getProfile();
      const usernameInput = document.getElementById('profile-username') as HTMLInputElement;
      if (usernameInput) usernameInput.value = user.username;
    } catch (error: any) {
      this.showError('username', error.message || 'Failed to load profile');
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

  private async saveKeys(): Promise<void> {
    const apiKey = (document.getElementById('profile-api-key') as HTMLInputElement)?.value.trim();
    const privateKey = (document.getElementById('profile-private-key') as HTMLInputElement)?.value.trim();

    if (!apiKey || !privateKey) {
      this.showError('keys', 'Both API key and private key are required');
      return;
    }

    try {
      await UserController.updateKrakenKeys(apiKey, privateKey);
      this.showSuccess('keys', 'Kraken API keys updated successfully. Validating...');
      (document.getElementById('profile-api-key') as HTMLInputElement).value = '';
      (document.getElementById('profile-private-key') as HTMLInputElement).value = '';
      // Auto-validate after saving
      this.validateKeys();
    } catch (error: any) {
      this.showError('keys', error.message || 'Failed to update API keys');
    }
  }

  private async validateKeys(): Promise<void> {
    try {
      const result = await UserController.validateKeys();
      if (result.valid === true) {
        this.showSuccess('keys', 'API keys validated successfully!');
      } else if (result.valid === false) {
        this.showError('keys', result.error || 'API keys are invalid');
      } else {
        this.showError('keys', result.error || 'Unable to verify keys — please try again later');
      }
    } catch (error: any) {
      this.showError('keys', error.message || 'Failed to validate API keys');
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
}

new ProfileController();

})();