/** A custom indicator: a Pine Script the user wrote or pasted. */
interface CustomIndicatorRow {
  id: number;
  name: string;
  source: string;
  created_at: string;
  updated_at: string;
}

/** The user's Pine Script indicators (see IndicatorController.py). */
class IndicatorData {
  private static token(): string {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not signed in');
    return token;
  }

  static async list(): Promise<ApiResponse<CustomIndicatorRow[]>> {
    return DataAccess.get<CustomIndicatorRow[]>(`${AppConfig.API_BASE}/indicators/`, IndicatorData.token());
  }

  static async create(name: string, source: string): Promise<ApiResponse<CustomIndicatorRow>> {
    return DataAccess.post<CustomIndicatorRow>(`${AppConfig.API_BASE}/indicators/`, { name, source }, IndicatorData.token());
  }

  static async update(id: number, changes: { name?: string; source?: string }): Promise<ApiResponse<CustomIndicatorRow>> {
    return DataAccess.put<CustomIndicatorRow>(`${AppConfig.API_BASE}/indicators/${id}`, changes, IndicatorData.token());
  }

  static async remove(id: number): Promise<ApiResponse<any>> {
    return DataAccess.del<any>(`${AppConfig.API_BASE}/indicators/${id}`, IndicatorData.token());
  }
}
