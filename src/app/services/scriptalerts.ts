/*
 * Alerts on custom (Pine Script) indicators.
 *
 * The backend can't run Pine, so the app watches: ScriptAlertMonitor runs
 * every armed alert's script (the copy saved with the alert) on fresh candles
 * once a minute, from sign-in to sign-out, on every page and while Cyrus sits
 * in the tray. A hit is reported to the backend, which records it once per
 * bar (so a second window or a restart can't double-fire) and sends the
 * email; the desktop notification is shown here, only for a new hit.
 */

class ScriptAlerts {
  static alerts: ScriptAlert[] = [];
  private static loaded = false;
  private static listeners = new Set<() => void>();

  static readonly FREQ_LABELS: Record<ScriptAlertFrequency, string> = {
    bar_close: 'Once per bar close',
    bar: 'Once per bar',
    once: 'Only once',
  };

  static onChange(cb: () => void): () => void {
    ScriptAlerts.listeners.add(cb);
    return () => ScriptAlerts.listeners.delete(cb);
  }

  private static emit(): void {
    ScriptAlerts.listeners.forEach((cb) => { try { cb(); } catch { /* a listener's problem */ } });
  }

  static async refresh(): Promise<void> {
    if (!AuthController.getToken()) return;
    try {
      ScriptAlerts.alerts = (await ScriptAlertData.list()).data || [];
      ScriptAlerts.loaded = true;
      ScriptAlerts.emit();
    } catch { /* keep what we had */ }
  }

  static async ensureLoaded(): Promise<void> {
    if (!ScriptAlerts.loaded) await ScriptAlerts.refresh();
  }

  static get(id: number): ScriptAlert | undefined {
    return ScriptAlerts.alerts.find((a) => a.id === id);
  }

  /** Replace one alert in the list (after the server sent it back). */
  static put(a: ScriptAlert): void {
    const i = ScriptAlerts.alerts.findIndex((x) => x.id === a.id);
    if (i >= 0) ScriptAlerts.alerts[i] = a;
    else ScriptAlerts.alerts.unshift(a);
    ScriptAlerts.emit();
  }

  static async create(body: ScriptAlertCreate): Promise<ScriptAlert> {
    const a = (await ScriptAlertData.create(body)).data;
    ScriptAlerts.put(a);
    return a;
  }

  static async update(id: number, body: Partial<ScriptAlertCreate> & { status?: 'active' | 'paused' }): Promise<ScriptAlert> {
    const a = (await ScriptAlertData.update(id, body)).data;
    ScriptAlerts.put(a);
    return a;
  }

  static async remove(id: number): Promise<void> {
    try { await ScriptAlertData.remove(id); } catch { /* already gone */ }
    ScriptAlerts.alerts = ScriptAlerts.alerts.filter((a) => a.id !== id);
    ScriptAlerts.emit();
  }

  static reset(): void {
    ScriptAlerts.alerts = [];
    ScriptAlerts.loaded = false;
  }

  /** The indicator was edited after this alert was made (the alert still runs its old copy). */
  static isStale(a: ScriptAlert): boolean {
    const row = CustomIndicators.get(a.indicator_id);
    return !!row && row.source !== a.script_source;
  }

  /** Bring an alert up to the indicator's current version (keeps its inputs). */
  static async updateScript(a: ScriptAlert): Promise<void> {
    const row = CustomIndicators.get(a.indicator_id);
    if (!row) return;
    const c = PineEngine.compile(row.source).compiled;
    if (!c) throw new Error('The indicator has errors. Fix them in the Pine Editor first.');
    const cond = a.condition_key === '*alert' ? null : c.alertConditions.find((x) => x.key === a.condition_key);
    if (a.condition_key !== '*alert' && !cond) throw new Error(`The indicator no longer has the "${a.condition_title}" condition.`);
    await ScriptAlerts.update(a.id, {
      script_source: row.source,
      inputs: CustomIndicators.params(c, a.inputs),
      indicator_name: row.name,
      condition_key: a.condition_key,
      condition_title: cond ? cond.title : a.condition_title,
    });
  }

  /** "BTC/USD · 1h · Once per bar close · fired 3×" */
  static describe(a: ScriptAlert): string {
    const bits = [a.symbol, a.timeframe, ScriptAlerts.FREQ_LABELS[a.frequency] || a.frequency];
    if (a.trigger_count) bits.push(`fired ${a.trigger_count}×`);
    return bits.join(' · ');
  }

