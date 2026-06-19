class ExchangeController {
  // ---- Connection management ----

  static async getSupportedExchanges(): Promise<any[]> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    const response = await ExchangeData.getSupportedExchanges(token);
    return response.data;
  }

  static async getConnections(): Promise<ExchangeConnection[]> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    const response = await ExchangeData.getConnections(token);
    return response.data;
  }

  static async addConnection(exchangeName: string, label: string, apiKey: string, privateKey: string, passphrase?: string, isSandbox: boolean = false): Promise<any> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    const response = await ExchangeData.addConnection(token, {
      exchange_name: exchangeName,
      label,
      api_key: apiKey,
      private_key: privateKey,
      passphrase,
      is_sandbox: isSandbox,
    });
    return response.data;
  }

  static async updateConnection(connectionId: number, apiKey: string, privateKey: string, passphrase?: string): Promise<any> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    const response = await ExchangeData.updateConnection(token, connectionId, {
      api_key: apiKey,
      private_key: privateKey,
      passphrase,
    });
    return response.data;
  }

  static async deleteConnection(connectionId: number): Promise<void> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    await ExchangeData.deleteConnection(token, connectionId);
  }

  static async validateConnection(connectionId: number): Promise<any> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    const response = await ExchangeData.validateConnection(token, connectionId);
    return response.data;
  }

  // ---- Exchange data (per-connection) ----

  static async getOpenOrders(connectionId: number): Promise<any[]> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    const response = await ExchangeData.getOpenOrders(token, connectionId);
    return response.data;
  }

  static async getWithdrawalAddresses(connectionId: number): Promise<any[]> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    const response = await ExchangeData.getWithdrawalAddresses(token, connectionId);
    return response.data;
  }

  static async getBalance(connectionId: number): Promise<Record<string, string>> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    const response = await ExchangeData.getBalance(token, connectionId);
    return response.data;
  }

  static async getPortfolio(connectionId: number): Promise<{ positions: Array<{ asset: string; amount: number; usd_value: number }>; total_usd: number }> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    const response = await ExchangeData.getPortfolio(token, connectionId);
    return response.data;
  }

  static async getPortfolioHistory(range: string, connId?: number | 'all'): Promise<any> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    const response = await ExchangeData.getPortfolioHistory(token, range, connId);
    return response.data;
  }
}
