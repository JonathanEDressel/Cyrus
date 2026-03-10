class AutomationData {
  static async getRules(token: string): Promise<ApiResponse<any[]>> {
    return DataAccess.get<any[]>(
      `${AppConfig.API_BASE}/automation/rules`,
      token
    );
  }

  static async createRule(token: string, rule: any): Promise<ApiResponse<any>> {
    return DataAccess.post<any>(
      `${AppConfig.API_BASE}/automation/rules`,
      rule,
      token
    );
  }

  static async toggleRule(token: string, ruleId: number): Promise<ApiResponse<any>> {
    return DataAccess.put<any>(
      `${AppConfig.API_BASE}/automation/rules/${ruleId}/toggle`,
      {},
      token
    );
  }

  static async deleteRule(token: string, ruleId: number): Promise<ApiResponse<any>> {
    return DataAccess.del<any>(
      `${AppConfig.API_BASE}/automation/rules/${ruleId}`,
      token
    );
  }

  static async getLogs(token: string, limit: number = 50): Promise<ApiResponse<any[]>> {
    return DataAccess.get<any[]>(
      `${AppConfig.API_BASE}/automation/logs?limit=${limit}`,
      token
    );
  }
}
