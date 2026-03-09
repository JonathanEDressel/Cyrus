// User controller — business logic layer for user management
// Calls UserData for raw API access, uses AuthController for token

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
}
