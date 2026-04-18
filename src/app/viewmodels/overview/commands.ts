(function () {

class CommandsController {
  private unsubscribe: (() => void) | null = null;
  private selectedOrder: any = null;
  private maxAmount: number = 0;
  private ruleOrderIds: Set<string> = new Set();
  private balances: Record<string, string> = {};
  private withdrawalMinimums: Record<string, number> = {};

  // Commands page manages its own exchange-scoped data
  private selectedConnectionId: number | null = null;
  private localOpenOrders: any[] = [];
  private localWithdrawalAddresses: any[] = [];

  constructor() {
    this.init();
  }

  private init(): void {
    this.attachEventListeners();
    this.initExchangeSelector();
    this.loadRules();
    this.loadLogs();
    HelpTooltip.init();

    const observer = new MutationObserver(() => {
      if (!document.getElementById('create-rule-form')) {
        if (this.unsubscribe) this.unsubscribe();
        observer.disconnect();
      }
    });
    const content = document.getElementById('app-content');
    if (content) observer.observe(content, { childList: true });
  }

  private initExchangeSelector(): void {
    const selector = document.getElementById('commands-exchange-selector') as HTMLSelectElement;
    if (!selector) return;

    const connections = ExchangeStore.connections;
    selector.innerHTML = '';

    if (connections.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.disabled = true;
      opt.selected = true;
      opt.textContent = 'No validated exchanges';
      selector.appendChild(opt);
      return;
    }

    const sorted = [...connections].sort((a, b) => {
      const la = a.label && a.label !== 'Default' ? a.label : a.exchange_name;
      const lb = b.label && b.label !== 'Default' ? b.label : b.exchange_name;
      return la.localeCompare(lb);
    });
    for (const conn of sorted) {
      const opt = document.createElement('option');
      opt.value = conn.id.toString();
      const label = conn.label && conn.label !== 'Default' ? conn.label : conn.exchange_name;
      opt.textContent = label;
      selector.appendChild(opt);
    }

    // Default: use header selection if it's a specific exchange, else first connection
    const headerMode = ExchangeStore.activeMode;
    if (typeof headerMode === 'number' && connections.find(c => c.id === headerMode)) {
      selector.value = headerMode.toString();
    } else {
      selector.value = connections[0].id.toString();
    }

    selector.addEventListener('change', () => this.onExchangeChanged());
    this.onExchangeChanged();

    // Update subtitle
    this.updateSubtitle();
  }

  private onExchangeChanged(): void {
    const selector = document.getElementById('commands-exchange-selector') as HTMLSelectElement;
    if (!selector || !selector.value) return;
    this.selectedConnectionId = parseInt(selector.value, 10);
    this.resetDependentFields();
    this.loadExchangeData();
    this.updateSubtitle();
  }

  private updateSubtitle(): void {
    const subtitle = document.getElementById('commands-subtitle');
    if (subtitle && this.selectedConnectionId) {
      const name = ExchangeStore.getExchangeName(this.selectedConnectionId);
      subtitle.textContent = `Automation rules for your ${name} orders`;
    }
  }

  private async loadExchangeData(): Promise<void> {
    if (!this.selectedConnectionId) return;
    try {
      this.localOpenOrders = await ExchangeController.getOpenOrders(this.selectedConnectionId);
    } catch {
      this.localOpenOrders = [];
    }
    try {
      this.localWithdrawalAddresses = await ExchangeController.getWithdrawalAddresses(this.selectedConnectionId);
    } catch {
      this.localWithdrawalAddresses = [];
    }
    this.populateOrderDropdown();
    this.loadWithdrawalMinimums();
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
      this.validateAmountLive();
      this.updateRuleSummary();
    });

    document.getElementById('action-amount')?.addEventListener('input', () => {
      this.updateSliderFromAmount();
      this.validateAmountLive();
      this.updateRuleSummary();
    });

    document.getElementById('trigger-asset')?.addEventListener('change', () => {
      this.onTriggerAssetChanged();
    });

    document.getElementById('action-type')?.addEventListener('change', () => {
      this.onActionTypeChanged();
    });

    document.getElementById('convert-to-asset')?.addEventListener('change', () => {
      this.updateRuleSummary();
    });

    document.querySelectorAll('input[name="convert-amount-mode"]').forEach((radio) => {
      radio.addEventListener('change', () => this.updateRuleSummary());
    });

    document.getElementById('convert-amount')?.addEventListener('input', () => {
      this.updateRuleSummary();
    });

    document.getElementById('rule-name')?.addEventListener('input', () => {
      this.updateRuleSummary();
    });

    document.getElementById('action-address-key')?.addEventListener('change', () => {
      this.updateRuleSummary();
    });

    document.getElementById('trigger-threshold')?.addEventListener('input', () => {
      this.updateRuleSummary();
    });

    document.getElementById('cooldown-hours')?.addEventListener('input', () => {
      this.updateRuleSummary();
    });

    document.getElementById('cooldown-minutes')?.addEventListener('input', () => {
      this.updateRuleSummary();
    });

    document.getElementById('action-amount')?.addEventListener('input', () => {
      this.updateRuleSummary();
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
    const orders = this.localOpenOrders;

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

    const orderLabel = (o: any) => `${o.id.substring(0, 10)}... (${o.side} ${o.volume} ${o.pair} @ ${o.price})`;
    const ordersWithoutRules = orders.filter((o: any) => !this.ruleOrderIds.has(o.id)).sort((a: any, b: any) => orderLabel(a).localeCompare(orderLabel(b)));
    const ordersWithRules = orders.filter((o: any) => this.ruleOrderIds.has(o.id)).sort((a: any, b: any) => orderLabel(a).localeCompare(orderLabel(b)));
    const sortedOrders = [...ordersWithoutRules, ...ordersWithRules];

    for (const o of sortedOrders) {
      const opt = document.createElement('option');
      opt.value = o.id;
      const check = this.ruleOrderIds.has(o.id) ? '\u2705 ' : '';
      opt.textContent = `${check}${o.id.substring(0, 10)}... (${o.side} ${o.volume} ${o.pair} @ ${o.price})`;
      select.appendChild(opt);
    }

    if (previousValue && orders.some((o: any) => o.id === previousValue)) {
      select.value = previousValue;
    } else {
      const triggerType = (document.getElementById('trigger-type') as HTMLSelectElement)?.value;
      if (triggerType === 'order_filled') {
        this.resetDependentFields();
      }
    }
  }

  private onOrderSelected(): void {
    const triggerType = (document.getElementById('trigger-type') as HTMLSelectElement).value;
    if (triggerType !== 'order_filled') return;

    const select = document.getElementById('trigger-order-id') as HTMLSelectElement;
    const orderId = select.value;
    const order = this.localOpenOrders.find((o: any) => o.id === orderId);

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
    opt.textContent = receivedAsset;
    opt.selected = true;
    assetSelect.appendChild(opt);

    this.populateAddressDropdown();

    // Show minimum withdrawal hint
    this.updateMinWithdrawalHint(receivedAsset);

    // Check if max amount is below the minimum withdrawal
    const minWithdrawal = this.getMinForAsset(receivedAsset);
    if (minWithdrawal > 0 && this.maxAmount < minWithdrawal) {
      this.showMinWarning(`Maximum possible amount (${this.maxAmount.toFixed(6)} ${receivedAsset}) is below the minimum withdrawal of ${this.formatMin(minWithdrawal)} ${receivedAsset}`);
      this.setCreateButtonEnabled(false);
    } else {
      this.clearMinWarning();
      this.setCreateButtonEnabled(true);
    }

    // Enable amount mode radios
    document.querySelectorAll('input[name="amount-mode"]').forEach((r) => {
      (r as HTMLInputElement).disabled = false;
    });
    this.onAmountModeChanged();

    const hint = document.getElementById('amount-hint');
    if (hint) hint.textContent = `Max ${this.maxAmount.toFixed(6)} ${receivedAsset}`;

    this.updateRuleSummary();
  }

  private populateAddressDropdown(): void {
    const select = document.getElementById('action-address-key') as HTMLSelectElement;
    select.innerHTML = '';
    select.disabled = false;

    const addresses = this.localWithdrawalAddresses;

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

    const sortedAddrs = [...addresses].sort((a: any, b: any) => a.nickname_key.localeCompare(b.nickname_key));
    for (const addr of sortedAddrs) {
      const opt = document.createElement('option');
      opt.value = addr.nickname_key;
      opt.textContent = `${addr.nickname_key} (${addr.asset} - ${addr.method})`;
      select.appendChild(opt);
    }
  }

  private onActionTypeChanged(): void {
    const triggerType = (document.getElementById('trigger-type') as HTMLSelectElement)?.value;
    const actionType = (document.getElementById('action-type') as HTMLSelectElement)?.value;
    const withdrawFields = document.getElementById('withdraw-fields');
    const convertFields = document.getElementById('convert-fields');
    const amountModeSection = document.getElementById('amount-mode-section');

    const convertAmountSection = document.getElementById('convert-amount-section');

    if (actionType === 'convert_crypto' && triggerType === 'balance_threshold') {
      withdrawFields?.classList.add('d-none');
      convertFields?.classList.remove('d-none');
      amountModeSection?.classList.add('d-none');
      convertAmountSection?.classList.remove('d-none');
      this.populateConvertDropdowns();
      this.updateConvertAmountHint();
    } else {
      convertFields?.classList.add('d-none');
      convertAmountSection?.classList.add('d-none');
      withdrawFields?.classList.remove('d-none');
      if (triggerType !== 'balance_threshold') {
        amountModeSection?.classList.remove('d-none');
      }
    }
    this.updateRuleSummary();
  }

  private populateConvertDropdowns(): void {
    const fromSelect = document.getElementById('convert-from-asset') as HTMLSelectElement;
    const toSelect = document.getElementById('convert-to-asset') as HTMLSelectElement;
    if (!fromSelect || !toSelect) return;

    const triggerAsset = (document.getElementById('trigger-asset') as HTMLSelectElement)?.value;

    // From asset locked to trigger asset
    fromSelect.innerHTML = '';
    if (triggerAsset) {
      const opt = document.createElement('option');
      opt.value = triggerAsset;
      opt.textContent = triggerAsset;
      opt.selected = true;
      fromSelect.appendChild(opt);
      fromSelect.disabled = true;
    } else {
      fromSelect.innerHTML = '<option value="" disabled selected>Select a trigger asset first</option>';
      fromSelect.disabled = true;
    }

    // To asset: all balance assets except the trigger asset
    toSelect.innerHTML = '';
    toSelect.disabled = false;

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.selected = true;
    placeholder.textContent = 'Select target asset...';
    toSelect.appendChild(placeholder);

    for (const asset of Object.keys(this.balances).sort((a, b) => a.localeCompare(b))) {
      if (asset === triggerAsset) continue;
      const opt = document.createElement('option');
      opt.value = asset;
      opt.textContent = asset;
      toSelect.appendChild(opt);
    }
  }

  private onConvertAmountModeChanged(): void {
    // No longer used — kept as no-op for any stale listeners
  }

  private updateConvertAmountHint(): void {
    const hint = document.getElementById('convert-amount-hint');
    const triggerAsset = (document.getElementById('trigger-asset') as HTMLSelectElement)?.value;
    const balance = triggerAsset ? this.balances[triggerAsset] : null;
    if (hint && balance) {
      hint.textContent = `Available: ${parseFloat(balance).toFixed(8)} ${triggerAsset}`;
    } else if (hint) {
      hint.textContent = '';
    }
  }

  private onTriggerTypeChanged(): void {
    const triggerType = (document.getElementById('trigger-type') as HTMLSelectElement).value;
    const orderSection = document.getElementById('trigger-order-section');
    const balanceSections = document.querySelectorAll('.trigger-balance-section');
    const amountModeSection = document.getElementById('amount-mode-section');

    if (triggerType === 'balance_threshold') {
      orderSection?.classList.add('d-none');
      balanceSections.forEach(el => el.classList.remove('d-none'));
      amountModeSection?.classList.add('d-none');

      // Enable Convert Crypto option for balance threshold
      const actionTypeSelectBT = document.getElementById('action-type') as HTMLSelectElement;
      const convertOptionBT = actionTypeSelectBT?.querySelector('option[value="convert_crypto"]') as HTMLOptionElement;
      if (convertOptionBT) convertOptionBT.disabled = false;

      this.selectedOrder = null;
      this.maxAmount = 0;

      const assetSelect = document.getElementById('action-asset') as HTMLSelectElement;
      if (assetSelect) {
        assetSelect.innerHTML = '<option value="" disabled selected>Select a trigger asset first</option>';
        assetSelect.disabled = true;
      }

      this.populateAddressDropdown();
      this.loadBalances();

      const amountInput = document.getElementById('action-amount') as HTMLInputElement;
      if (amountInput) {
        amountInput.disabled = true;
        amountInput.removeAttribute('max');
        amountInput.removeAttribute('required');
        amountInput.placeholder = 'Full balance (auto)';
        amountInput.value = '';
      }

      const hint = document.getElementById('amount-hint');
      if (hint) hint.textContent = '';

      document.querySelectorAll('input[name="amount-mode"]').forEach((r) => {
        (r as HTMLInputElement).disabled = false;
      });
    } else {
      // Show order fields, hide balance fields
      orderSection?.classList.remove('d-none');
      balanceSections.forEach(el => el.classList.add('d-none'));
      amountModeSection?.classList.remove('d-none');

      // Disable and deselect Convert Crypto option
      const actionTypeSelectOF = document.getElementById('action-type') as HTMLSelectElement;
      const convertOptionOF = actionTypeSelectOF?.querySelector('option[value="convert_crypto"]') as HTMLOptionElement;
      if (convertOptionOF) convertOptionOF.disabled = true;
      if (actionTypeSelectOF && actionTypeSelectOF.value === 'convert_crypto') {
        actionTypeSelectOF.value = 'withdraw_crypto';
        this.onActionTypeChanged();
      }

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

    this.updateRuleSummary();
  }

  private async loadBalances(): Promise<void> {
    const triggerAssetSelect = document.getElementById('trigger-asset') as HTMLSelectElement;
    const thresholdInput = document.getElementById('trigger-threshold') as HTMLInputElement;

    try {
      this.balances = await ExchangeController.getBalance(this.selectedConnectionId!);

      triggerAssetSelect.innerHTML = '';
      triggerAssetSelect.disabled = false;

      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.disabled = true;
      placeholder.selected = true;
      placeholder.textContent = 'Select an asset...';
      triggerAssetSelect.appendChild(placeholder);

      for (const [asset, amount] of Object.entries(this.balances).sort(([a], [b]) => a.localeCompare(b))) {
        const opt = document.createElement('option');
        opt.value = asset;
        opt.textContent = `${asset} (Balance: ${parseFloat(amount).toFixed(8)})`;
        triggerAssetSelect.appendChild(opt);
      }

      thresholdInput.disabled = false;
    } catch {
      triggerAssetSelect.innerHTML = '<option value="" disabled selected>Failed to load balances</option>';
      triggerAssetSelect.disabled = true;
      thresholdInput.disabled = true;
    }
  }

  private onTriggerAssetChanged(): void {
    const triggerType = (document.getElementById('trigger-type') as HTMLSelectElement)?.value;
    if (triggerType !== 'balance_threshold') return;

    const triggerAssetSelect = document.getElementById('trigger-asset') as HTMLSelectElement;
    if (!triggerAssetSelect) return;
    
    const selectedAsset = triggerAssetSelect.value;
    if (!selectedAsset) return;

    const assetSelect = document.getElementById('action-asset') as HTMLSelectElement;
    if (!assetSelect) return;

    assetSelect.innerHTML = '';
    assetSelect.disabled = false;

    const opt = document.createElement('option');
    opt.value = selectedAsset;
    opt.textContent = selectedAsset;
    opt.selected = true;
    assetSelect.appendChild(opt);

    const balance = this.balances[selectedAsset];
    const thresholdHint = document.getElementById('threshold-hint');
    if (thresholdHint && balance) {
      thresholdHint.textContent = `Current balance: ${parseFloat(balance).toFixed(8)} ${selectedAsset}`;
    }

    // Show minimum withdrawal hint for balance threshold
    this.updateMinWithdrawalHint(selectedAsset);

    // Refresh convert dropdowns if convert mode is active
    const actionTypeVal = (document.getElementById('action-type') as HTMLSelectElement)?.value;
    if (actionTypeVal === 'convert_crypto') {
      this.populateConvertDropdowns();
      this.updateConvertAmountHint();
    }

    this.updateRuleSummary();
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
        const { base, quote } = this.parsePair(this.selectedOrder.pair);
        const receivedAsset = this.selectedOrder.side === 'sell' ? quote : base;
        hint.textContent = `Est. max ${this.maxAmount.toFixed(6)} ${receivedAsset}`;
      }
      if (modeHint) modeHint.textContent = 'Withdraws the actual filled amount when the order completes';
    } else {
      if (this.selectedOrder) {
        const actionAsset = (document.getElementById('action-asset') as HTMLSelectElement)?.value || '';
        const minW = this.getMinForAsset(actionAsset);
        amountInput.disabled = false;
        amountInput.max = this.maxAmount.toString();
        if (minW > 0) {
          amountInput.min = minW.toString();
        } else {
          amountInput.removeAttribute('min');
        }
        amountInput.placeholder = `Max: ${this.maxAmount.toFixed(6)}`;
        amountInput.setAttribute('required', '');
        slider.disabled = false;
        slider.value = '100';
        this.onSliderChanged('100');
        if (hint) {
          const { base, quote } = this.parsePair(this.selectedOrder.pair);
          const receivedAsset = this.selectedOrder.side === 'sell' ? quote : base;
          hint.textContent = `Max ${this.maxAmount.toFixed(6)} ${receivedAsset}`;
        }
      }
      if (modeHint) modeHint.textContent = '';
    }

    this.updateRuleSummary();
  }

  private onSliderChanged(value: string): void {
    let percentage = parseInt(value, 10);
    const sliderValueEl = document.getElementById('slider-value');
    const amountInput = document.getElementById('action-amount') as HTMLInputElement;
    const slider = document.getElementById('amount-slider') as HTMLInputElement;

    // Clamp slider so the resulting amount can't go below minimum
    const actionAsset = (document.getElementById('action-asset') as HTMLSelectElement)?.value || '';
    const minW = this.getMinForAsset(actionAsset);
    if (minW > 0 && this.maxAmount > 0) {
      const minPct = Math.ceil((minW / this.maxAmount) * 100);
      if (percentage < minPct && percentage !== 0) {
        percentage = minPct;
        if (slider) slider.value = percentage.toString();
      }
    }

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
    const parts = pair.split('/');
    return { base: parts[0] || pair, quote: parts[1] || '' };
  }

  private async createRule(): Promise<void> {
    const ruleName = (document.getElementById('rule-name') as HTMLInputElement).value.trim();
    const triggerType = (document.getElementById('trigger-type') as HTMLSelectElement).value;
    const actionType = (document.getElementById('action-type') as HTMLSelectElement).value;
    const actionAsset = (document.getElementById('action-asset') as HTMLSelectElement).value;
    const actionAddressKey = (document.getElementById('action-address-key') as HTMLSelectElement).value;

    const isConvert = actionType === 'convert_crypto';
    if (!ruleName || (!isConvert && (!actionAsset || !actionAddressKey))) {
      this.showError('Please fill in all required fields');
      return;
    }

    const connectionId = this.selectedConnectionId;
    if (!connectionId) {
      this.showError('No exchange selected');
      return;
    }

    const payload: any = {
      rule_name: ruleName,
      trigger_type: triggerType,
      action_type: actionType,
      action_asset: actionAsset,
      action_address_key: actionAddressKey,
      trigger_exchange_id: connectionId,
      action_exchange_id: connectionId,
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

      if (isConvert) {
        const convertTo = (document.getElementById('convert-to-asset') as HTMLSelectElement).value;
        if (!convertTo) {
          this.showError('Please select a target asset to convert to');
          return;
        }
        payload.action_asset = triggerAsset;
        payload.action_address_key = '';
        payload.convert_to_asset = convertTo;

        const convertAmount = (document.getElementById('convert-amount') as HTMLInputElement).value.trim();
        if (convertAmount && parseFloat(convertAmount) > 0) {
          payload.action_amount = convertAmount;
        } else {
          payload.action_amount = '';
        }
      } else {
        payload.action_amount = '';
      }

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

        // Validate against minimum withdrawal (with cushion)
        const minWithdrawal = this.getMinForAsset(actionAsset);
        if (minWithdrawal > 0 && amount < minWithdrawal) {
          this.showError(`Amount ${amount} is below the minimum withdrawal of ${minWithdrawal.toFixed(6)} ${actionAsset} (includes buffer)`);
          return;
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
        ? `${r.trigger_count}x (${new Date(r.last_triggered_at.endsWith('Z') ? r.last_triggered_at : r.last_triggered_at + 'Z').toLocaleString()})`
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
      const asset = rule.trigger_asset || '';
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
    if (rule.action_type === 'convert_crypto') {
      const convertAmountText = rule.action_amount
        ? `<strong>${this.escapeHtml(rule.action_amount)}</strong>`
        : '<em>Full Balance</em>';
      return `Convert ${convertAmountText} `
        + `<span class="asset-badge">${this.escapeHtml(rule.action_asset)}</span> `
        + `→ <span class="asset-badge">${this.escapeHtml(rule.convert_to_asset || '?')}</span>`;
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
      const time = l.created_at ? new Date(l.created_at.endsWith('Z') ? l.created_at : l.created_at + 'Z').toLocaleString() : '--';
      const statusClass = l.status === 'success' ? 'status-success' : 'status-error';

      return `<tr>
        <td>${this.escapeHtml(time)}</td>
        <td>${this.escapeHtml(l.trigger_event)}</td>
        <td>${this.escapeHtml(l.action_executed)}</td>
        <td class="result-cell">${this.escapeHtml(l.action_result)}</td>
        <td><span class="status-badge ${statusClass}">${this.escapeHtml(l.status)}</span></td>
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

  private async loadWithdrawalMinimums(): Promise<void> {
    try {
      this.withdrawalMinimums = await AutomationController.getWithdrawalMinimums();
    } catch {
      this.withdrawalMinimums = {};
    }
  }

  private getMinForAsset(asset: string): number {
    if (!asset) return 0;
    return this.withdrawalMinimums[asset] || 0;
  }

  private updateMinWithdrawalHint(asset: string): void {
    const hint = document.getElementById('min-withdrawal-hint');
    if (!hint) return;
    const min = this.getMinForAsset(asset);
    if (min > 0) {
      hint.textContent = `Min withdrawal: ${this.formatMin(min)} ${asset} (incl. buffer)`;
    } else {
      hint.textContent = '';
    }
  }

  private formatMin(value: number): string {
    return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  }

  private validateAmountLive(): void {
    const amountInput = document.getElementById('action-amount') as HTMLInputElement;
    if (!amountInput || amountInput.disabled) return;

    const actionAsset = (document.getElementById('action-asset') as HTMLSelectElement)?.value || '';
    const minW = this.getMinForAsset(actionAsset);
    if (minW <= 0) {
      this.clearMinWarning();
      this.setCreateButtonEnabled(true);
      return;
    }

    const amount = parseFloat(amountInput.value);
    if (!isNaN(amount) && amount < minW) {
      this.showMinWarning(`Amount ${amount} is below the minimum withdrawal of ${this.formatMin(minW)} ${actionAsset}`);
      this.setCreateButtonEnabled(false);
    } else {
      this.clearMinWarning();
      this.setCreateButtonEnabled(true);
    }
  }

  private showMinWarning(message: string): void {
    const hint = document.getElementById('min-withdrawal-hint');
    if (hint) {
      hint.textContent = message;
      hint.classList.add('min-warning');
    }
  }

  private clearMinWarning(): void {
    const hint = document.getElementById('min-withdrawal-hint');
    if (hint) {
      hint.classList.remove('min-warning');
      // Restore the standard hint if an asset is selected
      const actionAsset = (document.getElementById('action-asset') as HTMLSelectElement)?.value || '';
      if (actionAsset) {
        this.updateMinWithdrawalHint(actionAsset);
      }
    }
  }

  private setCreateButtonEnabled(enabled: boolean): void {
    const btn = document.getElementById('create-rule-btn') as HTMLButtonElement;
    if (btn) btn.disabled = !enabled;
  }

  private updateRuleSummary(): void {
    const summaryContainer = document.getElementById('rule-summary');
    const summaryText = document.getElementById('rule-summary-text');
    if (!summaryContainer || !summaryText) return;

    const triggerType = (document.getElementById('trigger-type') as HTMLSelectElement)?.value;
    const addressKey = (document.getElementById('action-address-key') as HTMLSelectElement)?.value;
    const actionTypeForSummary = (document.getElementById('action-type') as HTMLSelectElement)?.value;

    // Hide summary if no address selected (except for convert mode)
    if (!addressKey && actionTypeForSummary !== 'convert_crypto') {
      summaryContainer.classList.add('d-none');
      return;
    }

    let summary = '';

    if (triggerType === 'balance_threshold') {
      const triggerAsset = (document.getElementById('trigger-asset') as HTMLSelectElement)?.value;
      const threshold = (document.getElementById('trigger-threshold') as HTMLInputElement)?.value;
      const cooldownHours = parseInt((document.getElementById('cooldown-hours') as HTMLInputElement)?.value || '0', 10);
      const cooldownMins = parseInt((document.getElementById('cooldown-minutes') as HTMLInputElement)?.value || '0', 10);
      const totalCooldown = (cooldownHours * 60) + cooldownMins;

      if (!triggerAsset || !threshold) {
        summaryContainer.classList.add('d-none');
        return;
      }

      const assetDisplay = triggerAsset;
      const cooldownDisplay = this.formatCooldown(totalCooldown);
      
      if (actionTypeForSummary === 'convert_crypto') {
        const convertTo = (document.getElementById('convert-to-asset') as HTMLSelectElement)?.value || '___';
        const convertAmountVal = (document.getElementById('convert-amount') as HTMLInputElement)?.value;
        const convertAmountDisplay = (convertAmountVal && parseFloat(convertAmountVal) > 0)
          ? `${parseFloat(convertAmountVal).toFixed(8).replace(/\.?0+$/, '')} ${assetDisplay}`
          : `full ${assetDisplay} balance`;
        summary = `When ${assetDisplay} balance reaches ${parseFloat(threshold).toFixed(8).replace(/\.?0+$/, '')}, wait ${cooldownDisplay}, then convert ${convertAmountDisplay} to ${convertTo}`;
      } else {
        summary = `When ${assetDisplay} balance reaches ${parseFloat(threshold).toFixed(8).replace(/\.?0+$/, '')}, wait ${cooldownDisplay}, then withdraw full balance to ${addressKey}`;
      }
    } else {
      // order_filled
      const orderId = (document.getElementById('trigger-order-id') as HTMLSelectElement)?.value;
      const actionAsset = (document.getElementById('action-asset') as HTMLSelectElement)?.value;
      const amountMode = (document.querySelector('input[name="amount-mode"]:checked') as HTMLInputElement)?.value;
      const amount = (document.getElementById('action-amount') as HTMLInputElement)?.value;

      if (!orderId || !actionAsset) {
        summaryContainer.classList.add('d-none');
        return;
      }

      const orderIdShort = orderId.substring(0, 10) + '...';
      const assetDisplay = actionAsset;

      if (amountMode === 'filled') {
        summary = `When order ${orderIdShort} fills, withdraw filled amount of ${assetDisplay} to ${addressKey}`;
      } else {
        let amountDisplay = '___';
        if (amount && parseFloat(amount) > 0) {
          amountDisplay = parseFloat(amount).toFixed(8).replace(/\.?0+$/, '');
        }
        summary = `When order ${orderIdShort} fills, withdraw ${amountDisplay} ${assetDisplay} to ${addressKey}`;
      }
    }

    summaryText.textContent = summary;
    summaryContainer.classList.remove('d-none');
  }
}

new CommandsController();

})();
