/**
 * Runs the Limit Orders page's long jobs (placing a staggered ladder, bulk
 * cancelling) outside the page, so they keep going when you navigate away.
 *
 * The loops used to live in LimitOrdersController and stopped as soon as the
 * router swapped the view out. Services load once from index.html and outlive
 * every route, so the loop lives here and the page is just a view of it: it
 * subscribes with onUpdate() while it is showing and redraws from current()
 * when you come back.
 *
 * One job at a time, of either kind. Both send rate-limited private calls with
 * the same keys, so running two at once would only trip the exchange's limits.
 *
 * Closing or reloading the window still ends a job, because the renderer is
 * gone. The beforeunload guard below warns about that.
 */

type OrderJobLegStatus = 'queued' | 'placing' | 'placed' | 'failed' | 'skipped';

interface OrderJobLeg {
  /** The page's leg id, so the progress table can address a row. */
  id: string;
  pair: string;
  price: number;
  amount: number;
  /** Snapshotted from the market grid: a page that comes back has not loaded it yet. */
  priceDecimals: number;
  amountDecimals: number;
  /**
   * Sent as client_order_id. Minted once per leg, so a retried request reuses
   * it, and random, because Kraken rejects one that any open order already
   * carries and earlier ladders are still resting.
   */
  clientOrderId: string;
  status: OrderJobLegStatus;
  orderId: string | null;
  error: string | null;
}

interface PlaceOrderJob {
  kind: 'place';
  connId: number;
  exchangeName: string;
  side: 'buy' | 'sell';
  base: string;
  postOnly: boolean;
  /** Wait between placements. */
  paceMs: number;
  legs: OrderJobLeg[];
  running: boolean;
  cancelRequested: boolean;
  placed: number;
  failed: number;
  /** Why the run stopped early on its own (a fatal error), for the page to show. */
  stopReason: string | null;
}

type CancelItemStatus = 'waiting' | 'working' | 'done' | 'failed' | 'skipped';

interface CancelOrderItem {
  /** `connectionId:orderId`, the page's selection key. */
  key: string;
  connectionId: number;
  orderId: string;
  pair: string;
  /** The order row as the page had it, so a page that comes back can redraw the list. */
  order: any;
  status: CancelItemStatus;
  /** "Cancelled", "Submitted" or the error message. */
  detail: string | null;
}

interface CancelOrderJob {
  kind: 'cancel';
  paceMs: number;
  items: CancelOrderItem[];
  running: boolean;
  cancelRequested: boolean;
  /** Items processed so far, failures included. */
  done: number;
  failed: number;
}

type OrderJob = PlaceOrderJob | CancelOrderJob;

interface OrderJobEvent {
  job: OrderJob | null;
  /** The leg id or cancel key that just changed, when it was a single row. */
  changed?: string;
  /** Set on the one event fired when the job ends. */
  finished?: boolean;
}

interface PlaceJobInit {
  connId: number;
  exchangeName: string;
  side: 'buy' | 'sell';
  base: string;
  postOnly: boolean;
  paceMs: number;
  legs: Array<{
    id: string; pair: string; price: number; amount: number;
    priceDecimals: number; amountDecimals: number;
  }>;
}

interface CancelJobInit {
  paceMs: number;
  items: Array<{ key: string; connectionId: number; orderId: string; pair: string; order: any }>;
}

class OrderJobRunner {
  private static job: OrderJob | null = null;
  private static listeners = new Set<(e: OrderJobEvent) => void>();
  private static beforeUnload: ((e: BeforeUnloadEvent) => void) | null = null;
  private static toastTimer = 0;

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  static current(): OrderJob | null {
    return OrderJobRunner.job;
  }

  static isBusy(): boolean {
    return !!OrderJobRunner.job && OrderJobRunner.job.running;
  }

  static onUpdate(callback: (e: OrderJobEvent) => void): () => void {
    OrderJobRunner.listeners.add(callback);
    return () => { OrderJobRunner.listeners.delete(callback); };
  }

