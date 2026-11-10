/**
 * API client for cost basis, realized gains and the tax exports.
 *
 * Reads are replayed server-side from stored history and never call an
 * exchange. `sync` is the expensive one and, like the transfer sync, does a
 * bounded slice per call: `complete: false` means "call again".
 */
class TaxData {
  static async status(token: string): Promise<ApiResponse<TaxSyncStatus>> {
    return DataAccess.get<TaxSyncStatus>(`${AppConfig.API_BASE}/tax/status`, token);
  }

  static async sync(token: string, connId?: number | 'all'): Promise<ApiResponse<TaxSyncResult>> {
    const body = connId === undefined || connId === 'all' ? {} : { conn_id: connId };
    return DataAccess.post<TaxSyncResult>(`${AppConfig.API_BASE}/tax/sync`, body, token);
  }

  static async gains(token: string, method: CostBasisMethod, year?: number,
                     needsInfoOnly = false): Promise<ApiResponse<TaxGains>> {
    const params = new URLSearchParams({ method });
    if (year !== undefined) params.set('year', String(year));
    if (needsInfoOnly) params.set('needs_info', '1');
    return DataAccess.get<TaxGains>(`${AppConfig.API_BASE}/tax/gains?${params}`, token);
  }

  // ---- manual cost basis ----

  static async manual(token: string): Promise<ApiResponse<ManualCostBasis>> {
    return DataAccess.get<ManualCostBasis>(`${AppConfig.API_BASE}/tax/manual`, token);
  }

  static async addLot(token: string, lot: ManualLotInput): Promise<ApiResponse<{ id: number }>> {
    return DataAccess.post<{ id: number }>(`${AppConfig.API_BASE}/tax/manual/lots`, lot, token);
  }

  static async deleteLot(token: string, id: number): Promise<ApiResponse<null>> {
    return DataAccess.del<null>(`${AppConfig.API_BASE}/tax/manual/lots/${id}`, token);
  }

  static async setDepositCost(token: string, transferId: number,
                              body: DepositCostInput): Promise<ApiResponse<null>> {
    return DataAccess.put<null>(`${AppConfig.API_BASE}/tax/manual/deposits/${transferId}`, body, token);
  }

  static async deleteDepositCost(token: string, transferId: number): Promise<ApiResponse<null>> {
    return DataAccess.del<null>(`${AppConfig.API_BASE}/tax/manual/deposits/${transferId}`, token);
  }

  static async setTradePrice(token: string, tradeId: number,
                             quoteUsdPrice: number): Promise<ApiResponse<null>> {
    return DataAccess.put<null>(`${AppConfig.API_BASE}/tax/manual/trades/${tradeId}/price`,
      { quote_usd_price: quoteUsdPrice }, token);
  }

  static async deleteTradePrice(token: string, tradeId: number): Promise<ApiResponse<null>> {
    return DataAccess.del<null>(`${AppConfig.API_BASE}/tax/manual/trades/${tradeId}/price`, token);
  }

  static async exportFile(token: string, format: TaxExportFormat, method: CostBasisMethod,
                          year?: number): Promise<ApiResponse<TaxExportFile>> {
    const params = new URLSearchParams({ format, method });
    if (year !== undefined) params.set('year', String(year));
    return DataAccess.get<TaxExportFile>(`${AppConfig.API_BASE}/tax/export?${params}`, token);
  }

  static async projectSells(token: string, method: CostBasisMethod,
                            sells: ProjectedSellInput[]): Promise<ApiResponse<ProjectedSells>> {
    return DataAccess.post<ProjectedSells>(`${AppConfig.API_BASE}/tax/project-sells`,
      { method, sells }, token);
  }
}

type CostBasisMethod = 'fifo' | 'hifo';
type TaxExportFormat = '8949' | 'koinly';

type TradeSyncState =
  | 'not_started' | 'backfilling' | 'idle' | 'error' | 'unsupported' | 'disabled';

interface TradeSyncInfo {
  state: TradeSyncState;
  backfill_complete?: boolean;
  synced_through?: number;
  last_sync_ok_at?: number | null;
  age_seconds?: number | null;
  last_error?: string | null;
  disabled_reason?: string | null;
  /** Binance markets the key couldn't read, skipped one by one. */
  skipped_markets?: number;
}