  /** Fill in {{ticker}}, {{close}}, {{plot_0}}, {{plot("RSI")}} … for bar i. */
  static expand(template: string, a: { symbol: string; source: string; timeframe: string }, bars: ChartBar[], i: number, res: PineRunResult | null): string {
    const b = bars[i];
    const fmt = (v: number) => (isFinite(v) ? PineBuiltins.toStr(v) : 'NaN');
    const [base, quote = 'USD'] = a.symbol.toUpperCase().split('/');
    const plots = (res?.outputs || []).filter((o) => o.kind === 'plot');
    const vars: Record<string, () => string> = {
      ticker: () => `${base}${quote}`,
      exchange: () => ChartWorkspace.sourceName(a.source),
      interval: () => a.timeframe,
      open: () => fmt(b.open), high: () => fmt(b.high), low: () => fmt(b.low), close: () => fmt(b.close),
      volume: () => fmt(b.volume),
      time: () => new Date(b.time * 1000).toISOString(),
      timenow: () => new Date().toISOString(),
    };
    return template.replace(/\{\{\s*(?:plot_(\d+)|plot\(\s*["']([^"']+)["']\s*\)|(\w+))\s*\}\}/g, (m, n, title, name) => {
      if (n !== undefined) { const o = plots.find((p) => p.plotIndex === Number(n)); return o ? fmt(o.values[i]) : m; }
      if (title !== undefined) { const o = plots.find((p) => p.title === title); return o ? fmt(o.values[i]) : m; }
      return vars[name] ? vars[name]() : m;
    });
  }
}

const ScriptAlertMonitor = (() => {
  const TICK_MS = 60_000;
  let timer: number | null = null;
  let busy = false;

  function start(): void {
    if (timer !== null) return;
    timer = window.setInterval(() => void tick(), TICK_MS);
    // Let sign-in settle first.
    setTimeout(() => void tick(), 5000);
  }

  function stop(): void {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    ScriptAlerts.reset();
  }

  async function tick(): Promise<void> {
    const token = AuthController.getToken();
    if (busy || !token) return;
    busy = true;
    try {
      await ScriptAlerts.refresh();
      const active = ScriptAlerts.alerts.filter((a) => a.status === 'active');
      const groups = new Map<string, ScriptAlert[]>();
      for (const a of active) {
        const k = `${a.source}|${a.symbol}|${a.timeframe}`;
        const g = groups.get(k);
        if (g) g.push(a); else groups.set(k, [a]);
      }
      for (const list of groups.values()) {
        const { source, symbol, timeframe } = list[0];
        let bars: ChartBar[];
        try {
          const resp = await MarketData.getCandles(token, { symbol, source, timeframe });
          bars = (resp.data?.candles || []).slice().sort((x, y) => x.time - y.time);
        } catch {
          continue; // feed down: try again next minute
        }
        if (!bars.length) continue;
        for (const a of list) {
          try { await check(a, bars); } catch (e) { console.warn('[ScriptAlerts] check failed', a.id, e); }
        }
      }
    } finally {
      busy = false;
    }
  }

  async function check(a: ScriptAlert, all: ChartBar[]): Promise<void> {
    const { compiled } = PineEngine.compile(a.script_source);
    if (!compiled) return;
    const bars = all.length > CHART_SCRIPT_MAX_BARS ? all.slice(-CHART_SCRIPT_MAX_BARS) : all;
    const step = ChartGeo.tfSeconds(a.timeframe);
    const now = Date.now() / 1000;
    const last = bars[bars.length - 1];
    const lastLive = last.time + step > now;
    const res = PineEngine.run(compiled, bars, CustomIndicators.params(compiled, a.inputs), {
      symbol: a.symbol, source: a.source, exchange: ChartWorkspace.sourceName(a.source), timeframe: a.timeframe,
      lastLive, maxMs: 4000,
    });
    if (res.error) return;
    // Once per bar close looks at the last finished bar; the others at the live one.
    const i = a.frequency === 'bar_close' && lastLive ? bars.length - 2 : bars.length - 1;
    if (i < 0) return;
    const barTime = bars[i].time;
    if (a.last_bar_time != null && barTime <= a.last_bar_time) return;
    if (barTime + step <= a.created_at) return; // that bar was over before the alert existed

    let message: string;
    if (a.condition_key === '*alert') {
      const call = res.alertCalls.filter((c) => c.bar === i).pop();
      if (!call) return;
      message = call.message;
    } else {
      const cond = res.alerts.find((x) => x.key === a.condition_key);
      if (!cond || cond.hits[i] !== 1) return;
      message = ScriptAlerts.expand(a.message || cond.message || '', a, bars, i, res);
    }
    const resp = await ScriptAlertData.fire(a.id, barTime, message);
    ScriptAlerts.put(resp.data.alert);
    if (resp.data.created) notify(a, message);
  }

  function notify(a: ScriptAlert, message: string): void {
    if (!NotificationService.isEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
    const n = new Notification(`🔔 ${a.indicator_name}: ${a.condition_title}`, {
      body: message || `${a.symbol} · ${a.timeframe}`,
      silent: false,
    });
    setTimeout(() => n.close(), 15000);
    n.onclick = () => {
      if (typeof router !== 'undefined') void router.navigate('charts', a.chart_id ? { chartId: String(a.chart_id) } : undefined);
      n.close();
    };
  }

  return { start, stop, tick };
})();