  /** Start placing a ladder. False if a job is already running. */
  static startPlace(init: PlaceJobInit): boolean {
    if (OrderJobRunner.isBusy() || init.legs.length === 0) return false;
    const job: PlaceOrderJob = {
      kind: 'place',
      connId: init.connId,
      exchangeName: init.exchangeName,
      side: init.side,
      base: init.base,
      postOnly: init.postOnly,
      paceMs: init.paceMs,
      legs: init.legs.map(leg => ({
        ...leg,
        clientOrderId: OrderJobRunner.newClientOrderId(),
        status: 'queued' as OrderJobLegStatus,
        orderId: null,
        error: null,
      })),
      running: true,
      cancelRequested: false,
      placed: 0,
      failed: 0,
      stopReason: null,
    };
    OrderJobRunner.begin(job);
    void OrderJobRunner.runPlace(job);
    return true;
  }

  /** Start cancelling a list of orders. False if a job is already running. */
  static startCancel(init: CancelJobInit): boolean {
    if (OrderJobRunner.isBusy() || init.items.length === 0) return false;
    const job: CancelOrderJob = {
      kind: 'cancel',
      paceMs: init.paceMs,
      items: init.items.map(item => ({
        ...item, status: 'waiting' as CancelItemStatus, detail: null,
      })),
      running: true,
      cancelRequested: false,
      done: 0,
      failed: 0,
    };
    OrderJobRunner.begin(job);
    void OrderJobRunner.runCancel(job);
    return true;
  }

  /**
   * Stop sending. The item in flight finishes; everything still queued is
   * marked not sent straight away so the tables match what will happen.
   */
  static stop(): void {
    const job = OrderJobRunner.job;
    if (!job || !job.running) return;
    job.cancelRequested = true;
    if (job.kind === 'place') {
      for (const leg of job.legs) if (leg.status === 'queued') leg.status = 'skipped';
    } else {
      for (const item of job.items) if (item.status === 'waiting') item.status = 'skipped';
    }
    OrderJobRunner.emit({ job });
  }

  /** Forget a finished job (the page's Dismiss). No-op while one is running. */
  static clear(): void {
    if (OrderJobRunner.isBusy()) return;
    OrderJobRunner.job = null;
    OrderJobRunner.renderPill();
    OrderJobRunner.emit({ job: null });
  }

  // ---------------------------------------------------------------------------
  // Loops
  // ---------------------------------------------------------------------------

  private static async runPlace(job: PlaceOrderJob): Promise<void> {
    for (let i = 0; i < job.legs.length; i++) {
      const leg = job.legs[i];
      if (job.cancelRequested) {
        if (leg.status === 'queued') leg.status = 'skipped';
        OrderJobRunner.emit({ job, changed: leg.id });
        continue;
      }

      leg.status = 'placing';
      OrderJobRunner.emit({ job, changed: leg.id });

      try {
        // Looked up at call time, so DemoMode's patch of createOrder applies.
        const result = await ExchangeController.createOrder(job.connId, {
          symbol: leg.pair,
          side: job.side,
          type: 'limit',
          amount: leg.amount,
          price: leg.price,
          post_only: job.postOnly,
          client_order_id: leg.clientOrderId,
        });
        leg.orderId = String(result?.id || '');
        leg.status = 'placed';
        job.placed++;
      } catch (err: any) {
        leg.error = err?.message || 'The exchange rejected this order.';
        leg.status = 'failed';
        job.failed++;
        if (OrderJobRunner.isFatalPlacementError(err)) {
          job.stopReason = `Stopped after ${job.placed} of ${job.legs.length} orders: ${leg.error}`;
          job.cancelRequested = true;
        }
      }

      OrderJobRunner.emit({ job, changed: leg.id });

      // Pace between placements only — no trailing wait after the last one.
      if (!job.cancelRequested && i < job.legs.length - 1) {
        await OrderJobRunner.sleep(job.paceMs);
      }
    }

    job.running = false;
    await OrderJobRunner.finish(job, [job.connId]);
  }

