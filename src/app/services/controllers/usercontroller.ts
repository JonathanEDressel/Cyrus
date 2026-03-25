// User controller — business logic layer for user management

type ConnectionStatus = 'none' | 'has_unvalidated' | 'valid' | 'checking' | 'unknown';

class ApiKeyState {
  private static _status: ConnectionStatus = 'unknown';
  private static _error: string | null = null;
  private static _listeners: Array<() => void> = [];

  static get status(): ConnectionStatus { return ApiKeyState._status; }
  static get error(): string | null { return ApiKeyState._error; }

  static setStatus(status: ConnectionStatus, error?: string): void {
    ApiKeyState._status = status;
    ApiKeyState._error = error || null;
    ApiKeyState._notify();
  }

  static onChange(callback: () => void): () => void {
    ApiKeyState._listeners.push(callback);
    return () => {
      ApiKeyState._listeners = ApiKeyState._listeners.filter(cb => cb !== callback);
    };
  }

  static reset(): void {
    ApiKeyState._status = 'unknown';
    ApiKeyState._error = null;
    ApiKeyState._listeners = [];
  }

  private static _notify(): void {
    for (const cb of ApiKeyState._listeners) {
      try { cb(); } catch (_) {}
    }
  }
}

class UserController {
  static async getProfile(): Promise<UserModel> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    const response = await UserData.getProfile(token);
    return response.data;
  }

  static async updateUsername(username: string): Promise<UserModel> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    const response = await UserData.updateUsername(username, token);
    localStorage.setItem(AppConfig.USER_KEY, JSON.stringify(response.data));
    return response.data;
  }

  static async updatePassword(currentPassword: string, newPassword: string): Promise<void> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    await UserData.updatePassword(currentPassword, newPassword, token);
  }

  static async deleteAccount(): Promise<void> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    await UserData.deleteAccount(token);
    AuthController.logout();
  }

  static async updateNotifications(enabled: boolean): Promise<void> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    await UserData.updateNotifications(enabled, token);
  }

  static async updateDonationModal(enabled: boolean): Promise<void> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    await UserData.updateDonationModal(enabled, token);
  }

  /**
   * Load connection status from user profile.
   * Sets ApiKeyState based on exchange_connections.
   */
  static async refreshKeyStatus(): Promise<void> {
    try {
      const user = await UserController.getProfile();
      if (!user.exchange_connections || user.exchange_connections.length === 0) {
        ApiKeyState.setStatus('none');
      } else if (user.has_validated_connection) {
        ApiKeyState.setStatus('valid');
      } else {
        ApiKeyState.setStatus('has_unvalidated');
      }
    } catch (_) {
      // Can't reach backend, leave state as-is
    }
  }
}
