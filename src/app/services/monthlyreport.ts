/**
 * MonthlyReport — assembles and sends the monthly portfolio report email.
 *
 * The charts live in the renderer, so we render each one into an offscreen host,
 * rasterise it to a PNG with html-to-image, gather the holdings/automation/order
 * data, and POST it to the backend, which composes the HTML email and sends it
 * via the user's own SMTP account. Execution logs for the month are pulled
 * server-side.
 *
 * Note: portfolio/flow charts reflect *current* state (we can't reconstruct past
 * holdings); the execution log is the month's actual history.
 */
const MonthlyReport = (() => {
  let scheduledChecked = false;

  function currentPeriod(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  // SVG presentation properties that are commonly set via CSS classes (and thus
  // dropped by html-to-image). Copying the computed value to an inline style
  // attribute forces the on-screen appearance into the rasterised image.
  const SVG_STYLE_PROPS = [
    'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap',
    'stroke-linejoin', 'opacity', 'fill-opacity', 'stroke-opacity',
    'font-size', 'font-family', 'font-weight', 'text-anchor',
  ];

  function inlineComputedSvgStyles(root: HTMLElement): void {
    root.querySelectorAll('svg, svg *').forEach((node) => {
      const el = node as SVGElement;
      const cs = window.getComputedStyle(el);
      let style = el.getAttribute('style') || '';
      for (const p of SVG_STYLE_PROPS) {
        const v = cs.getPropertyValue(p);
        if (v) style += `;${p}:${v}`;
      }
      el.setAttribute('style', style);
    });
  }

  const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * Primary capture: render the chart in a brief on-screen overlay and grab it
   * via Electron's native page capture (full fidelity — fonts/icons/CSS). The
   * chart is scaled to fit and centred, with inner scroll containers neutralised
   * so wide flow charts never capture a scrollbar.
   */
  async function captureChartNative(width: number, render: (host: HTMLElement) => void): Promise<string | undefined> {
    const bridge = (window as any).cyrus;
    if (!bridge || typeof bridge.captureRegion !== 'function') return undefined;

    const PAD = 16;
    const overlay = document.createElement('div');
    overlay.style.cssText =
      `position:fixed;left:0;top:0;z-index:2147483647;background:#0f172a;` +
      `padding:${PAD}px;box-sizing:border-box;overflow:hidden;`;
    const host = document.createElement('div');
    host.style.cssText = `width:${width}px;transform-origin:top left;`;
    overlay.appendChild(host);
    document.body.appendChild(overlay);

    try {
      render(host);
      await raf2();
      await delay(280);

      // Kill any inner horizontal/vertical scroll containers so the full chart
      // shows (no captured scrollbar).
      host.querySelectorAll<HTMLElement>('*').forEach((el) => {
        const cs = window.getComputedStyle(el);
        if (/(auto|scroll)/.test(cs.overflow + cs.overflowX + cs.overflowY)) {
          el.style.overflow = 'visible';
        }
      });
      await delay(40);

      const naturalW = Math.max(host.scrollWidth, host.offsetWidth, width);
      const naturalH = Math.max(host.scrollHeight, host.offsetHeight, 1);
      const maxW = Math.min(window.innerWidth - 80, 1100);
      const maxH = Math.min(window.innerHeight - 80, 760);
      const scale = Math.min(1, maxW / naturalW, maxH / naturalH);
      host.style.transform = `scale(${scale})`;

      const boxW = Math.ceil(naturalW * scale) + PAD * 2;
      const boxH = Math.ceil(naturalH * scale) + PAD * 2;
      overlay.style.width = `${boxW}px`;
      overlay.style.height = `${boxH}px`;
      await delay(60);

      const r = overlay.getBoundingClientRect();
      const dataUrl = await bridge.captureRegion({
        x: r.left, y: r.top, width: r.width, height: r.height,
      });
      return dataUrl || undefined;
    } catch {
      return undefined;
    } finally {
      overlay.remove();
    }
  }

  /** Fallback capture (html-to-image) if native capture is unavailable. */
  async function captureChartH2I(width: number, render: (host: HTMLElement) => void): Promise<string | undefined> {
    const h2i = (window as any).htmlToImage;
    if (!h2i) return undefined;

    // Off-screen positioning lives on an OUTER wrapper, not the captured node —
    // html-to-image clones the node with its inline styles, so a left:-100000px
    // on it would push the content off the canvas (background-only image).
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:fixed;left:-100000px;top:0;z-index:-1;';
    const host = document.createElement('div');
    host.style.cssText = `width:${width}px;background:#0f172a;padding:16px;box-sizing:border-box;overflow:hidden;`;
    wrapper.appendChild(host);
    document.body.appendChild(wrapper);

    try {
      render(host);
      await raf2();
      await delay(250);
      inlineComputedSvgStyles(host);

      const opts = {
        backgroundColor: '#0f172a', quality: 0.92, pixelRatio: 2, cacheBust: true,
        skipFonts: true, width: host.offsetWidth, height: host.offsetHeight,
      };
      let url: string | undefined;
      for (let i = 0; i < 3; i++) {
        url = await h2i.toJpeg(host, opts);
        await delay(80);
      }
      return url;
    } catch {
      return undefined;
    } finally {
      wrapper.remove();
    }
  }

  /** Capture a chart, preferring native page capture, falling back to html-to-image. */
  async function captureChart(width: number, render: (host: HTMLElement) => void): Promise<string | undefined> {
    return (await captureChartNative(width, render)) || (await captureChartH2I(width, render));
  }

  async function gatherPortfolio(): Promise<{ positions: any[]; total: number }> {
    const isAll = ExchangeStore.isAllMode();
    const targets: number[] = isAll
      ? ExchangeStore.connections.map((c: any) => c.id)
      : (typeof ExchangeStore.activeMode === 'number' ? [ExchangeStore.activeMode] : []);

    if (targets.length === 0) return { positions: [], total: 0 };

    const results = await Promise.all(targets.map((id: number) =>
      ExchangeController.getPortfolio(id).catch(() => ({ positions: [], total_usd: 0 }))
    ));

    const byAsset = new Map<string, { asset: string; amount: number; usd_value: number }>();
    let total = 0;
    for (const r of results) {
      for (const p of (r.positions || [])) {
        const cur = byAsset.get(p.asset);
        if (cur) { cur.amount += p.amount; cur.usd_value += p.usd_value; }
        else byAsset.set(p.asset, { asset: p.asset, amount: p.amount, usd_value: p.usd_value });
        total += p.usd_value;
      }
    }
    const positions = [...byAsset.values()].sort((a, b) => b.usd_value - a.usd_value);
    return { positions, total };
  }

  async function gatherRules(): Promise<any[]> {
    try {
      const all = await AutomationController.getRules();
      const isAll = ExchangeStore.isAllMode();
      const activeId = ExchangeStore.activeMode;
      return isAll ? all : all.filter((r: any) => r.trigger_exchange_id === activeId);
    } catch {
      return [];
    }
  }

  /** Plain-English "when …" description of a rule's trigger. */
  function describeTrigger(r: any): string {
    switch (r.trigger_type) {
      case 'order_filled':
        if (r.trigger_pair && r.trigger_side) return `a ${r.trigger_side} order on ${r.trigger_pair} fills`;
        if (r.trigger_order_id) return `order ${String(r.trigger_order_id).slice(0, 10)} fills`;
        return 'an order fills';
      case 'balance_threshold':
        return `${r.trigger_asset} balance reaches ${r.trigger_threshold}`;
      case 'price_threshold':
        return `${r.trigger_asset} price reaches ${r.trigger_threshold} ${r.trigger_price_quote_asset || 'USD'}`;
      default:
        return r.trigger_type || '—';
    }
  }

  /** Plain-English "then …" description of a rule's action. */
  function describeAction(r: any): string {
    if (r.action_type === 'withdraw_crypto') {
      const amt = r.use_filled_amount ? 'the filled amount of' : (r.action_amount || '');
      return `withdraw ${amt} ${r.action_asset || ''} to ${r.action_address_key || 'a saved address'}`
        .replace(/\s+/g, ' ').trim();
    }
    if (r.action_type === 'convert_crypto') {
      const mode = (r.action_amount_mode || '').toLowerCase();
      let amt = '';
      if (mode === 'percent') amt = `${r.action_amount}% of `;
      else if (mode === 'fixed' && r.action_amount) amt = `${r.action_amount} `;
      return `convert ${amt}${r.action_asset || ''} → ${r.convert_to_asset || ''}`
        .replace(/\s+/g, ' ').trim();
    }
    return r.action_type || '—';
  }

  async function buildPayload(period: string, test: boolean): Promise<any> {
    // Portfolio holdings & month-over-month change are computed server-side from
    // the daily snapshots, so we only send automations + open orders here.
    const rules = await gatherRules();
    const orders: any[] = ExchangeStore.openOrders || [];

    const automations = rules.map((r: any) => ({
      name: r.rule_name || 'Automation',
      trigger: describeTrigger(r),
      action: describeAction(r),
      status: r.is_active ? 'Active' : 'Paused',
    }));

    const open_orders = orders.map((o: any) => ({
      pair: o.pair || '',
      side: (o.side || '').toUpperCase(),
      amount: o.volume || o.amount || '',
      price: (o.price && Number(o.price) > 0) ? o.price : 'Market',
      status: o.status || '',
    }));

    return {
      period,
      test,
      automations,
      open_orders,
      rules_count: rules.length,
      orders_count: orders.length,
    };
  }

  /** Send a test report for the current month (not recorded as the monthly send). */
  async function sendTest(): Promise<string> {
    const payload = await buildPayload(currentPeriod(), true);
    return ReportController.sendMonthly(payload);
  }

  /** Once per session: if last month's report is owed, build and send it. */
  async function runScheduledIfDue(): Promise<void> {
    if (scheduledChecked) return;
    scheduledChecked = true;
    try {
      const status = await ReportController.getStatus();
      if (!status || !status.due || !status.period) return;
      const payload = await buildPayload(status.period, false);
      await ReportController.sendMonthly(payload);
      console.log(`[REPORT] Monthly report sent for ${status.period}`);
    } catch (e) {
      // Best-effort; will retry next session.
      console.warn('[REPORT] Scheduled monthly report failed:', e);
    }
  }

  return { sendTest, runScheduledIfDue };
})();
