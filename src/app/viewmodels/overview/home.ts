(function () {
class HomeController {
  private unsubscribe: (() => void) | null = null;

  constructor() {
    this.init();
  }

  private init(): void {
    this.attachEventListeners();
    this.loadDashboardData();

    this.unsubscribe = KrakenStore.onUpdate(() => this.renderFromStore());

    const observer = new MutationObserver(() => {
      if (!document.getElementById('orders-tbody')) {
        if (this.unsubscribe) this.unsubscribe();
        observer.disconnect();
      }
    });
    const content = document.getElementById('app-content');
    if (content) observer.observe(content, { childList: true });
  }

  private attachEventListeners(): void {
    document.getElementById('view-all-positions')?.addEventListener('click', () => {
      router.navigate('positions');
    });
    document.getElementById('view-all-orders')?.addEventListener('click', () => {
      router.navigate('openorders');
    });
    document.getElementById('view-all-commands')?.addEventListener('click', () => {
      router.navigate('commands');
    });
  }

  private loadDashboardData(): void {
    this.setCardValue('total-balance', '$0.00');
    this.setCardValue('open-positions-count', '0');
    this.setCardValue('custom-commands-count', '0');

    this.setTableEmpty('positions-tbody', 6, 'No open positions');

    this.renderFromStore();
    this.loadCommands();
  }

  private renderFromStore(): void {
    const orders = KrakenStore.openOrders;
    if (KrakenStore.error) {
      this.setTableEmpty('orders-tbody', 6, 'Failed to load orders');
      this.setCardValue('open-orders-count', '--');
    } else {
      this.renderOrders(orders);
      this.setCardValue('open-orders-count', orders.length.toString());
    }
  }

  private renderOrders(orders: any[]): void {
    const tbody = document.getElementById('orders-tbody');
    if (!tbody) return;

    if (orders.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No open orders</td></tr>';
      return;
    }

    const displayOrders = orders.slice(0, 5);

    tbody.innerHTML = displayOrders.map((o: any) => {
      const sideClass = o.side === 'buy' ? 'side-buy' : 'side-sell';
      const formattedPair = this.formatPair(o.pair);
      return `<tr>
        <td>${this.escapeHtml(formattedPair)}</td>
        <td>${this.escapeHtml(o.type)}</td>
        <td><span class="${sideClass}">${this.escapeHtml(o.side)}</span></td>
        <td>${this.escapeHtml(o.price)}</td>
        <td>${this.escapeHtml(o.volume)}</td>
        <td><span class="status-badge">${this.escapeHtml(o.status)}</span></td>
      </tr>`;
    }).join('');
  }

  private formatPair(pair: string): string {
    if (!pair) return pair;

    const QUOTE_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'USDT', 'USDC', 'DAI', 'BUSD'];
    
    let cleaned = pair;
    
    if (cleaned.startsWith('XX') && cleaned.length > 6) {
      cleaned = cleaned.substring(1);
    } else if (cleaned.startsWith('X') && cleaned.length > 6 && !cleaned.startsWith('XBT') && !cleaned.startsWith('XDG')) {
      cleaned = cleaned.substring(1);
    }
    
    for (const quote of QUOTE_CURRENCIES) {
      const zQuote = 'Z' + quote;
      if (cleaned.endsWith(zQuote)) {
        let base = cleaned.substring(0, cleaned.length - zQuote.length);
        base = this.normalizeBase(base);
        return `${base}/${quote}`;
      }
      if (cleaned.endsWith(quote)) {
        let base = cleaned.substring(0, cleaned.length - quote.length);
        base = this.normalizeBase(base);
        return `${base}/${quote}`;
      }
    }

    if (cleaned.length >= 6) {
      let base = cleaned.substring(0, cleaned.length - 3);
      const quote = cleaned.substring(cleaned.length - 3);
      base = this.normalizeBase(base);
      return `${base}/${quote}`;
    }

    return this.normalizeBase(cleaned);
  }

  private normalizeBase(base: string): string {
    if (base === 'XBT') return 'BTC';
    if (base === 'XDG') return 'DOGE';
    return base;
  }

  private async loadCommands(): Promise<void> {
    try {
      const rules = await AutomationController.getRules();
      this.renderCommands(rules);
      this.setCardValue('custom-commands-count', rules.length.toString());
    } catch {
      this.setTableEmpty('commands-tbody', 4, 'Failed to load commands');
    }
  }

  private renderCommands(rules: any[]): void {
    const tbody = document.getElementById('commands-tbody');
    if (!tbody) return;

    if (rules.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="4">No custom commands</td></tr>';
      return;
    }

    const display = rules.slice(0, 5);

    tbody.innerHTML = display.map((r: any) => {
      const statusClass = r.is_active ? 'status-active' : 'status-inactive';
      const statusText = r.is_active ? 'Active' : 'Paused';
      const orderId = r.trigger_order_id
        ? this.escapeHtml(r.trigger_order_id.substring(0, 10)) + '...'
        : 'Any';
      const trigger = `<span class="trigger-badge">Order Filled</span> <span class="mono-text">${orderId}</span>`;
      const action = r.action_type === 'withdraw_crypto'
        ? `Withdraw <strong>${this.escapeHtml(r.action_amount)}</strong> <span class="asset-badge">${this.escapeHtml(r.action_asset)}</span>`
        : this.escapeHtml(r.action_type);

      return `<tr>
        <td>${this.escapeHtml(r.rule_name)}</td>
        <td>${trigger}</td>
        <td>${action}</td>
        <td><span class="status-badge ${statusClass}">${statusText}</span></td>
      </tr>`;
    }).join('');
  }

  private setCardValue(id: string, value: string): void {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  private setTableEmpty(tbodyId: string, colspan: number, message: string): void {
    const tbody = document.getElementById(tbodyId);
    if (tbody) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="${colspan}">${message}</td></tr>`;
    }
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }
}

new HomeController();

})();