class DataAccess {
  /**
   * Generic GET request
   */
  static async get<T = any>(url: string, token?: string): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(url, { method: 'GET', headers });
    const data: ApiResponse<T> = await response.json();

    if (!response.ok) {
      throw new Error(data.result || `Request failed with status ${response.status}`);
    }
    return data;
  }

  /**
   * Generic POST request
   */
  static async post<T = any>(url: string, body: any, token?: string): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data: ApiResponse<T> = await response.json();

    if (!response.ok) {
      throw new Error(data.result || `Request failed with status ${response.status}`);
    }
    return data;
  }

  /**
   * Generic PUT request
   */
  static async put<T = any>(url: string, body: any, token?: string): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
    const data: ApiResponse<T> = await response.json();

    if (!response.ok) {
      throw new Error(data.result || `Request failed with status ${response.status}`);
    }
    return data;
  }

  /**
   * Generic DELETE request
   */
  static async del<T = any>(url: string, token?: string): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(url, { method: 'DELETE', headers });
    const data: ApiResponse<T> = await response.json();

    if (!response.ok) {
      throw new Error(data.result || `Request failed with status ${response.status}`);
    }
    return data;
  }
}
