(function() {

// Create account view model
// Dependencies loaded via index.html: AppConfig, DataAccess, AuthData, AuthController, Router
class CreateAccountController {
  private username: string = "";
  private password: string = "";
  private confirmPassword: string = "";
  private krakenApiKey: string = "";
  private krakenPrivateKey: string = "";
  private ErrorMsg: string = "";
  private SuccessMsg: string = "";

  constructor() {
    this.init();
  }

  private init(): void {
    this.attachEventListeners();
  }

  private attachEventListeners(): void {
    const createBtn = document.getElementById('create-account-btn');
    const backBtn = document.getElementById('back-to-login-btn');
    const confirmPasswordInput = document.getElementById('confirmPassword') as HTMLInputElement;

    createBtn?.addEventListener('click', () => this.createAccount());
    backBtn?.addEventListener('click', () => this.returnToLogin());

    confirmPasswordInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.createAccount();
    });

    const krakenPrivateKeyInput = document.getElementById('krakenPrivateKey') as HTMLInputElement;
    krakenPrivateKeyInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.createAccount();
    });
  }

  // ---- UI helpers ----

  private setErrorMsg(msg: string): void {
    this.ErrorMsg = msg;
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

  private setSuccessMsg(msg: string): void {
    this.SuccessMsg = msg;
    const successAlert = document.getElementById('success-alert');
    const successMessage = document.getElementById('success-message');

    if (successAlert && successMessage) {
      if (msg) {
        successMessage.textContent = msg;
        successAlert.classList.remove('d-none');
      } else {
        successAlert.classList.add('d-none');
      }
    }
  }

  // ---- Navigation (uses router) ----

  returnToLogin(): void {
    router.navigate('login');
  }

  // ---- Validation ----

  private validateForm(): boolean {
    const usernameInput = document.getElementById('username') as HTMLInputElement;
    const passwordInput = document.getElementById('password') as HTMLInputElement;
    const confirmPasswordInput = document.getElementById('confirmPassword') as HTMLInputElement;
    const krakenApiKeyInput = document.getElementById('krakenApiKey') as HTMLInputElement;
    const krakenPrivateKeyInput = document.getElementById('krakenPrivateKey') as HTMLInputElement;

    this.username = usernameInput.value.trim();
    this.password = passwordInput.value;
    this.confirmPassword = confirmPasswordInput.value;
    this.krakenApiKey = krakenApiKeyInput.value.trim();
    this.krakenPrivateKey = krakenPrivateKeyInput.value.trim();

    if (!this.username) {
      this.setErrorMsg("Please enter a username");
      return false;
    }

    if (!this.password || this.password.length < 6) {
      this.setErrorMsg("Password must be at least 6 characters");
      return false;
    }

    if (this.password !== this.confirmPassword) {
      this.setErrorMsg("Passwords do not match");
      return false;
    }

    if (!this.krakenApiKey) {
      this.setErrorMsg("Please enter your Kraken API key");
      return false;
    }

    if (!this.krakenPrivateKey) {
      this.setErrorMsg("Please enter your Kraken private key");
      return false;
    }

    return true;
  }

  // ---- Actions (delegate to service controllers) ----

  async createAccount(): Promise<void> {
    this.setErrorMsg("");
    this.setSuccessMsg("");

    if (!this.validateForm()) {
      return;
    }

    const createBtn = document.getElementById('create-account-btn') as HTMLButtonElement;
    const btnText = document.getElementById('btn-text');

    if (createBtn && btnText) {
      createBtn.disabled = true;
      btnText.textContent = 'Creating Account...';
    }

    try {
      await AuthController.register(
        this.username,
        this.password,
        this.krakenApiKey,
        this.krakenPrivateKey
      );

      this.setSuccessMsg('Account created successfully! Redirecting to login...');

      setTimeout(() => {
        router.navigate('login', { signup: 'success', username: this.username });
      }, 2000);

    } catch (error: any) {
      this.setErrorMsg(error.message || 'Cannot connect to server. Make sure the backend is running.');
    } finally {
      if (createBtn && btnText) {
        createBtn.disabled = false;
        btnText.textContent = 'Create Account';
      }
    }
  }
}

// Execute immediately — DOM is already present (injected by router)
new CreateAccountController();

})();