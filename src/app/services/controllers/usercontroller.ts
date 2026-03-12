// User controller — business logic layer for user management
// Calls UserData for raw API access, uses AuthController for token

type KeysStatus = 'none' | 'invalid' | 'valid' | 'checking' | 'unknown';

class ApiKeyState {
  private static _status: KeysStatus = 'unknown';
  private static _error: string | null = null;
  private static _listeners: Array<() => void> = [];

  static get status(): KeysStatus { return ApiKeyState._status; }
  static get error(): string | null { return ApiKeyState._error; }

  static setStatus(status: KeysStatus, error?: string): void {
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
  /**
   * Fetch the current user's profile from the backend
   */
  static async getProfile(): Promise<UserModel> {
    const token = AuthController.getToken();
    if (!token) {
      throw new Error('Not authenticated');
    }
    const response = await UserData.getProfile(token);
    return response.data;
  }

  /**
   * Update the user's password
   */
  static async updateUsername(username: string): Promise<UserModel> {
    const token = AuthController.getToken();
    if (!token) {
      throw new Error('Not authenticated');
    }
    const response = await UserData.updateUsername(username, token);
    localStorage.setItem(AppConfig.USER_KEY, JSON.stringify(response.data));
    return response.data;
  }

  static async updatePassword(currentPassword: string, newPassword: string): Promise<void> {
    const token = AuthController.getToken();
    if (!token) {
      throw new Error('Not authenticated');
    }
    await UserData.updatePassword(currentPassword, newPassword, token);
  }

  /**
   * Update the user's Kraken API keys
   */
  static async updateKrakenKeys(krakenApiKey: string, krakenPrivateKey: string): Promise<void> {
    const token = AuthController.getToken();
    if (!token) {
      throw new Error('Not authenticated');
    }
    await UserData.updateKrakenKeys(krakenApiKey, krakenPrivateKey, token);
  }

  /**
   * Delete the user's account and clear local session
   */
  static async deleteAccount(): Promise<void> {
    const token = AuthController.getToken();
    if (!token) {
      throw new Error('Not authenticated');
    }
    await UserData.deleteAccount(token);
    AuthController.logout();
  }

  /**
   * Validate the user's Kraken API keys against the API.
   * Updates ApiKeyState based on the response.
   * Returns the validation result.
   */
  static async validateKeys(): Promise<{ valid: boolean | null; error?: string }> {
    const token = AuthController.getToken();
    if (!token) {
      throw new Error('Not authenticated');
    }

    ApiKeyState.setStatus('checking');

    try {
      const response = await UserData.validateKeys(token);
      const data = response.data;

      if (data.valid === true) {
        ApiKeyState.setStatus('valid');
      } else if (data.valid === false) {
        ApiKeyState.setStatus(
          data.error === 'No API keys configured' ? 'none' : 'invalid',
          data.error
        );
      } else {
        // valid === null means transient error — keep previous status if it was valid
        const prev = ApiKeyState.status;
        if (prev === 'valid') {
          // Don't change — transient issue, keys were previously validated
        } else if (prev === 'checking' || prev === 'unknown') {
          ApiKeyState.setStatus('unknown', data.error);
        }
        // If prev was 'invalid' or 'none', keep that state
      }

      return data;
    } catch (err: any) {
      // Network error calling our own backend — don't change key status
      const prev = ApiKeyState.status;
      if (prev === 'checking' || prev === 'unknown') {
        ApiKeyState.setStatus('unknown', 'Unable to reach server');
      }
      throw err;
    }
  }

  /**
   * Load key status from user profile without making a Kraken API call.
   * Used on initial load to set state from cached DB values.
   */
  static async refreshKeyStatus(): Promise<void> {
    try {
      const user = await UserController.getProfile();
      if (!user.has_keys) {
        ApiKeyState.setStatus('none');
      } else if (user.keys_validated) {
        ApiKeyState.setStatus('valid');
      } else {
        ApiKeyState.setStatus('invalid');
      }
    } catch (_) {
      // Can't reach backend, leave state as-is
    }
  }
}