interface TaxConnectionStatus {
  connection_id: number;
  exchange: string;
  label: string | null;
  trades: TradeSyncInfo;
  trade_count: number;
}

interface TaxSyncStatus {
  connections: TaxConnectionStatus[];
  any_pending: boolean;
}

interface TaxSyncResult {
  complete: boolean;
  new_rows: number;
  already_running: boolean;
  errors: string[];
  sync: TaxSyncStatus;
}

/** What the user can enter to resolve a row the history couldn't complete. */
type TaxFix =
  | { kind: 'deposit'; transfer_id: number; asset: string; amount: number;
      occurred_at: number; connection_id: number }
  | { kind: 'lot'; asset: string; amount: number; connection_id: number;
      /** Epoch seconds of the sale; the purchase must be on or before it. */
      before: number }
  | { kind: 'price'; trade_id: number; symbol: string; quote: string; side: string;
      amount: number; price: number; occurred_at: number };

interface ManualLot {
  id: number;
  exchange_connection_id: number;
  connection: string;
  asset: string;
  amount: number;
  total_cost_usd: number;
  acquired_at: number;
  note: string | null;
}

interface ManualDepositCost {
  transfer_id: number;
  total_cost_usd: number;
  acquired_at: number;
  note: string | null;
  asset: string;
  amount_num: number;
  occurred_at: number;
  connection: string;
}

interface ManualTradePrice {
  trade_id: number;
  symbol: string;
  quote: string;
  side: string;
  amount_num: number;
  occurred_at: number;
  quote_usd_price: number;
  connection: string;
}

interface ManualCostBasis {
  lots: ManualLot[];
  deposits: ManualDepositCost[];
  prices: ManualTradePrice[];
}

interface ManualLotInput {
  connection_id: number;
  asset: string;
  amount: number;
  total_cost_usd: number;
  /** Epoch seconds. */
  acquired_at: number;
  note?: string;
}

interface DepositCostInput {
  total_cost_usd: number;
  acquired_at: number;
  note?: string;
}

interface TaxDisposal {
  /** Present when the row is missing something the user can supply. */
  fix: TaxFix | null;
  trade_id: number | null;
  asset: string;
  amount: number;
  /** Epoch seconds; null when the cost basis is unknown. */
  acquired_at: number | null;
  sold_at: number;
  proceeds_usd: number | null;
  cost_usd: number | null;
  gain_usd: number | null;
  term: 'short' | 'long' | null;
  missing_basis: boolean;
  unpriced: boolean;
  basis_source: string;
  kind: 'trade' | 'fee';
  pair: string | null;
  connection_id: number;
  connection: string;
}

interface TaxSummary {
  proceeds_usd: number;
  cost_usd: number;
  gain_usd: number;
  short_term_gain_usd: number;
  long_term_gain_usd: number;
  disposals: number;
  missing_basis: number;
  unpriced: number;
}

interface TaxWarning {
  code: 'unknown_deposit' | 'sold_beyond_history' | 'unpriced_fills' | string;
  asset?: string;
  amount?: number;
  count?: number;
  message: string;
}

interface TaxGains {
  method: CostBasisMethod;
  year: number;
  years: number[];
  summary: TaxSummary;
  disposals: TaxDisposal[];
  disposals_total: number;
  /** Rows in the year missing a cost or a USD price (regardless of filter). */
  needs_info: number;
  needs_info_only: boolean;
  warnings: TaxWarning[];
  trade_count: number;
  sync: TaxSyncStatus;
}

interface TaxExportFile {
  filename: string;
  content_base64: string;
  bytes: number;
  rows: number;
}

interface ProjectedSellInput {
  key: string;
  connection_id: number;
  asset: string;
  amount: number;
  price_usd: number;
}

interface ProjectedSell {
  proceeds_usd: number;
  /** Null when any part of the order's cost basis is unknown. */
  cost_usd: number | null;
  gain_usd: number | null;
  missing_basis: boolean;
  /** The part of the order whose cost IS known, for a partial figure. */
  known_amount: number;
  known_cost_usd: number;
  known_gain_usd: number;
}

interface ProjectedSells {
  method: CostBasisMethod;
  results: Record<string, ProjectedSell>;
  /** False when no fills have been synced at all. */
  has_history: boolean;
}
