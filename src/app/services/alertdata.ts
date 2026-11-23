/** A price alert set from a chart line (see AlertController.py). */
interface PriceAlert {
  id: number;
  chart_id: number | null;
  drawing_id: string | null;
  source: string;
  symbol: string;
  kind: 'level' | 'line';
  price: number | null;
  t1: number | null; p1: number | null; t2: number | null; p2: number | null;
  direction: 'above' | 'below';
  note: string | null;
  status: 'active' | 'triggered';
  created_at: number;
  triggered_at: number | null;
  triggered_price: number | null;
  /** Where the alert sits right now (a trend line's moves with time). */
  price_now: number | null;
}

type PriceAlertBody =
  | { kind: 'level'; price: number }
  | { kind: 'line'; points: { time: number; price: number }[] };

class AlertData {
  private static token(): string {
    return AuthController.getToken() || '';
  }

  static async list(): Promise<ApiResponse<PriceAlert[]>> {
    return DataAccess.get<PriceAlert[]>(`${AppConfig.API_BASE}/alerts/`, AlertData.token());
  }

  static async create(body: PriceAlertBody & { source: string; symbol: string; chart_id?: number | null; drawing_id?: string }): Promise<ApiResponse<PriceAlert>> {
    return DataAccess.post<PriceAlert>(`${AppConfig.API_BASE}/alerts/`, body, AlertData.token());
  }

  static async update(id: number, body: PriceAlertBody): Promise<ApiResponse<PriceAlert>> {
    return DataAccess.put<PriceAlert>(`${AppConfig.API_BASE}/alerts/${id}`, body, AlertData.token());
  }

  static async remove(id: number): Promise<ApiResponse<any>> {
    return DataAccess.del<any>(`${AppConfig.API_BASE}/alerts/${id}`, AlertData.token());
  }

  /** Alerts that fired after `since` (epoch s). */
  static async events(since: number): Promise<ApiResponse<PriceAlert[]>> {
    return DataAccess.get<PriceAlert[]>(`${AppConfig.API_BASE}/alerts/events?since=${since}`, AlertData.token());
  }
}

/**
 * The signed-in user's price alerts, shared by the chart (which marks lines
 * that carry one), the Charts toolbar's alert list and the notifier.
 */
class ChartAlerts {
  static alerts: PriceAlert[] = [];
  private static loaded = false;
  private static listeners = new Set<() => void>();
  /** Drawing types an alert can follow: a level, or a line's slope. */
  static readonly TYPES = ['hline', 'hray', 'trend', 'ray', 'extended'];

  static onChange(cb: () => void): () => void {
    ChartAlerts.listeners.add(cb);
    return () => ChartAlerts.listeners.delete(cb);
  }

  private static emit(): void {
    ChartAlerts.listeners.forEach((cb) => { try { cb(); } catch { /* a listener's problem */ } });
  }

  static async refresh(): Promise<void> {
    try {
      ChartAlerts.alerts = (await AlertData.list()).data || [];
      ChartAlerts.loaded = true;
      ChartAlerts.emit();
    } catch { /* keep what we had */ }
  }

  static async ensureLoaded(): Promise<void> {
    if (!ChartAlerts.loaded) await ChartAlerts.refresh();
  }

  static get(id: number | undefined | null): PriceAlert | undefined {
    return id == null ? undefined : ChartAlerts.alerts.find((a) => a.id === id);
  }

  static canAlert(d: ChartDrawing): boolean {
    return ChartAlerts.TYPES.includes(d.type);
  }

  /** The alert geometry for a drawing: a horizontal level, or the line through its points. */
  static bodyFor(d: ChartDrawing): PriceAlertBody {
    if (d.type === 'hline' || d.type === 'hray') return { kind: 'level', price: d.points[0].price };
    return { kind: 'line', points: d.points.slice(0, 2).map((p) => ({ time: Math.round(p.time), price: p.price })) };
  }

  static async createFor(d: ChartDrawing, pane: ChartPaneState, chartId: number | null): Promise<PriceAlert> {
    const resp = await AlertData.create({ ...ChartAlerts.bodyFor(d), source: pane.source, symbol: pane.symbol, chart_id: chartId, drawing_id: d.id });
    const alert = resp.data;
    ChartAlerts.alerts = [alert, ...ChartAlerts.alerts.filter((a) => a.id !== alert.id)];
    ChartAlerts.emit();
    return alert;
  }

  /** Follow a moved line (this re-arms a fired alert). */
  static async moveFor(d: ChartDrawing): Promise<void> {
    if (d.alertId == null || !ChartAlerts.get(d.alertId)) return;
    const resp = await AlertData.update(d.alertId, ChartAlerts.bodyFor(d));
    ChartAlerts.alerts = ChartAlerts.alerts.map((a) => (a.id === resp.data.id ? resp.data : a));
    ChartAlerts.emit();
  }

  /** Re-arm a fired alert where it is. */
  static async rearm(a: PriceAlert): Promise<void> {
    const body: PriceAlertBody = a.kind === 'level'
      ? { kind: 'level', price: a.price as number }
      : { kind: 'line', points: [{ time: a.t1 as number, price: a.p1 as number }, { time: a.t2 as number, price: a.p2 as number }] };
    const resp = await AlertData.update(a.id, body);
    ChartAlerts.alerts = ChartAlerts.alerts.map((x) => (x.id === a.id ? resp.data : x));
    ChartAlerts.emit();
  }

  static async remove(id: number): Promise<void> {
    try { await AlertData.remove(id); } catch { /* already gone */ }
    ChartAlerts.alerts = ChartAlerts.alerts.filter((a) => a.id !== id);
    ChartAlerts.emit();
  }

  static reset(): void {
    ChartAlerts.alerts = [];
    ChartAlerts.loaded = false;
  }

  /** "rises to 65,000.00" / "falls to …" */
  static describe(a: PriceAlert): string {
    const p = a.status === 'triggered' ? a.triggered_price : a.price_now;
    const verb = a.status === 'triggered'
      ? (a.direction === 'above' ? 'rose to' : 'fell to')
      : (a.direction === 'above' ? 'rises to' : 'falls to');
    return `${verb} ${p == null ? '—' : ChartGeo.formatPrice(p, ChartWorkspace.isStock(a.source))}${a.kind === 'line' ? ' (trend line)' : ''}`;
  }
}