  /**
   * Sequential and paced rather than parallel: these are private, rate-limited
   * calls against the same keys the automation worker uses, and a burst that
   * trips a throttle would leave an unknown subset cancelled. A failure never
   * stops the run — one synthetic-pair order Kraken refuses must not strand the
   * other nineteen.
   */
  private static async runCancel(job: CancelOrderJob): Promise<void> {
    const touched = new Set<number>();

    for (let i = 0; i < job.items.length; i++) {
      const item = job.items[i];
      if (job.cancelRequested) {
        if (item.status === 'waiting') item.status = 'skipped';
        OrderJobRunner.emit({ job, changed: item.key });
        continue;
      }

      item.status = 'working';
      OrderJobRunner.emit({ job, changed: item.key });

      try {
        const result = await ExchangeController.cancelOrder(
          item.connectionId, item.orderId, item.pair);
        touched.add(item.connectionId);
        // Robinhood only acknowledges the request and cancels asynchronously,
        // so don't claim it's gone.
        const pending = String(result?.status || '').toLowerCase() === 'canceling';
        item.status = 'done';
        item.detail = pending ? 'Submitted' : 'Cancelled';
      } catch (err: any) {
        item.status = 'failed';
        item.detail = err?.message || 'Failed';
        job.failed++;
      }

      job.done++;
      OrderJobRunner.emit({ job, changed: item.key });

      if (!job.cancelRequested && i < job.items.length - 1) {
        await OrderJobRunner.sleep(job.paceMs);
      }
    }

    job.running = false;
    await OrderJobRunner.finish(job, Array.from(touched));
  }

  private static begin(job: OrderJob): void {
    OrderJobRunner.job = job;
    OrderJobRunner.armUnloadGuard();
    OrderJobRunner.renderPill();
    OrderJobRunner.emit({ job });
  }

