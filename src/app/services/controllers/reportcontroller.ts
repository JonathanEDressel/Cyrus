class ReportController {
  static async getStatus(): Promise<any> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    const response = await ReportData.getStatus(token);
    return response.data;
  }

  static async sendMonthly(payload: any): Promise<string> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    const response = await ReportData.sendMonthly(token, payload);
    return response.result || 'Report sent';
  }
}
