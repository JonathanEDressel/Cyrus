class AuthController {
  static async login(username: string, password: string): Promise<UserModel> {
    const response = await AuthData.login({ username, password });

    localStorage.setItem(AppConfig.TOKEN_KEY, response.data.token);
    localStorage.setItem(AppConfig.USER_KEY, JSON.stringify(response.data.user));

    const user = response.data.user;
    if (!user.exchange_connections || user.exchange_connections.length === 0) {
      ApiKeyState.setStatus('none');
    } else if (user.has_validated_connection) {
      ApiKeyState.setStatus('valid');
    } else {
      ApiKeyState.setStatus('has_unvalidated');
    }

    return user;
  }

  static async register(username: string, password: string): Promise<UserModel> {
    const response = await AuthData.register({
      username,
      password,
    });

    return response.data;
  }

  static logout(): void {
    ExchangeStore.stop();
    NotificationService.stop();
    ApiKeyState.reset();
    localStorage.removeItem(AppConfig.TOKEN_KEY);
    localStorage.removeItem(AppConfig.USER_KEY);
  }

  static getToken(): string | null {
    return localStorage.getItem(AppConfig.TOKEN_KEY);
  }

  static getUser(): UserModel | null {
    const raw = localStorage.getItem(AppConfig.USER_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      // Corrupted/partial value — treat as logged-out rather than throwing.
      return null;
    }
  }

  static isAuthenticated(): boolean {
    return !!AuthController.getToken();
  }
}
