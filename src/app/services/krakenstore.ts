class KrakenStore {
  private static readonly REFRESH_INTERVAL = 15000;
  private static timer: number | null = null;
  private static listeners: Array<() => void> = [];

  static openOrders: any[] = [];
  static withdrawalAddresses: any[] = [];
  static lastUpdated: Date | null = null;
  static error: string | null = null;

  static start(): void {
    if (KrakenStore.timer !== null) return;

    KrakenStore.refresh();
    KrakenStore.timer = window.setInterval(() => KrakenStore.refresh(), KrakenStore.REFRESH_INTERVAL);
  }

  static stop(): void {
    if (KrakenStore.timer !== null) {
      window.clearInterval(KrakenStore.timer);
      KrakenStore.timer = null;
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

  static async refresh(): Promise<void> {
    try {
      const [orders, addresses] = await Promise.all([
        KrakenController.getOpenOrders(),
        KrakenController.getWithdrawalAddresses(),
      ]);
      KrakenStore.openOrders = orders;
      KrakenStore.withdrawalAddresses = addresses;
      KrakenStore.lastUpdated = new Date();
      KrakenStore.error = null;
    } catch (err: any) {
      KrakenStore.error = err.message || 'Failed to fetch Kraken data';
    }

    for (const cb of KrakenStore.listeners) {
      try { cb(); } catch (_) {}
    }
  }
}
