class KrakenController {
  private static checkKeyStatus(): void {
    const status = ApiKeyState.status;
    if (status === 'none') {
      throw new Error('No API keys configured. Please add your Kraken API keys in Settings.');
    }
    if (status === 'invalid') {
      throw new Error('Invalid API keys. Please check your credentials in Settings.');
    }
  }

  static async getOpenOrders(): Promise<any[]> {
    const token = AuthController.getToken();
    if (!token) {
      throw new Error('Not authenticated');
    }
    KrakenController.checkKeyStatus();
    const response = await KrakenData.getOpenOrders(token);
    return response.data;
  }

  static async getWithdrawalAddresses(): Promise<any[]> {
    const token = AuthController.getToken();
    if (!token) {
      throw new Error('Not authenticated');
    }
    KrakenController.checkKeyStatus();
    const response = await KrakenData.getWithdrawalAddresses(token);
    return response.data;
  }

  static async getBalance(): Promise<Record<string, string>> {
    const token = AuthController.getToken();
    if (!token) {
      throw new Error('Not authenticated');
    }
    KrakenController.checkKeyStatus();
    const response = await KrakenData.getBalance(token);
    return response.data;
  }
}
