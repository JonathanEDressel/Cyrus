class AuthData {
  /**
   * POST /api/auth/login
   * Sends username/password, returns token + user data
   */
  static async login(request: LoginRequest): Promise<ApiResponse<LoginResponse>> {
    return DataAccess.post<LoginResponse>(
      `${AppConfig.API_BASE}/auth/login`,
      request
    );
  }

  /**
   * POST /api/auth/register
   * Creates a new user account
   */
  static async register(request: RegisterRequest): Promise<ApiResponse<UserModel>> {
    return DataAccess.post<UserModel>(
      `${AppConfig.API_BASE}/auth/register`,
      request
    );
  }

  /**
   * GET /api/auth/accounts
   * Returns all accounts with command counts (no auth required)
   */
  static async getAccounts(): Promise<ApiResponse<AccountSummary[]>> {
    return DataAccess.get<AccountSummary[]>(
      `${AppConfig.API_BASE}/auth/accounts`
    );
  }

  /**
   * PUT /api/auth/accounts/:id/toggle-active
   * Toggles account active status (no auth required)
   */
  static async toggleAccountActive(userId: number): Promise<ApiResponse<any>> {
    return DataAccess.put<any>(
      `${AppConfig.API_BASE}/auth/accounts/${userId}/toggle-active`,
      {}
    );
  }
}
