class AuthController {
  /**
   * Log in a user, store token + user in localStorage on success
   * Returns the user data on success, throws on failure
   */
  static async login(username: string, password: string): Promise<UserModel> {
    const response = await AuthData.login({ username, password });

    localStorage.setItem(AppConfig.TOKEN_KEY, response.data.token);
    localStorage.setItem(AppConfig.USER_KEY, JSON.stringify(response.data.user));

    // Set initial key status from profile, then validate against Kraken
    const user = response.data.user;
    if (!user.has_keys) {
      ApiKeyState.setStatus('none');
    } else if (user.keys_validated) {
      ApiKeyState.setStatus('valid');
    } else {
      ApiKeyState.setStatus('invalid');
      // Kick off async validation (don't await — let login complete)
      UserController.validateKeys().catch(() => {});
    }

    return user;
  }

  /**
   * Register a new account
   * Returns the created user data, throws on failure
   */
  static async register(username: string, password: string, krakenApiKey: string, krakenPrivateKey: string): Promise<UserModel> {
    const response = await AuthData.register({
      username,
      password,
      krakenApiKey,
      krakenPrivateKey,
    });

    return response.data;
  }

  /**
   * Log out — clear stored session data
   */
  static logout(): void {
    KrakenStore.stop();
    ApiKeyState.reset();
    localStorage.removeItem(AppConfig.TOKEN_KEY);
    localStorage.removeItem(AppConfig.USER_KEY);
  }

  /**
   * Get the stored JWT token (or null if not logged in)
   */
  static getToken(): string | null {
    return localStorage.getItem(AppConfig.TOKEN_KEY);
  }

  /**
   * Get the stored user object (or null)
   */
  static getUser(): UserModel | null {
    const raw = localStorage.getItem(AppConfig.USER_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  /**
   * Check if a user session exists
   */
  static isAuthenticated(): boolean {
    return !!AuthController.getToken();
  }
}
