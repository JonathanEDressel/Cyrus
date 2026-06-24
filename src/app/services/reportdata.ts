interface MonthlyReportPayload {
  period: string;
  test?: boolean;
  automations: Array<{ name: string; trigger: string; action: string; status: string }>;
  open_orders: Array<{ pair: string; side: string; amount: string; price: string; status: string }>;
  rules_count: number;
  orders_count: number;
}

class ReportData {
  static async getStatus(token: string): Promise<ApiResponse<any>> {
    return DataAccess.get<any>(`${AppConfig.API_BASE}/report/monthly/status`, token);
  }

  static async sendMonthly(token: string, payload: MonthlyReportPayload): Promise<ApiResponse<any>> {
    return DataAccess.post<any>(`${AppConfig.API_BASE}/report/monthly/send`, payload, token);
  }
}
