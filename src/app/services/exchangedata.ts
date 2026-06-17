class ExchangeData {
  // ---- Exchange connections management ----

  static async getSupportedExchanges(token: string): Promise<ApiResponse<any[]>> {
    return DataAccess.get<any[]>(
      `${AppConfig.API_BASE}/exchanges/supported`,
      token
    );
  }

  static async getConnections(token: string): Promise<ApiResponse<any[]>> {
    return DataAccess.get<any[]>(
      `${AppConfig.API_BASE}/exchanges/connections`,
      token
    );
  }

  static async addConnection(token: string, data: { exchange_name: string; label: string; api_key: string; private_key: string; passphrase?: string; is_sandbox?: boolean }): Promise<ApiResponse<any>> {
    return DataAccess.post<any>(
      `${AppConfig.API_BASE}/exchanges/connections`,
      data,
      token
    );
  }

  static async updateConnection(token: string, connectionId: number, data: { api_key: string; private_key: string; passphrase?: string }): Promise<ApiResponse<any>> {
    return DataAccess.put<any>(
      `${AppConfig.API_BASE}/exchanges/connections/${connectionId}`,
      data,
      token
    );
  }

  static async deleteConnection(token: string, connectionId: number): Promise<ApiResponse<any>> {
    return DataAccess.del<any>(
      `${AppConfig.API_BASE}/exchanges/connections/${connectionId}`,
      token
    );
  }

  static async validateConnection(token: string, connectionId: number): Promise<ApiResponse<any>> {
    return DataAccess.post<any>(
      `${AppConfig.API_BASE}/exchanges/connections/${connectionId}/validate`,
      {},
      token
    );
  }

  // ---- Exchange data (per-connection) ----

  static async getOpenOrders(token: string, connectionId: number): Promise<ApiResponse<any[]>> {
    return DataAccess.get<any[]>(
      `${AppConfig.API_BASE}/exchange/${connectionId}/open-orders`,
      token
    );
  }

  static async getWithdrawalAddresses(token: string, connectionId: number): Promise<ApiResponse<any[]>> {
    return DataAccess.get<any[]>(
      `${AppConfig.API_BASE}/exchange/${connectionId}/withdrawal-addresses`,
      token
    );
  }

  static async getBalance(token: string, connectionId: number): Promise<ApiResponse<Record<string, string>>> {
    return DataAccess.get<Record<string, string>>(
      `${AppConfig.API_BASE}/exchange/${connectionId}/balance`,
      token
    );
  }

  static async getPortfolio(token: string, connectionId: number): Promise<ApiResponse<PortfolioData>> {
    return DataAccess.get<PortfolioData>(
      `${AppConfig.API_BASE}/exchange/${connectionId}/portfolio`,
      token
    );
  }
}

interface PortfolioPosition {
  asset: string;
  amount: number;
  usd_value: number;
}

interface PortfolioData {
  positions: PortfolioPosition[];
  total_usd: number;
}
