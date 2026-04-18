(function () {

class OpenOrdersController {
  private unsubscribe: (() => void) | null = null;

  constructor() {
    this.init();
  }

  private init(): void {
    this.render();

    this.unsubscribe = ExchangeStore.onUpdate(() => this.render());

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
    const orders = ExchangeStore.openOrders;
    const error = ExchangeStore.error;
    const lastUpdated = ExchangeStore.lastUpdated;
    const isAll = ExchangeStore.isAllMode();

    // Update subtitle
    const subtitle = document.getElementById('page-subtitle');
    if (subtitle) {
      const label = isAll ? '' : ` on ${ExchangeStore.getExchangeName(ExchangeStore.activeMode as number)}`;
      const refreshSpan = document.getElementById('refresh-label');
      const refreshHtml = refreshSpan ? refreshSpan.outerHTML : '';
      subtitle.innerHTML = `Your active orders${this.escapeHtml(label)} ${refreshHtml}`;
    }

    // Update thead for exchange column
    const thead = document.getElementById('orders-thead');
    if (thead) {
      const cols = isAll
        ? '<tr><th>Exchange</th><th>Order ID</th><th>Pair</th><th>Side</th><th>Type</th><th>Price</th><th>Volume</th><th>Filled</th><th>Status</th><th>Opened</th></tr>'
        : '<tr><th>Order ID</th><th>Pair</th><th>Side</th><th>Type</th><th>Price</th><th>Volume</th><th>Filled</th><th>Status</th><th>Opened</th></tr>';
      thead.innerHTML = cols;
    }

    if (error) {
      this.showError(error);
      this.setRefreshLabel('');
    } else {
      this.hideError();
      this.renderOrders(orders, isAll);
      this.updateCountTitle(orders.length);
      if (lastUpdated) {
        this.setRefreshLabel(`Last updated: ${lastUpdated.toLocaleTimeString()}`);
      }
    }
  }

  private renderOrders(orders: any[], isAll: boolean): void {
    const tbody = document.getElementById('orders-tbody');
    if (!tbody) return;

    const colspan = isAll ? 10 : 9;
    if (orders.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="${colspan}">No open orders</td></tr>`;
      return;
    }

    tbody.innerHTML = orders.map((o: any) => {
      const sideClass = o.side === 'buy' ? 'side-buy' : 'side-sell';
      const opened = o.opentm ? new Date(o.opentm).toLocaleString() : '--';
      const exchangeCol = isAll
        ? `<td><span class="exchange-badge exchange-${this.escapeHtml(o.exchangeName).toLowerCase()}">${this.escapeHtml(o.exchangeName)}</span></td>`
        : '';
      return `<tr>
        ${exchangeCol}
        <td class="order-id-cell">${this.escapeHtml(o.id)}</td>
        <td>${this.escapeHtml(o.pair)}</td>
        <td><span class="${sideClass}">${this.escapeHtml(o.side)}</span></td>
        <td>${this.escapeHtml(o.type)}</td>
        <td>${this.escapeHtml(o.price)}</td>
        <td>${this.escapeHtml(o.volume)}</td>
        <td>${this.escapeHtml(o.filled)}</td>
        <td><span class="status-badge status-${this.escapeHtml(o.status).toLowerCase().replace(/[^a-z]/g, '')}">${this.escapeHtml(o.status)}</span></td>
        <td>${this.escapeHtml(opened)}</td>
      </tr>`;
    }).join('');
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