class AutomationController {
  static async getRules(): Promise<any[]> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    const response = await AutomationData.getRules(token);
    return response.data;
  }

  static async createRule(rule: any): Promise<any> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    const response = await AutomationData.createRule(token, rule);
    return response.data;
  }

  static async toggleRule(ruleId: number): Promise<void> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    await AutomationData.toggleRule(token, ruleId);
  }

  static async deleteRule(ruleId: number): Promise<void> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    await AutomationData.deleteRule(token, ruleId);
  }

  static async getLogs(limit?: number): Promise<any[]> {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not authenticated');
    const response = await AutomationData.getLogs(token, limit);
    return response.data;
  }
}
