(function() {

class LoginController {
  private UserPassword: string = "";
  private UserEmail: string = "";
  private ErrorMsg: string = "";
  private SuccessMsg: string = "";

  constructor() {
    this.init();
  }

  private init(): void {
    this.attachEventListeners();
    this.checkRouteParams();
  }

  private attachEventListeners(): void {
    const loginBtn = document.getElementById('user-login-btn');
    const passwordInput = document.getElementById('password') as HTMLInputElement;

    loginBtn?.addEventListener('click', () => this.login());
    passwordInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.login();
    });

    const forgotPasswordLink = document.getElementById('forgot-password-link');
    const createAccountBtn = document.getElementById('create-account-btn');
    const viewAccountsBtn = document.getElementById('view-accounts-btn');

    forgotPasswordLink?.addEventListener('click', (e) => {
      e.preventDefault();
      this.forgotPassword();
    });
    createAccountBtn?.addEventListener('click', () => this.createAccount());
    viewAccountsBtn?.addEventListener('click', () => router.navigate('accounts'));
  }

  private checkRouteParams(): void {
    const params: Record<string, string> = (window as any).__routeParams || {};

    if (params['signup'] === 'success') {
      this.setSuccessMsg('Account created successfully! Please log in to continue.');
      if (params['username']) {
        const emailInput = document.getElementById('email') as HTMLInputElement;
        if (emailInput) emailInput.value = params['username'];
      }
    }
  }

  // ---- UI helpers ----

  private setErrorMsg(msg: string): void {
    this.ErrorMsg = msg;
    const errorAlert = document.querySelector('.alert-warning');
    const errorMessage = document.getElementById('error-message');
    
    if (errorAlert && errorMessage) {
      if (this.ErrorMsg) {
        errorMessage.textContent = this.ErrorMsg;
        errorAlert.classList.remove('d-none');
      } else {
        errorAlert.classList.add('d-none');
      }
    }
  }

  private setSuccessMsg(msg: string): void {
    this.SuccessMsg = msg;
    const successElement = document.querySelector('.alert-success');
    if (successElement) {
      if (this.SuccessMsg) {
        successElement.innerHTML = `<i class="fa-solid fa-circle-check me-2"></i>${this.SuccessMsg}`;
        successElement.classList.remove('d-none');
      } else {
        successElement.classList.add('d-none');
      }
    }
  }

  createAccount(): void {
    router.navigate('createaccount');
  }

  forgotPassword(): void {
    router.navigate('forgotpassword');
  }

  async loadData(): Promise<void> {
    const user = await UserController.getProfile();
    if (!user) {
      console.error('Failed to load user profile');
      return;
    }

    const donationWidget = document.getElementById('donation-widget');
    if(donationWidget !== null)
      donationWidget.style.display = user.donation_modal_enabled ? 'block' : 'none';
  }

  async login(): Promise<void> {
    const emailInput = document.getElementById('email') as HTMLInputElement;
    const passwordInput = document.getElementById('password') as HTMLInputElement;

    this.UserEmail = emailInput.value;
    this.UserPassword = passwordInput.value;

    if (!this.UserEmail || !this.UserPassword) {
      this.setErrorMsg('Please enter username and password');
      return;
    }

    try {
      const user = await AuthController.login(this.UserEmail, this.UserPassword);

      this.setSuccessMsg('Login successful!');
      console.log('Login successful! - ', user);
      
      await this.loadData();

      if (user.is_active === false) {
        console.log('Account is deactivated — API calls disabled');
      }

      ApiKeyWarning.init();

      // Load connections and start ExchangeStore in 'all' mode (skip if inactive)
      if (user.is_active !== false) {
        try {
          await ExchangeStore.loadConnections();
          if (ExchangeStore.connections.length > 0) {
            ExchangeStore.start('all');
          }
        } catch {}

        NotificationService.start();
      }

      router.navigate('home');

    } catch (error: any) {
      this.setErrorMsg(error.message || 'Cannot connect to server. Make sure the backend is running.');
    }
  }
}

new LoginController();

})();
