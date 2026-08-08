/**
 * API client for exchange transfer history (deposits and withdrawals).
 *
 * Reads are cheap — the backend serves them from its own table and never calls
 * an exchange. `sync` is the expensive one, and it deliberately does only a
 * bounded slice of work per call: a `complete: false` reply means "call me
 * again", not "something failed".
 */
class TransferData {
  static async list(token: string, filters: TransferFilters = {}): Promise<ApiResponse<TransferPage>> {
    const params = new URLSearchParams();
    if (filters.connId !== undefined && filters.connId !== null) params.set('conn_id', String(filters.connId));
    if (filters.kind) params.set('kind', filters.kind);
    if (filters.asset) params.set('asset', filters.asset);
    if (filters.status) params.set('status', filters.status);
    if (filters.from !== undefined) params.set('from', String(filters.from));
    if (filters.to !== undefined) params.set('to', String(filters.to));
    if (filters.limit !== undefined) params.set('limit', String(filters.limit));
    if (filters.offset !== undefined) params.set('offset', String(filters.offset));
    const query = params.toString();
    return DataAccess.get<TransferPage>(
      `${AppConfig.API_BASE}/transfers/${query ? `?${query}` : ''}`,
      token
    );
  }

  static async status(token: string): Promise<ApiResponse<TransferSyncStatus>> {
    return DataAccess.get<TransferSyncStatus>(`${AppConfig.API_BASE}/transfers/status`, token);
  }

  static async sync(token: string, connId?: number | 'all'): Promise<ApiResponse<TransferSyncResult>> {
    const body = connId === undefined || connId === 'all' ? {} : { conn_id: connId };
    return DataAccess.post<TransferSyncResult>(`${AppConfig.API_BASE}/transfers/sync`, body, token);
  }

  static async assets(token: string): Promise<ApiResponse<string[]>> {
    return DataAccess.get<string[]>(`${AppConfig.API_BASE}/transfers/assets`, token);
  }
}

interface TransferFilters {
  connId?: number | 'all' | null;
  kind?: 'deposit' | 'withdrawal';
  asset?: string;
  status?: string;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}

interface TransferRow {
  id: number;
  exchange_connection_id: number;
  exchange_name: string;
  exchange_label: string | null;
  kind: 'deposit' | 'withdrawal';
  external_id: string | null;
  txid: string | null;
  network: string | null;
  asset: string;
  /** Exact decimal as text — the display and precision source of truth. */
  amount: string;
  /** Float mirror of `amount`, for sorting only. */
  amount_num: number;
  fee_amount: string | null;
  fee_currency: string | null;
  status: string | null;
  address: string | null;
  tag: string | null;
  /** Epoch SECONDS, not milliseconds. */
  occurred_at: number;
  usd_value: number | null;
  /** null = unknown, 0 = external, 1 = a move between the user's own accounts. */
  is_internal: number | null;
}

type TransferState =
  | 'not_started' | 'backfilling' | 'idle' | 'error' | 'unsupported' | 'disabled';

interface TransferKindStatus {
  state: TransferState;
  progress_pct: number;
  synced_through?: number;
  backfill_complete?: boolean;
  last_sync_ok_at?: number | null;
  age_seconds?: number | null;
  last_error?: string | null;
  disabled_reason?: string | null;
}

interface TransferConnectionStatus {
  connection_id: number;
  exchange: string;
  label: string | null;
  supported: boolean;
  kinds: Record<'deposit' | 'withdrawal', TransferKindStatus>;
}

interface TransferSyncStatus {
  connections: TransferConnectionStatus[];
  any_pending: boolean;
}

interface TransferPage {
  items: TransferRow[];
  total: number;
  limit: number;
  offset: number;
  sync: TransferSyncStatus;
}

interface TransferSyncResult {
  complete: boolean;
  new_rows: number;
  already_running: boolean;
  sync: TransferSyncStatus;
}
