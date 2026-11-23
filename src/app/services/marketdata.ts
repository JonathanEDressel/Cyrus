/** A public candle feed the Charts page can draw from. */
interface ChartSource {
  id: string;
  name: string;
  /** 'stock' for the Stocks (Alpaca) source; crypto otherwise. */
  kind?: 'crypto' | 'stock';
  /** The feed needs the user's own key (Profile → Exchanges). */
  requires_key?: boolean;
  /** False while a requires_key source has no key on file. */
  configured?: boolean;
  /** Whether older candles can be fetched page by page (Kraken can't). */
  can_page: boolean;
  max_limit: number;
  timeframes: string[];
}

interface CandlePage {
  candles: ChartBar[];
  has_more: boolean;
}

class MarketData {
  /** Active spot pairs on a chart source (Kraken when none is given). */
  static async getPairs(token: string, source?: string): Promise<ApiResponse<any[]>> {
    const qs = source ? `?${new URLSearchParams({ source }).toString()}` : '';
    return DataAccess.get<any[]>(
      `${AppConfig.API_BASE}/market/pairs${qs}`,
      token
    );
  }

  /** One page of candles: the latest, or the page ending before `before` (epoch s). */
  static async getCandles(token: string, req: {
    symbol: string; timeframe: string; source: string; before?: number; limit?: number;
  }): Promise<ApiResponse<CandlePage>> {
    const params = new URLSearchParams({ symbol: req.symbol, timeframe: req.timeframe, source: req.source });
    if (req.before != null) params.set('before', String(req.before));
    if (req.limit != null) params.set('limit', String(req.limit));
    return DataAccess.get<CandlePage>(
      `${AppConfig.API_BASE}/market/candles?${params.toString()}`,
      token
    );
  }

  static async getChartSources(token: string): Promise<ApiResponse<ChartSource[]>> {
    return DataAccess.get<ChartSource[]>(
      `${AppConfig.API_BASE}/market/chart-sources`,
      token
    );
  }

  static async getOHLCV(token: string, symbol: string, range: string): Promise<ApiResponse<any[]>> {
    const params = new URLSearchParams({ symbol, range });
    return DataAccess.get<any[]>(
      `${AppConfig.API_BASE}/market/ohlcv?${params.toString()}`,
      token
    );
  }

  /** Held assets joined with their fundamentals (market cap, supply, ATH). */
  static async getHoldings(token: string, connId: number | 'all' = 'all'): Promise<ApiResponse<any>> {
    const params = new URLSearchParams({ conn_id: String(connId) });
    return DataAccess.get<any>(
      `${AppConfig.API_BASE}/market/holdings?${params.toString()}`,
      token
    );
  }

  /** Deep detail for one asset, including exchange-side price history. */
  static async getAssetDetail(token: string, symbol: string): Promise<ApiResponse<any>> {
    return DataAccess.get<any>(
      `${AppConfig.API_BASE}/market/asset/${encodeURIComponent(symbol)}`,
      token
    );
  }

  /** Market cap and the like for one coin (CoinGecko, cached by the backend). */
  static async getFundamentals(token: string, symbol: string): Promise<ApiResponse<any>> {
    return DataAccess.get<any>(
      `${AppConfig.API_BASE}/market/fundamentals/${encodeURIComponent(symbol)}`,
      token
    );
  }

  static async getTicker(token: string, symbol: string): Promise<ApiResponse<any>> {
    const params = new URLSearchParams({ symbol });
    return DataAccess.get<any>(
      `${AppConfig.API_BASE}/market/ticker?${params.toString()}`,
      token
    );
  }
}
