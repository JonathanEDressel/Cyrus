class KrakenStore {
  private static readonly DEFAULT_INTERVAL = 60000;
  private static readonly ORDER_INTERVAL = 15000;
  private static readonly ADDRESS_INTERVAL = 3600000;
  private static orderTimer: number | null = null;
  private static addressTimer: number | null = null;
  private static listeners: Array<() => void> = [];

  static openOrders: any[] = [];
  static withdrawalAddresses: any[] = [];
  static lastUpdated: Date | null = null;
  static error: string | null = null;

  static start(): void {
    if (KrakenStore.orderTimer !== null) return;

    // Don't start polling if keys aren't valid
    const status = ApiKeyState.status;
    if (status === 'none' || status === 'invalid') return;

    KrakenStore.refreshOrders();
    KrakenStore.refreshAddresses();
    KrakenStore.orderTimer = window.setInterval(() => KrakenStore.refreshOrders(), KrakenStore.ORDER_INTERVAL);
    KrakenStore.addressTimer = window.setInterval(() => KrakenStore.refreshAddresses(), KrakenStore.DEFAULT_INTERVAL); //ADDRESS_INTERVAL
  }

  static stop(): void {
    if (KrakenStore.orderTimer !== null) {
      window.clearInterval(KrakenStore.orderTimer);
      KrakenStore.orderTimer = null;
    }
    if (KrakenStore.addressTimer !== null) {
      window.clearInterval(KrakenStore.addressTimer);
      KrakenStore.addressTimer = null;
    }
    KrakenStore.openOrders = [];
    KrakenStore.withdrawalAddresses = [];
    KrakenStore.lastUpdated = null;
    KrakenStore.error = null;
    KrakenStore.listeners = [];
  }

  static onUpdate(callback: () => void): () => void {
    KrakenStore.listeners.push(callback);
    return () => {
      KrakenStore.listeners = KrakenStore.listeners.filter(cb => cb !== callback);
    };
  }

  private static notify(): void {
    for (const cb of KrakenStore.listeners) {
      try { cb(); } catch (_) {}
    }
  }

  static async refreshOrders(): Promise<void> {
    try {
      KrakenStore.openOrders = await KrakenController.getOpenOrders();
      KrakenStore.lastUpdated = new Date();
      KrakenStore.error = null;
    } catch (err: any) {
      KrakenStore.error = err.message || 'Failed to fetch Kraken data';
    }
    KrakenStore.notify();
  }

  static async refreshAddresses(): Promise<void> {
    try {
      KrakenStore.withdrawalAddresses = await KrakenController.getWithdrawalAddresses();
      KrakenStore.error = null;
    } catch (err: any) {
      KrakenStore.error = err.message || 'Failed to fetch withdrawal addresses';
    }
    KrakenStore.notify();
  }
}
