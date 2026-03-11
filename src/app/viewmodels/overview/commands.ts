(function () {

class CommandsController {
  private unsubscribe: (() => void) | null = null;
  private selectedOrder: any = null;
  private maxAmount: number = 0;
  private ruleOrderIds: Set<string> = new Set();

  constructor() {
    this.init();
  }

  private init(): void {
    this.attachEventListeners();
    this.populateOrderDropdown();
    this.loadRules();
    this.loadLogs();

    this.unsubscribe = KrakenStore.onUpdate(() => this.populateOrderDropdown());

    const observer = new MutationObserver(() => {
      if (!document.getElementById('create-rule-form')) {
        if (this.unsubscribe) this.unsubscribe();
        observer.disconnect();
      }
    });
    const content = document.getElementById('app-content');
    if (content) observer.observe(content, { childList: true });
  }

  private attachEventListeners(): void {
    document.getElementById('create-rule-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.createRule();
    });

    document.getElementById('trigger-order-id')?.addEventListener('change', () => {
      this.onOrderSelected();
    });

    document.getElementById('rules-tbody')?.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
      if (!target) return;

      const action = target.getAttribute('data-action');
      const ruleId = parseInt(target.getAttribute('data-rule-id') || '0', 10);
      if (!ruleId) return;

      if (action === 'toggle') {
        this.toggleRule(ruleId);
      } else if (action === 'delete') {
        this.deleteRule(ruleId);
      }
    });
  }

  private populateOrderDropdown(): void {
    const select = document.getElementById('trigger-order-id') as HTMLSelectElement;
    if (!select) return;

    const previousValue = select.value;
    const orders = KrakenStore.openOrders;

    select.innerHTML = '';

    if (orders.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.disabled = true;
      opt.selected = true;
      opt.textContent = 'No open orders available';
      select.appendChild(opt);
      return;
    }

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.selected = true;
    placeholder.textContent = 'Select an order...';
    select.appendChild(placeholder);

    for (const o of orders) {
      const opt = document.createElement('option');
      opt.value = o.id;
      const pairDisplay = this.formatPair(o.pair);
      const check = this.ruleOrderIds.has(o.id) ? '\u2705 ' : '';
      opt.textContent = `${check}${o.id.substring(0, 10)}... (${o.side} ${o.volume} ${pairDisplay} @ ${o.price})`;
      select.appendChild(opt);
    }

    if (previousValue && orders.some((o: any) => o.id === previousValue)) {
      select.value = previousValue;
    } else {
      this.resetDependentFields();
    }
  }

  private onOrderSelected(): void {
    const select = document.getElementById('trigger-order-id') as HTMLSelectElement;
    const orderId = select.value;
    const order = KrakenStore.openOrders.find((o: any) => o.id === orderId);

    if (!order) {
      this.resetDependentFields();
      return;
    }

    this.selectedOrder = order;
    const { base, quote } = this.parsePair(order.pair);
    const isSell = order.side === 'sell';
    const receivedAsset = isSell ? quote : base;
    const remaining = parseFloat(order.volume) - parseFloat(order.filled);

    if (isSell) {
      this.maxAmount = remaining * parseFloat(order.price);
    } else {
      this.maxAmount = remaining;
    }

    const assetSelect = document.getElementById('action-asset') as HTMLSelectElement;
    assetSelect.innerHTML = '';
    assetSelect.disabled = false;
    const opt = document.createElement('option');
    opt.value = receivedAsset;
    opt.textContent = this.normalizeBase(receivedAsset);
    opt.selected = true;
    assetSelect.appendChild(opt);

    this.populateAddressDropdown();

    const amountInput = document.getElementById('action-amount') as HTMLInputElement;
    amountInput.disabled = false;
    amountInput.max = this.maxAmount.toString();
    amountInput.placeholder = `Max: ${this.maxAmount.toFixed(6)}`;
    amountInput.value = '';

    const hint = document.getElementById('amount-hint');
    if (hint) hint.textContent = `Max ${this.maxAmount.toFixed(6)} ${this.normalizeBase(receivedAsset)}`;
  }

  private populateAddressDropdown(): void {
    const select = document.getElementById('action-address-key') as HTMLSelectElement;
    select.innerHTML = '';
    select.disabled = false;

    const addresses = KrakenStore.withdrawalAddresses;

    if (addresses.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.disabled = true;
      opt.selected = true;
      opt.textContent = 'No withdrawal addresses available';
      select.appendChild(opt);
      select.disabled = true;
      return;
    }

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.selected = true;
    placeholder.textContent = 'Select an address...';
    select.appendChild(placeholder);

    for (const addr of addresses) {
      const opt = document.createElement('option');
      opt.value = addr.nickname_key;
      opt.textContent = `${addr.nickname_key} (${this.normalizeBase(addr.asset)} - ${addr.method})`;
      select.appendChild(opt);
    }
  }

  private resetDependentFields(): void {
    this.selectedOrder = null;
    this.maxAmount = 0;

    const assetSelect = document.getElementById('action-asset') as HTMLSelectElement;
    if (assetSelect) {
      assetSelect.innerHTML = '<option value="" disabled selected>Select an order first</option>';
      assetSelect.disabled = true;
    }

    const addrSelect = document.getElementById('action-address-key') as HTMLSelectElement;
    if (addrSelect) {
      addrSelect.innerHTML = '<option value="" disabled selected>Select an order first</option>';
      addrSelect.disabled = true;
    }

    const amountInput = document.getElementById('action-amount') as HTMLInputElement;
    if (amountInput) {
      amountInput.value = '';
      amountInput.placeholder = 'Select an order first';
      amountInput.disabled = true;
      amountInput.removeAttribute('max');
    }

    const hint = document.getElementById('amount-hint');
    if (hint) hint.textContent = '';
  }

  private parsePair(pair: string): { base: string; quote: string } {
    if (!pair) return { base: '', quote: '' };

    const QUOTE_CURRENCIES = ['USDT', 'USDC', 'DAI', 'BUSD', 'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF'];

    let cleaned = pair;
    if (cleaned.startsWith('XX') && cleaned.length > 6) {
      cleaned = cleaned.substring(1);
    } else if (cleaned.startsWith('X') && cleaned.length > 6 && !cleaned.startsWith('XBT') && !cleaned.startsWith('XDG')) {
      cleaned = cleaned.substring(1);
    }

    for (const quote of QUOTE_CURRENCIES) {
      const zQuote = 'Z' + quote;
      if (cleaned.endsWith(zQuote)) {
        return { base: cleaned.substring(0, cleaned.length - zQuote.length), quote };
      }
      if (cleaned.endsWith(quote)) {
        return { base: cleaned.substring(0, cleaned.length - quote.length), quote };
      }
    }

    if (cleaned.length >= 6) {
      return { base: cleaned.substring(0, cleaned.length - 3), quote: cleaned.substring(cleaned.length - 3) };
    }

    return { base: cleaned, quote: '' };
  }

  private formatPair(pair: string): string {
    const { base, quote } = this.parsePair(pair);
    if (!quote) return this.normalizeBase(base);
    return `${this.normalizeBase(base)}/${quote}`;
  }

  private normalizeBase(base: string): string {
    if (base === 'XBT') return 'BTC';
    if (base === 'XDG') return 'DOGE';
    return base;
  }

  private async createRule(): Promise<void> {
    const ruleName = (document.getElementById('rule-name') as HTMLInputElement).value.trim();
    const triggerType = (document.getElementById('trigger-type') as HTMLSelectElement).value;
    const triggerOrderId = (document.getElementById('trigger-order-id') as HTMLSelectElement).value;
    const actionType = (document.getElementById('action-type') as HTMLSelectElement).value;
    const actionAsset = (document.getElementById('action-asset') as HTMLSelectElement).value;
    const actionAddressKey = (document.getElementById('action-address-key') as HTMLSelectElement).value;
    const actionAmount = (document.getElementById('action-amount') as HTMLInputElement).value.trim();

    if (!ruleName || !triggerOrderId || !actionAsset || !actionAddressKey || !actionAmount) {
      this.showError('Please fill in all required fields');
      return;
    }

    const amount = parseFloat(actionAmount);
    if (isNaN(amount) || amount <= 0) {
      this.showError('Amount must be a positive number');
      return;
    }

    if (amount > this.maxAmount) {
      this.showError(`Amount cannot exceed ${this.maxAmount.toFixed(6)}`);
      return;
    }

    try {
      const btn = document.getElementById('create-rule-btn') as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'Creating...';

      await AutomationController.createRule({
        rule_name: ruleName,
        trigger_type: triggerType,
        trigger_order_id: triggerOrderId,
        action_type: actionType,
        action_asset: actionAsset,
        action_address_key: actionAddressKey,
        action_amount: actionAmount,
      });

      this.showSuccess('Rule created successfully');
      this.clearForm();
      this.loadRules();
    } catch (error: any) {
      this.showError(error.message || 'Failed to create rule');
    } finally {
      const btn = document.getElementById('create-rule-btn') as HTMLButtonElement;
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-plus"></i> Create Rule';
    }
  }

  private async loadRules(): Promise<void> {
    try {
      const rules = await AutomationController.getRules();
      this.ruleOrderIds = new Set(rules.map((r: any) => r.trigger_order_id).filter(Boolean));
      this.renderRules(rules);
      this.updateRulesCount(rules.length);
      this.populateOrderDropdown();
    } catch (error: any) {
      this.showError(error.message || 'Failed to load rules');
    }
  }

  private renderRules(rules: any[]): void {
    const tbody = document.getElementById('rules-tbody');
    if (!tbody) return;

    if (rules.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No automation rules created yet</td></tr>';
      return;
    }

    tbody.innerHTML = rules.map((r: any) => {
      const statusClass = r.is_active ? 'status-active' : 'status-inactive';
      const statusText = r.is_active ? 'Active' : 'Paused';
      const toggleIcon = r.is_active ? 'fa-pause' : 'fa-play';
      const toggleTitle = r.is_active ? 'Pause' : 'Resume';
      const triggerText = this.formatTrigger(r);
      const actionText = this.formatAction(r);
      const triggered = r.trigger_count > 0
        ? `${r.trigger_count}x (${new Date(r.last_triggered_at).toLocaleString()})`
        : 'Never';

      return `<tr>
        <td class="rule-name-cell">${this.escapeHtml(r.rule_name)}</td>
        <td class="trigger-cell">${triggerText}</td>
        <td class="action-cell">${actionText}</td>
        <td><span class="status-badge ${statusClass}">${statusText}</span></td>
        <td>${this.escapeHtml(triggered)}</td>
        <td class="controls-cell">
          <button class="btn-icon" data-action="toggle" data-rule-id="${r.id}" title="${toggleTitle}">
            <i class="fa-solid ${toggleIcon}"></i>
          </button>
          <button class="btn-icon btn-icon-danger" data-action="delete" data-rule-id="${r.id}" title="Delete">
            <i class="fa-solid fa-trash"></i>
          </button>
        </td>
      </tr>`;
    }).join('');
  }

  private formatTrigger(rule: any): string {
    if (rule.trigger_type === 'order_filled') {
      const orderId = rule.trigger_order_id
        ? this.escapeHtml(rule.trigger_order_id.substring(0, 10)) + '...'
        : 'Any';
      return `<span class="trigger-badge">Order Filled</span> <span class="mono-text">${orderId}</span>`;
    }
    return this.escapeHtml(rule.trigger_type);
  }

  private formatAction(rule: any): string {
    if (rule.action_type === 'withdraw_crypto') {
      return `Withdraw <strong>${this.escapeHtml(rule.action_amount)}</strong> `
        + `<span class="asset-badge">${this.escapeHtml(rule.action_asset)}</span> `
        + `→ ${this.escapeHtml(rule.action_address_key)}`;
    }
    return this.escapeHtml(rule.action_type);
  }

  private async toggleRule(ruleId: number): Promise<void> {
    try {
      await AutomationController.toggleRule(ruleId);
      this.loadRules();
    } catch (error: any) {
      this.showError(error.message || 'Failed to toggle rule');
    }
  }

  private async deleteRule(ruleId: number): Promise<void> {
    try {
      await AutomationController.deleteRule(ruleId);
      this.showSuccess('Rule deleted');
      this.loadRules();
    } catch (error: any) {
      this.showError(error.message || 'Failed to delete rule');
    }
  }

  private async loadLogs(): Promise<void> {
    try {
      const logs = await AutomationController.getLogs(30);
      this.renderLogs(logs);
    } catch (error: any) {
    }
  }

  private renderLogs(logs: any[]): void {
    const tbody = document.getElementById('logs-tbody');
    if (!tbody) return;

    if (logs.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No execution history yet</td></tr>';
      return;
    }

    tbody.innerHTML = logs.map((l: any) => {
      const time = l.created_at ? new Date(l.created_at).toLocaleString() : '--';
      const statusClass = l.status === 'success' ? 'log-success' : 'log-error';

      return `<tr>
        <td>${this.escapeHtml(time)}</td>
        <td>${this.escapeHtml(l.trigger_event)}</td>
        <td>${this.escapeHtml(l.action_executed)}</td>
        <td class="result-cell">${this.escapeHtml(l.action_result)}</td>
        <td><span class="log-status ${statusClass}">${this.escapeHtml(l.status)}</span></td>
      </tr>`;
    }).join('');
  }

  private updateRulesCount(count: number): void {
    const el = document.getElementById('rules-count-title');
    if (el) el.textContent = `Active Rules (${count})`;
  }

  private clearForm(): void {
    (document.getElementById('rule-name') as HTMLInputElement).value = '';
    const orderSelect = document.getElementById('trigger-order-id') as HTMLSelectElement;
    if (orderSelect.options.length > 0) orderSelect.selectedIndex = 0;
    this.resetDependentFields();
  }

  private showError(message: string): void {
    const el = document.getElementById('commands-error');
    const msgEl = document.getElementById('commands-error-message');
    if (el && msgEl) {
      msgEl.textContent = message;
      el.classList.remove('d-none');
      setTimeout(() => el.classList.add('d-none'), 5000);
    }
  }

  private showSuccess(message: string): void {
    const el = document.getElementById('commands-success');
    const msgEl = document.getElementById('commands-success-message');
    if (el && msgEl) {
      msgEl.textContent = message;
      el.classList.remove('d-none');
      setTimeout(() => el.classList.add('d-none'), 3000);
    }
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  }
}

new CommandsController();

})();