  private static async finish(job: OrderJob, connIds: number[]): Promise<void> {
    OrderJobRunner.disarmUnloadGuard();

    // Other pages share the store's per-connection cache, so drop each touched
    // connection's entry or they keep serving the pre-job snapshot.
    for (const id of connIds) ExchangeStore.invalidateConnectionData(id);

    OrderJobRunner.renderPill();
    OrderJobRunner.emit({ job, finished: true });

    // The Limit Orders page reports its own result; anywhere else gets a toast.
    const route = typeof router !== 'undefined' ? router.getCurrentRoute() : '';
    if (route !== 'limitorders') OrderJobRunner.showToast(OrderJobRunner.resultText(job));

    // Best-effort: the orders already went, so a failed refresh mustn't read as
    // though the job failed. The next poll picks it up.
    try {
      await ExchangeStore.refreshOrders();
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Errors that guarantee every remaining leg fails too. */
  private static isFatalPlacementError(err: any): boolean {
    if (err?.keys_invalid) return true;
    const message = String(err?.message || '').toLowerCase();
    return message.includes('authentic') || message.includes('unauthor')
        || message.includes('api key') || message.includes('rate limit')
        || message.includes('too many requests')
        // The budget is gone, so later legs can't fit either.
        || message.includes('insufficient') || message.includes('not enough');
  }

  /**
   * A random v4 UUID. A UUID is the one format every exchange takes: Kraken
   * accepts it as cl_ord_id (free text is capped at 18 characters), Binance
   * allows up to 36, and Robinhood expects one.
   */
  private static newClientOrderId(): string {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-`
         + `${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

  private static emit(event: OrderJobEvent): void {
    OrderJobRunner.renderPill();
    for (const cb of Array.from(OrderJobRunner.listeners)) {
      // One broken listener (a page mid-teardown) must not stop the loop.
      try { cb(event); } catch (e) { console.error('[OrderJobRunner] listener failed', e); }
    }
  }

  /** The one-line outcome, worded as the page words it. */
  static resultText(job: OrderJob): string {
    if (job.kind === 'place') {
      const n = job.legs.length;
      const skipped = job.legs.filter(l => l.status === 'skipped').length;
      let text = `Placed ${job.placed} of ${n} ${job.side} limit order${n === 1 ? '' : 's'} `
               + `for ${job.base} on ${job.exchangeName}.`;
      if (job.failed > 0) text += ` ${job.failed} rejected.`;
      if (skipped > 0) text += ` ${skipped} not sent.`;
      return text;
    }
    const succeeded = job.done - job.failed;
    const skipped = job.items.filter(i => i.status === 'skipped').length;
    let text = succeeded === 1 ? 'Cancelled 1 limit order.' : `Cancelled ${succeeded} limit orders.`;
    if (job.failed > 0) text += ` ${job.failed} failed.`;
    if (skipped > 0) text += ` ${skipped} not sent.`;
    return text;
  }

  // ---------------------------------------------------------------------------
  // Sidebar pill + toast
  // ---------------------------------------------------------------------------

  /** The sidebar pill: live progress while running, the outcome once finished. */
  private static renderPill(): void {
    const pill = document.getElementById('order-job-pill');
    if (!pill) return;
    const job = OrderJobRunner.job;
    pill.classList.toggle('d-none', !job);
    if (!job) return;

    const icon = pill.querySelector('.order-job-pill-icon') as HTMLElement | null;
    const text = pill.querySelector('.order-job-pill-text') as HTMLElement | null;

    let label: string;
    let iconClass: string;
    let state: 'running' | 'ok' | 'warn';

    if (job.kind === 'place') {
      const n = job.legs.length;
      const sent = job.placed + job.failed;
      if (job.running) {
        label = `Placing ${job.base} ${n === 1 ? 'order' : 'ladder'} · ${sent}/${n}`;
        iconClass = 'fa-solid fa-spinner fa-spin';
        state = 'running';
      } else {
        const notPlaced = n - job.placed;
        label = notPlaced > 0
          ? `${job.base}: ${job.placed} placed · ${notPlaced} not placed`
          : `${job.base}: ${job.placed} placed`;
        iconClass = notPlaced > 0 ? 'fa-solid fa-triangle-exclamation' : 'fa-solid fa-check';
        state = notPlaced > 0 ? 'warn' : 'ok';
      }
    } else {
      const n = job.items.length;
      if (job.running) {
        label = `Cancelling orders · ${job.done}/${n}`;
        iconClass = 'fa-solid fa-spinner fa-spin';
        state = 'running';
      } else {
        const succeeded = job.done - job.failed;
        const notCancelled = n - succeeded;
        label = notCancelled > 0
          ? `${succeeded} cancelled · ${notCancelled} not cancelled`
          : `${succeeded} cancelled`;
        iconClass = notCancelled > 0 ? 'fa-solid fa-triangle-exclamation' : 'fa-solid fa-check';
        state = notCancelled > 0 ? 'warn' : 'ok';
      }
    }

    if (icon) icon.className = `order-job-pill-icon ${iconClass}`;
    if (text) text.textContent = label;
    pill.classList.toggle('is-running', state === 'running');
    pill.classList.toggle('is-ok', state === 'ok');
    pill.classList.toggle('is-warn', state === 'warn');
    pill.title = job.running ? 'Open Limit Orders to watch progress' : OrderJobRunner.resultText(job);
  }

  /** A clickable toast that opens Limit Orders. */
  private static showToast(message: string): void {
    let el = document.getElementById('order-job-toast') as HTMLButtonElement | null;
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.id = 'order-job-toast';
      el.className = 'order-job-toast';
      el.addEventListener('click', () => {
        el!.classList.remove('is-visible');
        if (typeof router !== 'undefined') void router.navigate('limitorders');
      });
      document.body.appendChild(el);
    }
    const toast = el;
    toast.textContent = message;
    // Force a reflow so the transition runs even when re-shown quickly.
    void toast.offsetWidth;
    toast.classList.add('is-visible');
    window.clearTimeout(OrderJobRunner.toastTimer);
    OrderJobRunner.toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 6000);
  }

  // ---------------------------------------------------------------------------
  // Window close / reload guard
  // ---------------------------------------------------------------------------

  private static armUnloadGuard(): void {
    if (OrderJobRunner.beforeUnload) return;
    OrderJobRunner.beforeUnload = (e: BeforeUnloadEvent) => {
      if (!OrderJobRunner.isBusy()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', OrderJobRunner.beforeUnload);
  }

  private static disarmUnloadGuard(): void {
    if (!OrderJobRunner.beforeUnload) return;
    window.removeEventListener('beforeunload', OrderJobRunner.beforeUnload);
    OrderJobRunner.beforeUnload = null;
  }
}
