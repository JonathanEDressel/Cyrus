type ScriptAlertFrequency = 'bar_close' | 'bar' | 'once';

/** An alert on a custom indicator's alertcondition() (see ScriptAlertController.py). */
interface ScriptAlert {
  id: number;
  indicator_id: number | null;
  chart_id: number | null;
  indicator_name: string;
  source: string;
  symbol: string;
  timeframe: string;
  /** An alertcondition's key, or '*alert' for any alert() call. */
  condition_key: string;
  condition_title: string;
  /** The script as it was when the alert was made. */
  script_source: string;
  inputs: Record<string, number | boolean | string>;
  frequency: ScriptAlertFrequency;
  message: string | null;
  status: 'active' | 'paused' | 'triggered';
  last_bar_time: number | null;
  trigger_count: number;
  triggered_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ScriptAlertCreate {
  indicator_id: number | null;
  chart_id: number | null;
  indicator_name: string;
  source: string;
  symbol: string;
  timeframe: string;
  condition_key: string;
  condition_title: string;
  script_source: string;
  inputs: Record<string, number | boolean | string>;
  frequency: ScriptAlertFrequency;
  message: string;
}

class ScriptAlertData {
  private static token(): string {
    return AuthController.getToken() || '';
  }

  static async list(): Promise<ApiResponse<ScriptAlert[]>> {
    return DataAccess.get<ScriptAlert[]>(`${AppConfig.API_BASE}/script-alerts/`, ScriptAlertData.token());
  }

  static async create(body: ScriptAlertCreate): Promise<ApiResponse<ScriptAlert>> {
    return DataAccess.post<ScriptAlert>(`${AppConfig.API_BASE}/script-alerts/`, body, ScriptAlertData.token());
  }

  static async update(id: number, body: Partial<ScriptAlertCreate> & { status?: 'active' | 'paused' }): Promise<ApiResponse<ScriptAlert>> {
    return DataAccess.put<ScriptAlert>(`${AppConfig.API_BASE}/script-alerts/${id}`, body, ScriptAlertData.token());
  }

  static async remove(id: number): Promise<ApiResponse<any>> {
    return DataAccess.del<any>(`${AppConfig.API_BASE}/script-alerts/${id}`, ScriptAlertData.token());
  }

  static async fire(id: number, barTime: number, message: string): Promise<ApiResponse<{ created: boolean; alert: ScriptAlert }>> {
    return DataAccess.post<{ created: boolean; alert: ScriptAlert }>(
      `${AppConfig.API_BASE}/script-alerts/${id}/fire`, { bar_time: barTime, message }, ScriptAlertData.token());
  }
}
