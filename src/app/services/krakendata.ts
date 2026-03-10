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
}
