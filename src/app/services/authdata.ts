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
}
