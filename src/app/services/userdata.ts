class UserData {
  /**
   * GET /api/user/profile
   * Fetches the current user's profile (requires token)
   */
  static async getProfile(token: string): Promise<ApiResponse<UserModel>> {
    return DataAccess.get<UserModel>(
      `${AppConfig.API_BASE}/user/profile`,
      token
    );
  }

  /**
   * PUT /api/user/update-password
   * Updates the user's password
   */
  static async updatePassword(
    currentPassword: string,
    newPassword: string,
    token: string
  ): Promise<ApiResponse<any>> {
    return DataAccess.put(
      `${AppConfig.API_BASE}/user/update-password`,
      { current_password: currentPassword, new_password: newPassword },
      token
    );
  }

  /**
   * PUT /api/user/update-keys
   * Updates the user's Kraken API keys
   */
  static async updateKrakenKeys(
    krakenApiKey: string,
    krakenPrivateKey: string,
    token: string
  ): Promise<ApiResponse<any>> {
    return DataAccess.put(
      `${AppConfig.API_BASE}/user/update-keys`,
      { kraken_api_key: krakenApiKey, kraken_private_key: krakenPrivateKey },
      token
    );
  }

  /**
   * DELETE /api/user/delete
   * Deletes the user account
   */
  static async deleteAccount(token: string): Promise<ApiResponse<any>> {
    return DataAccess.del(
      `${AppConfig.API_BASE}/user/delete`,
      token
    );
  }
}
