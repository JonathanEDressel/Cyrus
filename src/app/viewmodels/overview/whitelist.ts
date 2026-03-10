(function () {

class WhitelistController {
  private refreshTimer: number | null = null;
  private readonly REFRESH_INTERVAL = 30000;

  constructor() {
    this.init();
  }

  private init(): void {
    this.attachEventListeners();
    this.loadAddresses();
    this.startAutoRefresh();
  }

  private attachEventListeners(): void {
  }

  private startAutoRefresh(): void {
    this.refreshTimer = window.setInterval(() => this.loadAddresses(), this.REFRESH_INTERVAL);

    const observer = new MutationObserver(() => {
      if (!document.getElementById('addresses-table')) {
        this.stopAutoRefresh();
        observer.disconnect();
      }
    });
    const content = document.getElementById('app-content');
    if (content) observer.observe(content, { childList: true });
  }

  private stopAutoRefresh(): void {
    if (this.refreshTimer !== null) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async loadAddresses(): Promise<void> {
    try {
      this.setRefreshLabel('Refreshing...');
      const addresses = await KrakenController.getWithdrawalAddresses();
      this.renderAddresses(addresses);
      this.updateCountTitle(addresses.length);
      this.setRefreshLabel(`Last updated: ${new Date().toLocaleTimeString()}`);
      this.hideError();
    } catch (error: any) {
      this.showError(error.message || 'Failed to fetch withdrawal addresses');
      this.setRefreshLabel('');
    }
  }

  private renderAddresses(addresses: any[]): void {
    const tbody = document.getElementById('addresses-tbody');
    if (!tbody) return;

    if (addresses.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="4">No whitelisted withdrawal methods configured</td></tr>';
      return;
    }

    tbody.innerHTML = addresses.map((a: any) => {
      const limit = a.limit && a.limit !== '0' && a.limit !== 'false' 
        ? this.escapeHtml(a.limit) 
        : 'No limit';
      const fee = a.fee && a.fee !== '0' && a.fee !== 'false'
        ? this.escapeHtml(a.fee)
        : 'No fee';
      
      return `<tr>
        <td><span class="asset-badge">${this.escapeHtml(a.asset)}</span></td>
        <td class="address-cell">${this.escapeHtml(a.address)}</td>
        <td>${limit}</td>
        <td>${fee}</td>
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