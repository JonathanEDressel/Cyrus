class DataAccess {
  /**
   * Parse a fetch Response into the API envelope, surfacing the real HTTP
   * status when the body isn't JSON (e.g. a Werkzeug/Flask HTML error page,
   * a proxy error, or an empty body) instead of a cryptic JSON parse error.
   */
  private static async parse<T = any>(response: Response): Promise<ApiResponse<T>> {
    let data: ApiResponse<T> | null = null;
    try {
      data = await response.json();
    } catch {
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }
      throw new Error('Invalid response from server');
    }

    if (!response.ok) {
      throw new Error(data?.result || `Request failed with status ${response.status}`);
    }
    return data as ApiResponse<T>;
  }

  private static authHeaders(token?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  /**
   * Generic GET request
   */
  static async get<T = any>(url: string, token?: string): Promise<ApiResponse<T>> {
    const response = await fetch(url, { method: 'GET', headers: DataAccess.authHeaders(token) });
    return DataAccess.parse<T>(response);
  }

  /**
   * Generic POST request
   */
  static async post<T = any>(url: string, body: any, token?: string): Promise<ApiResponse<T>> {
    const response = await fetch(url, {
      method: 'POST',
      headers: DataAccess.authHeaders(token),
      body: JSON.stringify(body),
    });
    return DataAccess.parse<T>(response);
  }

  /**
   * Generic PUT request
   */
  static async put<T = any>(url: string, body: any, token?: string): Promise<ApiResponse<T>> {
    const response = await fetch(url, {
      method: 'PUT',
      headers: DataAccess.authHeaders(token),
      body: JSON.stringify(body),
    });
    return DataAccess.parse<T>(response);
  }

  /**
   * Generic DELETE request
   */
  static async del<T = any>(url: string, token?: string): Promise<ApiResponse<T>> {
    const response = await fetch(url, { method: 'DELETE', headers: DataAccess.authHeaders(token) });
    return DataAccess.parse<T>(response);
  }
}
