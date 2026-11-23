// Alpaca market-data key for the Charts page's Stocks source (Profile → Exchanges).

interface StockKeyStatus {
  configured: boolean;
  /** Alpaca data feed in use ('iex' on the free plan). */
  feed: string;
}

class StockKeyData {
  static async getStatus(token: string): Promise<ApiResponse<StockKeyStatus>> {
    return DataAccess.get<StockKeyStatus>(`${AppConfig.API_BASE}/market/stocks/status`, token);
  }

  static async saveKey(keyId: string, secret: string, token: string): Promise<ApiResponse<StockKeyStatus>> {
    return DataAccess.put(`${AppConfig.API_BASE}/market/stocks/key`, { key_id: keyId, secret }, token);
  }

  static async deleteKey(token: string): Promise<ApiResponse<StockKeyStatus>> {
    return DataAccess.del(`${AppConfig.API_BASE}/market/stocks/key`, token);
  }
}
