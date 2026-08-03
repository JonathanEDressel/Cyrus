class ExchangeData {
  // ---- Exchange connections management ----

  static async getSupportedExchanges(token: string): Promise<ApiResponse<any[]>> {
    return DataAccess.get<any[]>(
      `${AppConfig.API_BASE}/exchanges/supported`,
      token
    );
  }

  static async getConnections(token: string): Promise<ApiResponse<any[]>> {
    return DataAccess.get<any[]>(
      `${AppConfig.API_BASE}/exchanges/connections`,
      token
    );
  }

  static async addConnection(token: string, data: { exchange_name: string; label: string; api_key: string; private_key: string; passphrase?: string; is_sandbox?: boolean }): Promise<ApiResponse<any>> {
    return DataAccess.post<any>(
      `${AppConfig.API_BASE}/exchanges/connections`,
      data,
      token
    );
  }

  static async updateConnection(token: string, connectionId: number, data: { api_key: string; private_key: string; passphrase?: string }): Promise<ApiResponse<any>> {
    return DataAccess.put<any>(
      `${AppConfig.API_BASE}/exchanges/connections/${connectionId}`,
      data,
      token
    );
  }

  static async deleteConnection(token: string, connectionId: number): Promise<ApiResponse<any>> {
    return DataAccess.del<any>(
      `${AppConfig.API_BASE}/exchanges/connections/${connectionId}`,
      token
    );
  }

  static async validateConnection(token: string, connectionId: number): Promise<ApiResponse<any>> {
    return DataAccess.post<any>(
      `${AppConfig.API_BASE}/exchanges/connections/${connectionId}/validate`,
      {},
      token
    );
  }

  // ---- Exchange data (per-connection) ----

  static async getOpenOrders(token: string, connectionId: number): Promise<ApiResponse<any[]>> {
    return DataAccess.get<any[]>(
      `${AppConfig.API_BASE}/exchange/${connectionId}/open-orders`,
      token
    );
  }

  /** Place one limit order. A staggered ladder is the caller looping over this. */
  static async createOrder(token: string, connectionId: number, order: CreateOrderRequest): Promise<ApiResponse<any>> {
    return DataAccess.post<any>(
      `${AppConfig.API_BASE}/exchange/${connectionId}/create-order`,
      order,
      token
    );
  }

  /**
   * Markets where `asset` is the BASE, with tick sizes, minimums, live prices,
   * available balances and this exchange's order pacing.
   *
   * Directional by design: a limit order's price is quote-per-base of the
   * specific market it rests on, so BTC/USDT and a hypothetical USDT/BTC are
   * not interchangeable the way they are for a market convert.
   */
  static async getPairs(token: string, connectionId: number, asset: string, side?: 'buy' | 'sell'): Promise<ApiResponse<PairsResponse>> {
    const params = new URLSearchParams({ asset });
    if (side) params.set('side', side);
    return DataAccess.get<PairsResponse>(
      `${AppConfig.API_BASE}/exchange/${connectionId}/pairs?${params.toString()}`,
      token
    );
  }

  /** Cancel one open order. `symbol` is required by every exchange but Kraken. */
  static async cancelOrder(token: string, connectionId: number, orderId: string, symbol?: string): Promise<ApiResponse<any>> {
    return DataAccess.post<any>(
      `${AppConfig.API_BASE}/exchange/${connectionId}/cancel-order`,
      { order_id: orderId, symbol },
      token
    );
  }

  static async getWithdrawalAddresses(token: string, connectionId: number): Promise<ApiResponse<any[]>> {
    return DataAccess.get<any[]>(
      `${AppConfig.API_BASE}/exchange/${connectionId}/withdrawal-addresses`,
      token
    );
  }

  static async getBalance(token: string, connectionId: number): Promise<ApiResponse<Record<string, string>>> {
    return DataAccess.get<Record<string, string>>(
      `${AppConfig.API_BASE}/exchange/${connectionId}/balance`,
      token
    );
  }

  /** Every asset tradable on a connection's exchange, not just held ones. */
  static async getTradableAssets(token: string, connectionId: number): Promise<ApiResponse<string[]>> {
    return DataAccess.get<string[]>(
      `${AppConfig.API_BASE}/exchange/${connectionId}/assets`,
      token
    );
  }

  static async getPortfolio(token: string, connectionId: number): Promise<ApiResponse<PortfolioData>> {
    return DataAccess.get<PortfolioData>(
      `${AppConfig.API_BASE}/exchange/${connectionId}/portfolio`,
      token
    );
  }

  static async getPortfolioHistory(token: string, range: string, connId?: number | 'all'): Promise<ApiResponse<PortfolioHistory>> {
    const params = new URLSearchParams({ range });
    if (connId !== undefined && connId !== 'all') params.set('conn_id', String(connId));
    return DataAccess.get<PortfolioHistory>(
      `${AppConfig.API_BASE}/exchange/portfolio/history?${params.toString()}`,
      token
    );
  }
}

/** One limit order to place. Mirrors what the backend forwards to the exchange. */
interface CreateOrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  type: 'limit';
  amount: number;
  price: number;
  /** Reject rather than cross the spread. Only send where the exchange supports it. */
  post_only?: boolean;
  /** Idempotency key, so a retried ambiguous request can't double-place. */
  client_order_id?: string;
}

/**
 * A market's own grid: the prices and sizes the exchange will actually accept.
 *
 * `*_tick` is a tick SIZE (e.g. 1e-8), not a decimal count — every exchange the
 * app supports reports precision that way. `*_decimals` is the resolved
 * decimal-place count, computed server-side because a bare `8` on the wire is
 * ambiguous (eight units, or eight decimals?).
 */
interface PairMeta {
  symbol: string;
  base: string;
  quote: string;
  price_tick: number | null;
  price_decimals: number | null;
  amount_tick: number | null;
  amount_decimals: number | null;
  min_amount: number | null;
  max_amount: number | null;
  min_cost: number | null;
  max_cost: number | null;
  stable_quote: boolean;
  /** Last traded price, absent when the market couldn't be priced. */
  price?: number | null;
  available_base?: number;
  available_quote?: number;
}

interface PairsResponse {
  asset: string;
  side: 'buy' | 'sell' | null;
  exchange: string;
  /** Milliseconds to leave between consecutive placements on this exchange. */
  order_pacing_ms: number;
  supports_post_only: boolean;
  pairs: PairMeta[];
}

interface PortfolioHistoryPoint {
  time: number;
  value: number;
  estimated?: number;
}

interface PortfolioHistory {
  total: PortfolioHistoryPoint[];
  assets: Array<{ asset: string; points: PortfolioHistoryPoint[] }>;
  earliest: number | null;
}

interface PortfolioPosition {
  asset: string;
  amount: number;
  usd_value: number;
}

interface PortfolioData {
  positions: PortfolioPosition[];
  total_usd: number;
}
