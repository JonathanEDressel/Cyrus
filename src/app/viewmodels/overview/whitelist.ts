(function () {

class WhitelistController {
  private unsubscribe: (() => void) | null = null;

  constructor() {
    this.init();
  }

  private init(): void {
    this.render();

    this.unsubscribe = ExchangeStore.onUpdate(() => this.render());

    const observer = new MutationObserver(() => {
      if (!document.getElementById('addresses-table')) {
        if (this.unsubscribe) this.unsubscribe();
        observer.disconnect();
      }
    });
    const content = document.getElementById('app-content');
    if (content) observer.observe(content, { childList: true });
  }

  private render(): void {
    const addresses = ExchangeStore.withdrawalAddresses;
    const error = ExchangeStore.error;
    const lastUpdated = ExchangeStore.lastUpdated;
    const isAll = ExchangeStore.isAllMode();

    // Update subtitle
    const subtitle = document.getElementById('page-subtitle');
    if (subtitle) {
      const label = isAll ? '' : ` on ${ExchangeStore.getExchangeName(ExchangeStore.activeMode as number)}`;
      const refreshSpan = document.getElementById('refresh-label');
      const refreshHtml = refreshSpan ? refreshSpan.outerHTML : '';
      subtitle.innerHTML = `Your withdrawal addresses${this.escapeHtml(label)} ${refreshHtml}`;
    }

    // Update thead for exchange column
    const thead = document.getElementById('addresses-thead');
    if (thead) {
      const cols = isAll
        ? '<tr><th>Exchange</th><th>Asset</th><th>Method / Address</th><th>Name</th><th>Method</th><th>Verified</th></tr>'
        : '<tr><th>Asset</th><th>Method / Address</th><th>Name</th><th>Method</th><th>Verified</th></tr>';
      thead.innerHTML = cols;
    }

    if (error) {
      this.showError(error);
      this.setRefreshLabel('');
    } else {
      this.hideError();
      this.renderAddresses(addresses, isAll);
      this.updateCountTitle(addresses.length);
      if (lastUpdated) {
        this.setRefreshLabel(`Last updated: ${lastUpdated.toLocaleTimeString()}`);
      }
    }
  }

  private renderAddresses(addresses: any[], isAll: boolean): void {
    const tbody = document.getElementById('addresses-tbody');
    if (!tbody) return;

    const colspan = isAll ? 6 : 5;
    if (addresses.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="${colspan}">No whitelisted withdrawal methods configured</td></tr>`;
      return;
    }

    tbody.innerHTML = addresses.map((a: any) => {
      const exchangeCol = isAll
        ? `<td><span class="exchange-badge exchange-${this.escapeHtml(a.exchangeName).toLowerCase()}">${this.escapeHtml(a.exchangeName)}</span></td>`
        : '';
      
      return `<tr>
        ${exchangeCol}
        <td><span class="asset-badge">${this.escapeHtml(a.asset)}</span></td>
        <td class="address-cell">${this.escapeHtml(a.address)}</td>
        <td class="address-cell">${this.escapeHtml(a.nickname_key)}</td>
        <td>${this.escapeHtml(a.method)}</td>
        <td><span class="status-badge ${a.verified ? 'status-verified' : 'status-unverified'}">${a.verified ? 'Verified' : 'Unverified'}</span></td>
      </tr>`;
    }).join('');
  }

  private updateCountTitle(count: number): void {
    const title = document.getElementById('addresses-count-title');
    if (title) {
      title.textContent = `Addresses (${count})`;
    }
  }

  private setRefreshLabel(text: string): void {
    const label = document.getElementById('refresh-label');
    if (label) label.textContent = text;
  }

  private showError(message: string): void {
    const errorDiv = document.getElementById('addresses-error');
    const errorMsg = document.getElementById('addresses-error-message');
    if (errorDiv && errorMsg) {
      errorMsg.textContent = message;
      errorDiv.classList.remove('d-none');
    }
  }

  private hideError(): void {
    const errorDiv = document.getElementById('addresses-error');
    if (errorDiv) {
      errorDiv.classList.add('d-none');
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

new WhitelistController();

})();