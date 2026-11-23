/** A saved chart as the list returns it (no state). */
interface ChartSummary {
  id: number;
  name: string;
  symbols: string[];
  timeframe: string | null;
  created_at: string;
  updated_at: string;
}

/** A saved chart with its full state, as get/create/update return it. */
interface SavedChart {
  id: number;
  name: string;
  state: ChartState | null;
  created_at: string;
  updated_at: string;
}

/** Saved charts for the Charts page and the Overview's Chart widget. */
class ChartData {
  private static token(): string {
    const token = AuthController.getToken();
    if (!token) throw new Error('Not signed in');
    return token;
  }

  static async list(): Promise<ApiResponse<ChartSummary[]>> {
    return DataAccess.get<ChartSummary[]>(`${AppConfig.API_BASE}/charts/`, ChartData.token());
  }

  static async get(id: number): Promise<ApiResponse<SavedChart>> {
    return DataAccess.get<SavedChart>(`${AppConfig.API_BASE}/charts/${id}`, ChartData.token());
  }

  static async create(name: string, state: ChartState): Promise<ApiResponse<SavedChart>> {
    return DataAccess.post<SavedChart>(`${AppConfig.API_BASE}/charts/`, { name, state }, ChartData.token());
  }

  static async update(id: number, changes: { name?: string; state?: ChartState }): Promise<ApiResponse<SavedChart>> {
    return DataAccess.put<SavedChart>(`${AppConfig.API_BASE}/charts/${id}`, changes, ChartData.token());
  }

  static async remove(id: number): Promise<ApiResponse<any>> {
    return DataAccess.del<any>(`${AppConfig.API_BASE}/charts/${id}`, ChartData.token());
  }
}
