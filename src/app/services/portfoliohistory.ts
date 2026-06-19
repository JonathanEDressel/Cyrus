/**
 * PortfolioHistoryChart — portfolio value over time (multi-line).
 *
 * Renders a bold "Total" line plus a line per top holding (the backend groups
 * the long tail into "Other"). Built on lightweight-charts. A legend toggles
 * each line; range buttons (12 HR … 3Y, All) are gated to what's actually been
 * recorded. Estimated points (backfilled while the app was closed) are drawn as
 * a dashed overlay so they read as approximate.
 *
 * Usage:
 *   const handle = PortfolioHistoryChart.create(container, {
 *     fetch: (range) => ExchangeController.getPortfolioHistory(range, connId),
 *   });
 *   handle.reload();   // re-fetch current range (e.g. exchange switched)
 *   handle.destroy();  // tear down
 */
const PortfolioHistoryChart = (() => {
  const LightweightCharts = (window as any).LightweightCharts;

  const RANGES: Array<{ key: string; label: string; seconds: number | null }> = [
    { key: '12H', label: '12 HR', seconds: 12 * 3600 },
    { key: '24H', label: '24 HR', seconds: 24 * 3600 },
    { key: '7D',  label: '7 D',   seconds: 7 * 86400 },
    { key: '1M',  label: '1 M',   seconds: 30 * 86400 },
    { key: '3M',  label: '3 M',   seconds: 90 * 86400 },
    { key: '6M',  label: '6 M',   seconds: 180 * 86400 },
    { key: '1Y',  label: '1 Y',   seconds: 365 * 86400 },
    { key: '3Y',  label: '3 Y',   seconds: 3 * 365 * 86400 },
    { key: 'ALL', label: 'All',   seconds: null },
  ];

  const INTRADAY = new Set(['12H', '24H']);
  const DEFAULT_RANGE = '1M';
  const STORAGE_KEY = 'cyrus_pfh_range';
  // Withhold the chart until this many snapshots have been recorded.
  const MIN_RECORDS = 20;

  const TOTAL_COLOR = '#06b6d4';
  const PALETTE = ['#8b5cf6', '#22c55e', '#f59e0b', '#3b82f6', '#ec4899',
                   '#14b8a6', '#eab308', '#a78bfa', '#f97316', '#64748b'];

  interface Opts {
    fetch: (range: string) => Promise<any>;
    isDark?: boolean;
  }

  function esc(s: any): string {
    const d = document.createElement('div');
    d.textContent = String(s ?? '');
    return d.innerHTML;
  }

  function fmtUsd(n: number): string {
    const abs = Math.abs(n);
    const digits = abs >= 1000 ? 0 : abs >= 1 ? 2 : 4;
    return '$' + n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function create(container: HTMLElement, opts: Opts) {
    if (!container) return { reload() {}, destroy() {} };

    if (!LightweightCharts) {
      container.innerHTML = '<div class="pfh-empty"><i class="fa-solid fa-chart-line"></i><p>Chart library unavailable.</p></div>';
      return { reload() {}, destroy() {} };
    }

    let activeRange = localStorage.getItem(STORAGE_KEY) || DEFAULT_RANGE;
    let chart: any = null;
    let resizeObserver: ResizeObserver | null = null;
    let seriesList: Array<{ name: string; series: any; color: string }> = [];
    let disposed = false;
    let reqToken = 0;

    container.classList.add('pfh');
    container.innerHTML = `
      <div class="pfh-toolbar d-none" id="pfh-toolbar">
        <div class="pfh-range" id="pfh-range"></div>
      </div>
      <div class="pfh-chart" id="pfh-chart"></div>
      <div class="pfh-legend" id="pfh-legend"></div>
      <div class="pfh-note d-none" id="pfh-note">
        <i class="fa-solid fa-circle-info"></i>
        Dashed segments are estimated — the app was closed, so values assume holdings didn't change.
      </div>`;

    const toolbar = container.querySelector('#pfh-toolbar') as HTMLElement;
    const rangeBar = container.querySelector('#pfh-range') as HTMLElement;
    const chartEl = container.querySelector('#pfh-chart') as HTMLElement;
    const legendEl = container.querySelector('#pfh-legend') as HTMLElement;
    const noteEl = container.querySelector('#pfh-note') as HTMLElement;

    function renderRangeButtons(earliest: number | null): void {
      const nowSec = Math.floor(Date.now() / 1000);
      const span = earliest ? nowSec - earliest : 0;
      rangeBar.innerHTML = RANGES.map((r, i) => {
        // Always allow "All" and the smallest range; otherwise require enough
        // recorded history to cover the window.
        const enabled = r.seconds === null || i === 0 || span >= r.seconds;
        const active = r.key === activeRange ? ' active' : '';
        const dis = enabled ? '' : ' disabled';
        const title = enabled ? '' : ' title="Not enough history recorded yet"';
        return `<button class="pfh-range-btn${active}${dis}" data-range="${r.key}"${title} ${enabled ? '' : 'disabled'}>${r.label}</button>`;
      }).join('');
    }

    rangeBar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.pfh-range-btn') as HTMLElement | null;
      if (!btn || btn.hasAttribute('disabled')) return;
      const range = btn.getAttribute('data-range');
      if (!range || range === activeRange) return;
      activeRange = range;
      localStorage.setItem(STORAGE_KEY, range);
      rangeBar.querySelectorAll('.pfh-range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      load();
    });

    function teardownChart(): void {
      seriesList = [];
      if (resizeObserver) { try { resizeObserver.disconnect(); } catch {} resizeObserver = null; }
      if (chart) { try { chart.remove(); } catch {} chart = null; }
    }

    function buildChart(): void {
      const isDark = opts.isDark !== false;
      const gridColor   = isDark ? 'rgba(148,163,184,0.05)' : 'rgba(0,0,0,0.05)';
      const borderColor = isDark ? 'rgba(148,163,184,0.10)' : 'rgba(0,0,0,0.10)';
      const textColor   = '#64748b';

      chart = LightweightCharts.createChart(chartEl, {
        width: chartEl.clientWidth,
        height: 300,
        layout: { background: { type: 'solid', color: 'transparent' }, textColor, fontSize: 11 },
        grid: { vertLines: { color: gridColor }, horzLines: { color: gridColor } },
        rightPriceScale: { borderColor, scaleMargins: { top: 0.12, bottom: 0.08 } },
        timeScale: {
          borderColor,
          timeVisible: INTRADAY.has(activeRange),
          fixLeftEdge: true,
          fixRightEdge: true,
        },
        localization: { priceFormatter: (v: number) => fmtUsd(v) },
        crosshair: {
          mode: LightweightCharts.CrosshairMode.Normal,
          vertLine: { color: 'rgba(6,182,212,0.4)', labelBackgroundColor: '#0891b2' },
          horzLine: { color: 'rgba(6,182,212,0.4)', labelBackgroundColor: '#0891b2' },
        },
      });

      resizeObserver = new ResizeObserver(() => {
        if (disposed || !chart) return;
        if (chartEl.clientWidth > 0) {
          try { chart.applyOptions({ width: chartEl.clientWidth }); } catch {}
        }
      });
      resizeObserver.observe(chartEl);
    }

    /** Overlay data: values only on estimated points (+ their neighbours so the
     *  dashed segment connects), whitespace elsewhere. */
    function estimatedOverlay(total: any[]): any[] {
      const out: any[] = [];
      for (let i = 0; i < total.length; i++) {
        const p = total[i];
        const near = (p.estimated === 1)
          || (i > 0 && total[i - 1].estimated === 1)
          || (i < total.length - 1 && total[i + 1].estimated === 1);
        out.push(near ? { time: p.time, value: p.value } : { time: p.time });
      }
      return out;
    }

    function renderData(data: any): void {
      const total: any[] = data?.total || [];
      const assets: any[] = data?.assets || [];

      teardownChart();
      if (total.length === 0) {
        chartEl.innerHTML = '<div class="pfh-empty"><i class="fa-solid fa-chart-line"></i>'
          + '<p>No history yet for this range. Keep Cyrus open — a point is recorded every 30 minutes.</p></div>';
        legendEl.innerHTML = '';
        noteEl.classList.add('d-none');
        return;
      }
      chartEl.innerHTML = '';
      buildChart();

      const hideTime = !INTRADAY.has(activeRange);
      chart.applyOptions({ timeScale: { timeVisible: !hideTime } });

      // Per-asset lines (under the total).
      assets.forEach((a, i) => {
        const color = PALETTE[i % PALETTE.length];
        const s = chart.addSeries(LightweightCharts.LineSeries, {
          color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false,
          crosshairMarkerVisible: true,
        });
        s.setData((a.points || []).map((p: any) => ({ time: p.time, value: p.value })));
        seriesList.push({ name: a.asset, series: s, color });
      });

      // Total line (bold, on top).
      const totalSeries = chart.addSeries(LightweightCharts.LineSeries, {
        color: TOTAL_COLOR, lineWidth: 3, priceLineVisible: true,
        priceLineColor: 'rgba(6,182,212,0.4)', lastValueVisible: true,
      });
      totalSeries.setData(total.map((p: any) => ({ time: p.time, value: p.value })));
      seriesList.unshift({ name: 'Total', series: totalSeries, color: TOTAL_COLOR });

      // Estimated overlay (dashed) on top of the total.
      const overlay = estimatedOverlay(total);
      const hasEstimated = overlay.some(p => p.value !== undefined);
      if (hasEstimated) {
        const est = chart.addSeries(LightweightCharts.LineSeries, {
          color: TOTAL_COLOR, lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle?.Dashed ?? 1,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        });
        est.setData(overlay);
      }
      noteEl.classList.toggle('d-none', !hasEstimated);

      chart.timeScale().fitContent();
      renderLegend();
    }

    function renderLegend(): void {
      legendEl.innerHTML = seriesList.map((s, i) =>
        `<button class="pfh-legend-item" data-i="${i}">
           <span class="pfh-legend-swatch" style="background:${s.color}"></span>
           <span class="pfh-legend-name">${esc(s.name)}</span>
         </button>`
      ).join('');

      legendEl.querySelectorAll('.pfh-legend-item').forEach((el) => {
        el.addEventListener('click', () => {
          const i = parseInt(el.getAttribute('data-i') || '-1', 10);
          const entry = seriesList[i];
          if (!entry) return;
          const nowHidden = !el.classList.contains('off');
          el.classList.toggle('off', nowHidden);
          try { entry.series.applyOptions({ visible: !nowHidden }); } catch {}
        });
      });
    }

    function renderCollecting(count: number): void {
      teardownChart();
      toolbar.classList.add('d-none');
      legendEl.innerHTML = '';
      noteEl.classList.add('d-none');
      chartEl.innerHTML = `<div class="pfh-empty">
        <i class="fa-solid fa-hourglass-half"></i>
        <p>Collecting data… <strong>${count}/${MIN_RECORDS}</strong> records.<br>
        The chart appears once ${MIN_RECORDS} snapshots have been recorded.</p>
      </div>`;
    }

    async function load(): Promise<void> {
      const myToken = ++reqToken;
      chartEl.innerHTML = '<div class="pfh-empty"><i class="fa-solid fa-circle-notch fa-spin"></i><p>Loading history…</p></div>';
      try {
        const data = await opts.fetch(activeRange);
        if (disposed || myToken !== reqToken) return;

        const count = (data && typeof data.count === 'number') ? data.count : (data?.total?.length || 0);
        if (count < MIN_RECORDS) {
          renderCollecting(count);
          return;
        }

        toolbar.classList.remove('d-none');
        renderRangeButtons(data?.earliest ?? null);
        // If the active range got disabled (more than recorded), fall back.
        const activeBtn = rangeBar.querySelector(`.pfh-range-btn[data-range="${activeRange}"]`) as HTMLElement | null;
        if (activeBtn && activeBtn.hasAttribute('disabled')) {
          const enabled = Array.from(rangeBar.querySelectorAll('.pfh-range-btn'))
            .filter(b => !b.hasAttribute('disabled'));
          const fallback = enabled[enabled.length - 1] as HTMLElement | undefined;
          if (fallback) {
            activeRange = fallback.getAttribute('data-range') || 'ALL';
            localStorage.setItem(STORAGE_KEY, activeRange);
            return load();
          }
        }
        renderData(data);
      } catch {
        if (disposed || myToken !== reqToken) return;
        teardownChart();
        chartEl.innerHTML = '<div class="pfh-empty"><i class="fa-solid fa-triangle-exclamation"></i><p>Failed to load history.</p></div>';
      }
    }

    renderRangeButtons(null);
    load();

    return {
      reload() { if (!disposed) load(); },
      destroy() { disposed = true; teardownChart(); },
    };
  }

  return { create };
})();
