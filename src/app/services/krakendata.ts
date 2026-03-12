class KrakenData {
  static async getOpenOrders(token: string): Promise<ApiResponse<any[]>> {
    return DataAccess.get<any[]>(
      `${AppConfig.API_BASE}/kraken/open-orders`,
      token
    );
  }

  static async getWithdrawalAddresses(token: string): Promise<ApiResponse<any[]>> {
    return DataAccess.get<any[]>(
      `${AppConfig.API_BASE}/kraken/withdrawal-addresses`,
      token
    );
  }

  static async getBalance(token: string): Promise<ApiResponse<Record<string, string>>> {
    return DataAccess.get<Record<string, string>>(
      `${AppConfig.API_BASE}/kraken/balance`,
      token
    );
  }
}
