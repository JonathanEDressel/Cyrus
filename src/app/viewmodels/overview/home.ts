(function () {

// Home / Overview view model
class HomeController {
  constructor() {
    this.init();
  }

  private init(): void {
    this.attachEventListeners();
    this.loadDashboardData();
  }

  private attachEventListeners(): void {
    document.getElementById('view-all-positions')?.addEventListener('click', () => {
      router.navigate('positions');
    });
    document.getElementById('view-all-orders')?.addEventListener('click', () => {
      router.navigate('openorders');
    });
  }

  // ---- Data loading ----

  private async loadDashboardData(): Promise<void> {
    // TODO: Replace with real Kraken API calls via service layer
    // For now, show placeholder state
    this.setCardValue('total-balance', '$0.00');
    this.setCardValue('open-positions-count', '0');
    this.setCardValue('open-orders-count', '0');
    this.setCardValue('custom-commands-count', '0');

    this.setTableEmpty('positions-tbody', 6, 'No open positions');
    this.setTableEmpty('orders-tbody', 6, 'No open orders');
  }

  // ---- UI helpers ----

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
}

new HomeController();

})();