class UserData {
  static async getProfile(token: string): Promise<ApiResponse<UserModel>> {
    return DataAccess.get<UserModel>(
      `${AppConfig.API_BASE}/user/profile`,
      token
    );
  }

  static async updateUsername(
    username: string,
    token: string
  ): Promise<ApiResponse<UserModel>> {
    return DataAccess.put(
      `${AppConfig.API_BASE}/user/update-username`,
      { username },
      token
    );
  }

  static async updatePassword(
    currentPassword: string,
    newPassword: string,
    token: string
  ): Promise<ApiResponse<any>> {
    return DataAccess.put(
      `${AppConfig.API_BASE}/user/update-password`,
      { currentPassword, newPassword },
      token
    );
  }

  static async deleteAccount(token: string): Promise<ApiResponse<any>> {
    return DataAccess.del(
      `${AppConfig.API_BASE}/user/delete`,
      token
    );
  }

  static async updateNotifications(enabled: boolean, token: string): Promise<ApiResponse<UserModel>> {
    return DataAccess.put(
      `${AppConfig.API_BASE}/user/update-notifications`,
      { notifications_enabled: enabled },
      token
    );
  }

  static async updateDonationModal(enabled: boolean, token: string): Promise<ApiResponse<UserModel>> {
    return DataAccess.put(
      `${AppConfig.API_BASE}/user/update-donation-modal`,
      { donation_modal_enabled: enabled },
      token
    );
  }

  static async updateTheme(theme: string, token: string): Promise<ApiResponse<UserModel>> {
    return DataAccess.put(
      `${AppConfig.API_BASE}/user/update-theme`,
      { theme },
      token
    );
  }
}
