(function () {

class CommandsController {
  constructor() {
    this.init();
  }

  private init(): void {
    this.attachEventListeners();
    this.loadRules();
    this.loadLogs();
  }

  private attachEventListeners(): void {
    document.getElementById('create-rule-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.createRule();
    });

    // Delegate click events for toggle/delete buttons in the rules table
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

  private async createRule(): Promise<void> {
    const ruleName = (document.getElementById('rule-name') as HTMLInputElement).value.trim();
    const triggerType = (document.getElementById('trigger-type') as HTMLSelectElement).value;
    const triggerOrderId = (document.getElementById('trigger-order-id') as HTMLInputElement).value.trim();
    const actionType = (document.getElementById('action-type') as HTMLSelectElement).value;
    const actionAsset = (document.getElementById('action-asset') as HTMLSelectElement).value;
    const actionAddressKey = (document.getElementById('action-address-key') as HTMLInputElement).value.trim();
    const actionAmount = (document.getElementById('action-amount') as HTMLInputElement).value.trim();

    if (!ruleName || !triggerOrderId || !actionAddressKey || !actionAmount) {
      this.showError('Please fill in all required fields');
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
      this.renderRules(rules);
      this.updateRulesCount(rules.length);
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
      // Silently fail on log loading — not critical
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
    (document.getElementById('trigger-order-id') as HTMLInputElement).value = '';
    (document.getElementById('action-address-key') as HTMLInputElement).value = '';
    (document.getElementById('action-amount') as HTMLInputElement).value = '';
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
