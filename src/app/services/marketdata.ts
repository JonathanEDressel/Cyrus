class MarketData {
  static async getPairs(token: string): Promise<ApiResponse<any[]>> {
    return DataAccess.get<any[]>(
      `${AppConfig.API_BASE}/market/pairs`,
      token
    );
  }

  static async getOHLCV(token: string, symbol: string, range: string): Promise<ApiResponse<any[]>> {
    const params = new URLSearchParams({ symbol, range });
    return DataAccess.get<any[]>(
      `${AppConfig.API_BASE}/market/ohlcv?${params.toString()}`,
      token
    );
  }

  /** Held assets joined with their fundamentals (market cap, supply, ATH). */
  static async getHoldings(token: string, connId: number | 'all' = 'all'): Promise<ApiResponse<any>> {
    const params = new URLSearchParams({ conn_id: String(connId) });
    return DataAccess.get<any>(
      `${AppConfig.API_BASE}/market/holdings?${params.toString()}`,
      token
    );
  }

  /** Deep detail for one asset, including exchange-side price history. */
  static async getAssetDetail(token: string, symbol: string): Promise<ApiResponse<any>> {
    return DataAccess.get<any>(
      `${AppConfig.API_BASE}/market/asset/${encodeURIComponent(symbol)}`,
      token
    );
  }

  static async getTicker(token: string, symbol: string): Promise<ApiResponse<any>> {
    const params = new URLSearchParams({ symbol });
    return DataAccess.get<any>(
      `${AppConfig.API_BASE}/market/ticker?${params.toString()}`,
      token
    );
  }
}
