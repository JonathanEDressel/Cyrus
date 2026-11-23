/*
 * The signed-in user's Pine Script indicators, shared by the chart (which
 * draws them), the Pine Editor and the indicator menu. Charts refer to a
 * script by id (ChartIndicatorSpec.type 'script' + scriptId); compiling is
 * cached by source in PineEngine.
 */

const PINE_NEW_SCRIPT = `//@version=6
indicator("My indicator", overlay=false)

length = input.int(14, "Length", minval=1)
src = input.source(close, "Source")

value = ta.rsi(src, length)

plot(value, "RSI", color=color.blue, linewidth=2)
hline(70, "Overbought", color=color.red)
hline(30, "Oversold", color=color.green)
alertcondition(ta.crossover(value, 70), "Crossed above 70", "RSI crossed above 70 on {{ticker}}")
`;

class CustomIndicators {
  static scripts: CustomIndicatorRow[] = [];
  private static loaded = false;
  private static loading: Promise<void> | null = null;
  private static listeners = new Set<() => void>();

  static onChange(cb: () => void): () => void {
    CustomIndicators.listeners.add(cb);
    return () => CustomIndicators.listeners.delete(cb);
  }

  private static emit(): void {
    CustomIndicators.listeners.forEach((cb) => { try { cb(); } catch { /* a listener's problem */ } });
  }

  static get isLoaded(): boolean { return CustomIndicators.loaded; }

  static async refresh(): Promise<void> {
    if (!AuthController.getToken()) return;
    try {
      CustomIndicators.scripts = (await IndicatorData.list()).data || [];
      CustomIndicators.loaded = true;
      CustomIndicators.emit();
    } catch { /* keep what we had */ }
  }

  static ensureLoaded(): Promise<void> {
    if (CustomIndicators.loaded) return Promise.resolve();
    if (!CustomIndicators.loading) {
      CustomIndicators.loading = CustomIndicators.refresh().finally(() => { CustomIndicators.loading = null; });
    }
    return CustomIndicators.loading;
  }

  static get(id: number | undefined | null): CustomIndicatorRow | undefined {
    return id == null ? undefined : CustomIndicators.scripts.find((s) => s.id === id);
  }

  /** Compile a saved script (cached by source). Null if there's no such script. */
  static compiled(id: number | undefined | null): { compiled: PineCompiled | null; error: PineError | null } | null {
    const row = CustomIndicators.get(id);
    return row ? PineEngine.compile(row.source) : null;
  }

  static async create(name: string, source: string): Promise<CustomIndicatorRow> {
    const row = (await IndicatorData.create(name, source)).data;
    CustomIndicators.scripts = [...CustomIndicators.scripts.filter((s) => s.id !== row.id), row]
      .sort((a, b) => a.name.localeCompare(b.name));
    CustomIndicators.emit();
    return row;
  }

  static async update(id: number, changes: { name?: string; source?: string }): Promise<CustomIndicatorRow> {
    const row = (await IndicatorData.update(id, changes)).data;
    CustomIndicators.scripts = CustomIndicators.scripts.map((s) => (s.id === id ? row : s))
      .sort((a, b) => a.name.localeCompare(b.name));
    CustomIndicators.emit();
    return row;
  }

  static async remove(id: number): Promise<void> {
    await IndicatorData.remove(id);
    CustomIndicators.scripts = CustomIndicators.scripts.filter((s) => s.id !== id);
    CustomIndicators.emit();
  }

  static reset(): void {
    CustomIndicators.scripts = [];
    CustomIndicators.loaded = false;
  }

  /** A name for a new script that isn't taken yet. */
  static uniqueName(base: string): string {
    const taken = new Set(CustomIndicators.scripts.map((s) => s.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    let i = 2;
    while (taken.has(`${base} ${i}`.toLowerCase())) i++;
    return `${base} ${i}`;
  }

  // ── Helpers that work for built-in and script indicators alike ────────

  /** Draws on the price pane rather than its own pane. */
  static isOverlay(spec: ChartIndicatorSpec): boolean {
    if (spec.type === 'script') return !!CustomIndicators.compiled(spec.scriptId)?.compiled?.overlay;
    return !!ChartIndicators.get(spec.type)?.overlay;
  }

  /** Full name: "Relative Strength (RSI)", or the script's title. */
  static label(spec: ChartIndicatorSpec): string {
    if (spec.type !== 'script') return ChartIndicators.get(spec.type)?.label || spec.type;
    const row = CustomIndicators.get(spec.scriptId);
    if (!row) return CustomIndicators.isLoaded ? 'Script not found' : 'Loading…';
    return row.name;
  }

  /** The status-line name: "RSI 14", or a script's shorttitle and inputs. */
  static shortLabel(spec: ChartIndicatorSpec): string {
    if (spec.type !== 'script') return ChartIndicators.get(spec.type)?.short(spec.params as Record<string, number>) || spec.type;
    const row = CustomIndicators.get(spec.scriptId);
    if (!row) return CustomIndicators.label(spec);
    const c = PineEngine.compile(row.source).compiled;
    if (!c) return row.name;
    const name = c.shorttitle || c.title || row.name;
    const vals = c.inputs
      .filter((i) => i.type === 'int' || i.type === 'float' || i.type === 'source' || (i.type === 'string' && i.options))
      .slice(0, 5)
      .map((i) => String(spec.params[i.key] ?? i.def));
    return vals.length ? `${name} ${vals.join(' ')}` : name;
  }

  /** Settings for a script: its input defaults, overlaid with what's saved. */
  static params(c: PineCompiled, saved: Record<string, any> | undefined): Record<string, number | boolean | string> {
    const out = PineEngine.defaults(c);
    for (const i of c.inputs) {
      const v = saved?.[i.key];
      if (v === undefined || v === null) continue;
      if (i.type === 'bool' && typeof v === 'boolean') out[i.key] = v;
      else if ((i.type === 'int' || i.type === 'float') && typeof v === 'number' && isFinite(v)) out[i.key] = v;
      else if (typeof v === 'string' && i.type !== 'int' && i.type !== 'float' && i.type !== 'bool') out[i.key] = v;
    }
    return out;
  }
}
