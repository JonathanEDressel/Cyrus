(function () {

class CommandsController {
  private unsubscribe: (() => void) | null = null;
  private selectedOrder: any = null;
  private maxAmount: number = 0;
  private ruleOrderIds: Set<string> = new Set();
  private balances: Record<string, string> = {};

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

    document.getElementById('trigger-type')?.addEventListener('change', () => {
      this.onTriggerTypeChanged();
    });

    document.getElementById('trigger-order-id')?.addEventListener('change', () => {
      this.onOrderSelected();
    });

    document.querySelectorAll('input[name="amount-mode"]').forEach((radio) => {
      radio.addEventListener('change', () => this.onAmountModeChanged());
    });

    document.getElementById('amount-slider')?.addEventListener('input', (e) => {
      this.onSliderChanged((e.target as HTMLInputElement).value);
    });

    document.getElementById('action-amount')?.addEventListener('input', () => {
      this.updateSliderFromAmount();
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

    const ordersWithoutRules = orders.filter((o: any) => !this.ruleOrderIds.has(o.id));
    const ordersWithRules = orders.filter((o: any) => this.ruleOrderIds.has(o.id));
    const sortedOrders = [...ordersWithoutRules, ...ordersWithRules]; //not sure if I want to hide orders with rules or just mark them, for now I will just mark them with a checkmark in the dropdown

    for (const o of sortedOrders) {
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
    const triggerType = (document.getElementById('trigger-type') as HTMLSelectElement).value;
    if (triggerType !== 'order_filled') return;

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

    // Enable amount mode radios
    document.querySelectorAll('input[name="amount-mode"]').forEach((r) => {
      (r as HTMLInputElement).disabled = false;
    });
    this.onAmountModeChanged();

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

  private onTriggerTypeChanged(): void {
    const triggerType = (document.getElementById('trigger-type') as HTMLSelectElement).value;
    const orderSection = document.getElementById('trigger-order-section');
    const balanceSections = document.querySelectorAll('.trigger-balance-section');
    const amountModeSection = document.getElementById('amount-mode-section');

    if (triggerType === 'balance_threshold') {
      // Show balance fields, hide order fields
      orderSection?.classList.add('d-none');
      balanceSections.forEach(el => el.classList.remove('d-none'));
      amountModeSection?.classList.add('d-none');

      this.resetDependentFields();
      this.loadBalances();

      // For balance_threshold, auto-set asset from trigger-asset selection
      const assetSelect = document.getElementById('action-asset') as HTMLSelectElement;
      assetSelect.innerHTML = '<option value="" disabled selected>Select a trigger asset first</option>';
      assetSelect.disabled = true;

      // Enable address dropdown
      this.populateAddressDropdown();
    } else {
      // Show order fields, hide balance fields
      orderSection?.classList.remove('d-none');
      balanceSections.forEach(el => el.classList.add('d-none'));
      amountModeSection?.classList.remove('d-none');

      this.resetDependentFields();

      // Re-enable trigger-asset and threshold
      const triggerAssetSelect = document.getElementById('trigger-asset') as HTMLSelectElement;
      if (triggerAssetSelect) {
        triggerAssetSelect.disabled = true;
        triggerAssetSelect.innerHTML = '<option value="" disabled selected>Loading balances...</option>';
      }
      const thresholdInput = document.getElementById('trigger-threshold') as HTMLInputElement;
      if (thresholdInput) {
        thresholdInput.disabled = true;
        thresholdInput.value = '';
      }
    }
  }

  private async loadBalances(): Promise<void> {
    const triggerAssetSelect = document.getElementById('trigger-asset') as HTMLSelectElement;
    const thresholdInput = document.getElementById('trigger-threshold') as HTMLInputElement;

    try {
      this.balances = await KrakenController.getBalance();

      triggerAssetSelect.innerHTML = '';
      triggerAssetSelect.disabled = false;

      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.disabled = true;
      placeholder.selected = true;
      placeholder.textContent = 'Select an asset...';
      triggerAssetSelect.appendChild(placeholder);

      for (const [asset, amount] of Object.entries(this.balances)) {
        const opt = document.createElement('option');
        opt.value = asset;
        opt.textContent = `${this.normalizeBase(asset)} (Balance: ${parseFloat(amount).toFixed(8)})`;
        triggerAssetSelect.appendChild(opt);
      }

      thresholdInput.disabled = false;

      // When trigger-asset changes, auto-set action-asset
      triggerAssetSelect.addEventListener('change', () => {
        this.onTriggerAssetChanged();
      });
    } catch {
      triggerAssetSelect.innerHTML = '<option value="" disabled selected>Failed to load balances</option>';
      triggerAssetSelect.disabled = true;
      thresholdInput.disabled = true;
    }
  }

  private onTriggerAssetChanged(): void {
    const triggerAssetSelect = document.getElementById('trigger-asset') as HTMLSelectElement;
    const selectedAsset = triggerAssetSelect.value;

    const assetSelect = document.getElementById('action-asset') as HTMLSelectElement;
    assetSelect.innerHTML = '';
    assetSelect.disabled = false;

    const opt = document.createElement('option');
    opt.value = selectedAsset;
    opt.textContent = this.normalizeBase(selectedAsset);
    opt.selected = true;
    assetSelect.appendChild(opt);

    // Update threshold hint
    const balance = this.balances[selectedAsset];
    const thresholdHint = document.getElementById('threshold-hint');
    if (thresholdHint && balance) {
      thresholdHint.textContent = `Current balance: ${parseFloat(balance).toFixed(8)} ${this.normalizeBase(selectedAsset)}`;
    }
  }

  private onAmountModeChanged(): void {
    const triggerType = (document.getElementById('trigger-type') as HTMLSelectElement).value;
    if (triggerType === 'balance_threshold') return;

    const mode = (document.querySelector('input[name="amount-mode"]:checked') as HTMLInputElement)?.value;
    const amountInput = document.getElementById('action-amount') as HTMLInputElement;
    const slider = document.getElementById('amount-slider') as HTMLInputElement;
    const hint = document.getElementById('amount-hint');
    const modeHint = document.getElementById('amount-mode-hint');

    if (mode === 'filled') {
      amountInput.disabled = true;
      amountInput.value = '';
      amountInput.placeholder = 'Auto-calculated from order';
      amountInput.removeAttribute('required');
      slider.disabled = true;
      if (hint && this.selectedOrder) {
        const { base } = this.parsePair(this.selectedOrder.pair);
        hint.textContent = `Est. max ${this.maxAmount.toFixed(6)} ${this.normalizeBase(base)}`;
      }
      if (modeHint) modeHint.textContent = 'Withdraws the actual filled amount when the order completes';
    } else {
      if (this.selectedOrder) {
        amountInput.disabled = false;
        amountInput.max = this.maxAmount.toString();
        amountInput.placeholder = `Max: ${this.maxAmount.toFixed(6)}`;
        amountInput.setAttribute('required', '');
        slider.disabled = false;
        slider.value = '100';
        this.onSliderChanged('100');
        if (hint) {
          const { base } = this.parsePair(this.selectedOrder.pair);
          hint.textContent = `Max ${this.maxAmount.toFixed(6)} ${this.normalizeBase(base)}`;
        }
      }
      if (modeHint) modeHint.textContent = '';
    }
  }

  private onSliderChanged(value: string): void {
    const percentage = parseInt(value, 10);
    const sliderValueEl = document.getElementById('slider-value');
    const amountInput = document.getElementById('action-amount') as HTMLInputElement;
    
    if (sliderValueEl) sliderValueEl.textContent = `${percentage}%`;
    
    if (this.maxAmount > 0 && !amountInput.disabled) {
      const calculatedAmount = (this.maxAmount * percentage) / 100;
      amountInput.value = calculatedAmount.toFixed(8);
    }
  }

  private updateSliderFromAmount(): void {
    const amountInput = document.getElementById('action-amount') as HTMLInputElement;
    const slider = document.getElementById('amount-slider') as HTMLInputElement;
    const sliderValueEl = document.getElementById('slider-value');
    
    if (slider.disabled || this.maxAmount === 0) return;
    
    const amount = parseFloat(amountInput.value);
    if (!isNaN(amount) && amount >= 0) {
      const percentage = Math.min(100, Math.round((amount / this.maxAmount) * 100));
      slider.value = percentage.toString();
      if (sliderValueEl) sliderValueEl.textContent = `${percentage}%`;
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

    // Reset amount mode radios
    document.querySelectorAll('input[name="amount-mode"]').forEach((r) => {
      (r as HTMLInputElement).disabled = true;
    });
    const fixedRadio = document.querySelector('input[name="amount-mode"][value="fixed"]') as HTMLInputElement;
    if (fixedRadio) fixedRadio.checked = true;

    const modeHint = document.getElementById('amount-mode-hint');
    if (modeHint) modeHint.textContent = '';

    const amountInput = document.getElementById('action-amount') as HTMLInputElement;
    if (amountInput) {
      amountInput.value = '';
      amountInput.placeholder = 'Select an order first';
      amountInput.disabled = true;
      amountInput.removeAttribute('max');
    }

    const slider = document.getElementById('amount-slider') as HTMLInputElement;
    if (slider) {
      slider.disabled = true;
      slider.value = '100';
    }

    const sliderValue = document.getElementById('slider-value');
    if (sliderValue) sliderValue.textContent = '100%';

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
    const actionType = (document.getElementById('action-type') as HTMLSelectElement).value;
    const actionAsset = (document.getElementById('action-asset') as HTMLSelectElement).value;
    const actionAddressKey = (document.getElementById('action-address-key') as HTMLSelectElement).value;

    if (!ruleName || !actionAsset || !actionAddressKey) {
      this.showError('Please fill in all required fields');
      return;
    }

    const payload: any = {
      rule_name: ruleName,
      trigger_type: triggerType,
      action_type: actionType,
      action_asset: actionAsset,
      action_address_key: actionAddressKey,
    };

    if (triggerType === 'balance_threshold') {
      const triggerAsset = (document.getElementById('trigger-asset') as HTMLSelectElement).value;
      const triggerThreshold = (document.getElementById('trigger-threshold') as HTMLInputElement).value.trim();
      const cooldownHours = parseInt((document.getElementById('cooldown-hours') as HTMLInputElement).value || '0', 10);
      const cooldownMins = parseInt((document.getElementById('cooldown-minutes') as HTMLInputElement).value || '0', 10);
      const totalCooldown = (cooldownHours * 60) + cooldownMins;

      if (!triggerAsset) {
        this.showError('Please select an asset to monitor');
        return;
      }
      if (!triggerThreshold || parseFloat(triggerThreshold) <= 0) {
        this.showError('Threshold must be a positive number');
        return;
      }
      if (totalCooldown < 1) {
        this.showError('Cooldown must be at least 1 minute');
        return;
      }

      payload.trigger_asset = triggerAsset;
      payload.trigger_threshold = triggerThreshold;
      payload.cooldown_minutes = totalCooldown;
      payload.action_amount = '';
      payload.use_filled_amount = false;
    } else {
      const triggerOrderId = (document.getElementById('trigger-order-id') as HTMLSelectElement).value;
      const actionAmount = (document.getElementById('action-amount') as HTMLInputElement).value.trim();
      const amountMode = (document.querySelector('input[name="amount-mode"]:checked') as HTMLInputElement)?.value;
      const useFilledAmount = amountMode === 'filled';

      if (!triggerOrderId) {
        this.showError('Please select an order');
        return;
      }

      if (!useFilledAmount) {
        if (!actionAmount) {
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

        // Validate minimum $1 equivalent
        if (this.selectedOrder) {
          const minValueUSD = this.calculateMinimumValue(amount);
          if (minValueUSD < 1) {
            this.showError('Withdrawal amount must be worth at least $1 USD');
            return;
          }
        }
      }

      payload.trigger_order_id = triggerOrderId;
      payload.action_amount = useFilledAmount ? '' : actionAmount;
      payload.use_filled_amount = useFilledAmount;
    }

    try {
      const btn = document.getElementById('create-rule-btn') as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'Creating...';

      await AutomationController.createRule(payload);

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
    if (rule.trigger_type === 'balance_threshold') {
      const asset = this.normalizeBase(rule.trigger_asset || '');
      const threshold = rule.trigger_threshold || '0';
      const cooldown = this.formatCooldown(rule.cooldown_minutes || 1440);
      return `<span class="trigger-badge trigger-badge-balance">Balance ≥</span> `
        + `<strong>${this.escapeHtml(threshold)}</strong> `
        + `<span class="asset-badge">${this.escapeHtml(asset)}</span>`
        + `<br><span class="cooldown-text">Cooldown: ${cooldown}</span>`;
    }
    return this.escapeHtml(rule.trigger_type);
  }

  private formatAction(rule: any): string {
    if (rule.action_type === 'withdraw_crypto') {
      let amountText: string;
      if (rule.trigger_type === 'balance_threshold') {
        amountText = '<em>Full Balance</em>';
      } else if (rule.use_filled_amount) {
        amountText = '<em>Filled Amount</em>';
      } else {
        amountText = `<strong>${this.escapeHtml(rule.action_amount)}</strong>`;
      }
      return `Withdraw ${amountText} `
        + `<span class="asset-badge">${this.escapeHtml(rule.action_asset)}</span> `
        + `→ ${this.escapeHtml(rule.action_address_key)}`;
    }
    return this.escapeHtml(rule.action_type);
  }

  private formatCooldown(minutes: number): string {
    if (minutes < 60) return `${minutes}m`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
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
    const triggerSelect = document.getElementById('trigger-type') as HTMLSelectElement;
    if (triggerSelect) triggerSelect.value = 'order_filled';
    const orderSelect = document.getElementById('trigger-order-id') as HTMLSelectElement;
    if (orderSelect.options.length > 0) orderSelect.selectedIndex = 0;

    // Reset balance threshold fields
    const triggerAsset = document.getElementById('trigger-asset') as HTMLSelectElement;
    if (triggerAsset) triggerAsset.selectedIndex = 0;
    const thresholdInput = document.getElementById('trigger-threshold') as HTMLInputElement;
    if (thresholdInput) thresholdInput.value = '';
    const cooldownHours = document.getElementById('cooldown-hours') as HTMLInputElement;
    if (cooldownHours) cooldownHours.value = '24';
    const cooldownMins = document.getElementById('cooldown-minutes') as HTMLInputElement;
    if (cooldownMins) cooldownMins.value = '0';

    this.onTriggerTypeChanged();
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

  private calculateMinimumValue(amount: number): number {
    if (!this.selectedOrder) return 0;
    
    const { quote } = this.parsePair(this.selectedOrder.pair);
    const price = parseFloat(this.selectedOrder.price);
    const isSell = this.selectedOrder.side === 'sell';
    
    // For sell orders, amount is already in quote currency (usually USD)
    if (isSell) {
      // Check if quote is a fiat currency
      const fiatCurrencies = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF'];
      if (fiatCurrencies.includes(quote)) {
        // Simple conversion - assume 1:1 for non-USD fiat (rough estimate)
        return quote === 'USD' ? amount : amount * 0.9;
      }
      // If quote is stablecoin, assume 1:1 with USD
      const stablecoins = ['USDT', 'USDC', 'DAI', 'BUSD'];
      if (stablecoins.includes(quote)) {
        return amount;
      }
    }
    
    // For buy orders, amount is in base currency (crypto), multiply by price
    return amount * price;
  }
}

new CommandsController();

})();
