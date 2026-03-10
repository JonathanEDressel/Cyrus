(function () {

class OpenOrdersController {
  private unsubscribe: (() => void) | null = null;

  constructor() {
    this.init();
  }

  private init(): void {
    this.render();

    this.unsubscribe = KrakenStore.onUpdate(() => this.render());

    const observer = new MutationObserver(() => {
      if (!document.getElementById('orders-table')) {
        if (this.unsubscribe) this.unsubscribe();
        observer.disconnect();
      }
    });
    const content = document.getElementById('app-content');
    if (content) observer.observe(content, { childList: true });
  }

  private render(): void {
    const orders = KrakenStore.openOrders;
    const error = KrakenStore.error;
    const lastUpdated = KrakenStore.lastUpdated;

    if (error) {
      this.showError(error);
      this.setRefreshLabel('');
    } else {
      this.hideError();
      this.renderOrders(orders);
      this.updateCountTitle(orders.length);
      if (lastUpdated) {
        this.setRefreshLabel(`Last updated: ${lastUpdated.toLocaleTimeString()}`);
      }
    }
  }

  private renderOrders(orders: any[]): void {
    const tbody = document.getElementById('orders-tbody');
    if (!tbody) return;

    if (orders.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="9">No open orders</td></tr>';
      return;
    }

    tbody.innerHTML = orders.map((o: any) => {
      const sideClass = o.side === 'buy' ? 'side-buy' : 'side-sell';
      const opened = o.opentm ? new Date(o.opentm * 1000).toLocaleString() : '--';
      const formattedPair = this.formatPair(o.pair);
      return `<tr>
        <td class="order-id-cell">${this.escapeHtml(o.id)}</td>
        <td>${this.escapeHtml(formattedPair)}</td>
        <td><span class="${sideClass}">${this.escapeHtml(o.side)}</span></td>
        <td>${this.escapeHtml(o.type)}</td>
        <td>${this.escapeHtml(o.price)}</td>
        <td>${this.escapeHtml(o.volume)}</td>
        <td>${this.escapeHtml(o.filled)}</td>
        <td><span class="status-badge">${this.escapeHtml(o.status)}</span></td>
        <td>${this.escapeHtml(opened)}</td>
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

  private updateCountTitle(count: number): void {
    const el = document.getElementById('orders-count-title');
    if (el) el.textContent = `Orders (${count})`;
  }

  private setRefreshLabel(text: string): void {
    const el = document.getElementById('refresh-label');
    if (el) el.textContent = text ? `\u2014 ${text}` : '';
  }

  private showError(message: string): void {
    const el = document.getElementById('orders-error');
    const msgEl = document.getElementById('orders-error-message');
    if (el && msgEl) {
      msgEl.textContent = message;
      el.classList.remove('d-none');
    }
  }

  private hideError(): void {
    const el = document.getElementById('orders-error');
    if (el) el.classList.add('d-none');
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }
}

new OpenOrdersController();

})();