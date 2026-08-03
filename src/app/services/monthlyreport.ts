/**
 * MonthlyReport — the Profile page's "send a test report" button.
 *
 * The report is composed entirely in the backend (`helper/monthly_report.py`)
 * from the DB and the exchanges, and the real monthly send is driven by the
 * automation worker so it goes out when the month turns over rather than when
 * someone happens to open this app. Nothing here contributes to its content —
 * this just asks the backend to send one now, marked as a test.
 *
 * The chart-capture helpers below are parked, not live: no chart images are
 * included in the email at the moment. They're kept because they're the working
 * half of putting them back (render offscreen → rasterise → POST as data URLs).
 */
const MonthlyReport = (() => {

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

  /**
   * Send a test report for the current month. Not recorded as the month's send,
   * so it doesn't stop the scheduled one going out.
   *
   * The backend fills in the content, which is the point: the test email is
   * identical to what the worker will send, rather than a version assembled from
   * whatever this window happens to have loaded.
   */
  async function sendTest(): Promise<string> {
    return ReportController.sendMonthly({ period: currentPeriod(), test: true });
  }

  return { sendTest };
})();
