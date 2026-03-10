class KrakenController {
  static async getOpenOrders(): Promise<any[]> {
    const token = AuthController.getToken();
    if (!token) {
      throw new Error('Not authenticated');
    }
    const response = await KrakenData.getOpenOrders(token);
    return response.data;
  }

  static async getWithdrawalAddresses(): Promise<any[]> {
    const token = AuthController.getToken();
    if (!token) {
      throw new Error('Not authenticated');
    }
    const response = await KrakenData.getWithdrawalAddresses(token);
    return response.data;
  }
}
