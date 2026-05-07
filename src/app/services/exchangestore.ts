class ExchangeStore {
  private static readonly ORDER_INTERVAL = 30000;
  private static readonly ADDRESS_INTERVAL = 3600000;
  private static orderTimer: number | null = null;
  private static addressTimer: number | null = null;
  private static listeners: Array<() => void> = [];
  private static connectionListeners: Array<() => void> = [];

  /** 'all' = aggregate every validated connection; number = single connection ID */
  static activeMode: 'all' | number | null = null;
  /** Kept for backward compat — in single mode equals the connection ID, in 'all' mode is null */
  static activeConnectionId: number | null = null;
  static connections: ExchangeConnection[] = [];
  /** Full list of supported exchanges with capability flags from /api/exchanges/supported. */
  static supportedExchanges: any[] = [];
  static openOrders: any[] = [];
  static withdrawalAddresses: any[] = [];
  static lastUpdated: Date | null = null;
  static error: string | null = null;

  // Per-connection data used in 'all' mode
  private static ordersByConn: Map<number, any[]> = new Map();
  private static addressesByConn: Map<number, any[]> = new Map();

  /** Load & cache validated connections and supported-exchange metadata.
   * Call once after login / on profile changes. */
  static async loadConnections(): Promise<void> {
    try {
      ExchangeStore.supportedExchanges = await ExchangeController.getSupportedExchanges();
    } catch {
      ExchangeStore.supportedExchanges = [];
    }
    try {
      const all = await ExchangeController.getConnections();
      ExchangeStore.connections = all.filter((c: any) => c.is_validated);
    } catch {
      ExchangeStore.connections = [];
    }
    ExchangeStore.notifyConnections();
  }

  /**
   * Returns true when the given exchange name supports crypto withdrawals
   * (i.e. has whitelisted withdrawal addresses).
   * Falls back to true for unknown exchanges so we never silently restrict.
   */
  static exchangeSupportsWithdrawals(exchangeName: string): boolean {
    const meta = ExchangeStore.supportedExchanges.find((e: any) => e.id === exchangeName);
    if (!meta) return true;
    return meta.has_withdrawal_addresses === true;
  }

  /** Start polling. mode = 'all' or a specific connection ID. */
  static start(mode: 'all' | number): void {
    if (ExchangeStore.orderTimer !== null && ExchangeStore.activeMode === mode) return;
    ExchangeStore.stopPolling();

    ExchangeStore.activeMode = mode;
    ExchangeStore.activeConnectionId = typeof mode === 'number' ? mode : null;

    ExchangeStore.refreshOrders();
    ExchangeStore.refreshAddresses();
    ExchangeStore.orderTimer = window.setInterval(() => ExchangeStore.refreshOrders(), ExchangeStore.ORDER_INTERVAL);
    ExchangeStore.addressTimer = window.setInterval(() => ExchangeStore.refreshAddresses(), ExchangeStore.ADDRESS_INTERVAL);
  }

  /** Switch mode without full stop (preserves listeners). */
  static setMode(mode: 'all' | number): void {
    ExchangeStore.stopPolling();
    ExchangeStore.openOrders = [];
    ExchangeStore.withdrawalAddresses = [];
    ExchangeStore.ordersByConn.clear();
    ExchangeStore.addressesByConn.clear();
    ExchangeStore.lastUpdated = null;
    ExchangeStore.error = null;
    ExchangeStore.start(mode);
  }

  /** Full stop — clears everything including listeners. */
  static stop(): void {
    ExchangeStore.stopPolling();
    ExchangeStore.activeMode = null;
    ExchangeStore.activeConnectionId = null;
    ExchangeStore.openOrders = [];
    ExchangeStore.withdrawalAddresses = [];
    ExchangeStore.ordersByConn.clear();
    ExchangeStore.addressesByConn.clear();
    ExchangeStore.lastUpdated = null;
    ExchangeStore.error = null;
    ExchangeStore.listeners = [];
    ExchangeStore.connectionListeners = [];
  }

  private static stopPolling(): void {
    if (ExchangeStore.orderTimer !== null) {
      window.clearInterval(ExchangeStore.orderTimer);
      ExchangeStore.orderTimer = null;
    }
    if (ExchangeStore.addressTimer !== null) {
      window.clearInterval(ExchangeStore.addressTimer);
      ExchangeStore.addressTimer = null;
    }
  }

  static onUpdate(callback: () => void): () => void {
    ExchangeStore.listeners.push(callback);
    return () => {
      ExchangeStore.listeners = ExchangeStore.listeners.filter(cb => cb !== callback);
    };
  }

  static onConnectionsChange(callback: () => void): () => void {
    ExchangeStore.connectionListeners.push(callback);
    return () => {
      ExchangeStore.connectionListeners = ExchangeStore.connectionListeners.filter(cb => cb !== callback);
    };
  }

  private static notify(): void {
    for (const cb of ExchangeStore.listeners) {
      try { cb(); } catch (_) {}
    }
  }

  private static notifyConnections(): void {
    for (const cb of ExchangeStore.connectionListeners) {
      try { cb(); } catch (_) {}
    }
  }

  /** Get the display name for a connection ID */
  static getExchangeName(connectionId: number): string {
    const conn = ExchangeStore.connections.find(c => c.id === connectionId);
    if (!conn) return 'Unknown';
    return conn.label && conn.label !== 'Default'
      ? `${conn.label}`
      : conn.exchange_name.charAt(0).toUpperCase() + conn.exchange_name.slice(1);
  }

  static isAllMode(): boolean {
    return ExchangeStore.activeMode === 'all';
  }

  // ---------------------------------------------------------------------------
  // Refresh logic
  // ---------------------------------------------------------------------------

  static async refreshOrders(): Promise<void> {
    if (ExchangeStore.activeMode === null) return;

    if (typeof ExchangeStore.activeMode === 'number') {
      // Single connection
      try {
        const orders = await ExchangeController.getOpenOrders(ExchangeStore.activeMode);
        const name = ExchangeStore.getExchangeName(ExchangeStore.activeMode);
        ExchangeStore.openOrders = orders.map((o: any) => ({
          ...o,
          connectionId: ExchangeStore.activeMode,
          exchangeName: name,
        }));
        ExchangeStore.lastUpdated = new Date();
        ExchangeStore.error = null;
      } catch (err: any) {
        ExchangeStore.error = err.message || 'Failed to fetch exchange data';
      }
    } else {
      // All connections
      const results: any[] = [];
      let anyError: string | null = null;
      for (const conn of ExchangeStore.connections) {
        try {
          const orders = await ExchangeController.getOpenOrders(conn.id);
          const name = ExchangeStore.getExchangeName(conn.id);
          const tagged = orders.map((o: any) => ({ ...o, connectionId: conn.id, exchangeName: name }));
          ExchangeStore.ordersByConn.set(conn.id, tagged);
          results.push(...tagged);
        } catch (err: any) {
          anyError = anyError || (err.message || `Failed to fetch orders for ${conn.exchange_name}`);
        }
      }
      ExchangeStore.openOrders = results;
      ExchangeStore.lastUpdated = new Date();
      ExchangeStore.error = anyError;
    }
    ExchangeStore.notify();
  }

  static async refreshAddresses(): Promise<void> {
    if (ExchangeStore.activeMode === null) return;

    if (typeof ExchangeStore.activeMode === 'number') {
      try {
        const addresses = await ExchangeController.getWithdrawalAddresses(ExchangeStore.activeMode);
        const name = ExchangeStore.getExchangeName(ExchangeStore.activeMode);
        ExchangeStore.withdrawalAddresses = addresses.map((a: any) => ({
          ...a,
          connectionId: ExchangeStore.activeMode,
          exchangeName: name,
        }));
        ExchangeStore.error = null;
      } catch (err: any) {
        ExchangeStore.error = err.message || 'Failed to fetch withdrawal addresses';
      }
    } else {
      const results: any[] = [];
      let anyError: string | null = null;
      for (const conn of ExchangeStore.connections) {
        try {
          const addresses = await ExchangeController.getWithdrawalAddresses(conn.id);
          const name = ExchangeStore.getExchangeName(conn.id);
          const tagged = addresses.map((a: any) => ({ ...a, connectionId: conn.id, exchangeName: name }));
          ExchangeStore.addressesByConn.set(conn.id, tagged);
          results.push(...tagged);
        } catch (err: any) {
          anyError = anyError || (err.message || `Failed to fetch addresses for ${conn.exchange_name}`);
        }
      }
      ExchangeStore.withdrawalAddresses = results;
      ExchangeStore.error = anyError;
    }
    ExchangeStore.notify();
  }
}
