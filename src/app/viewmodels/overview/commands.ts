(function () {

// /** Stablecoins supported per exchange (raw exchange_name key). */
// const EXCHANGE_STABLECOINS: Record<string, string[]> = {
//   kraken:   ['USDT', 'USDC', 'DAI'],
//   coinbase: ['USDC', 'USDT', 'DAI'],
// };
//
// /** Popular crypto supported per exchange (raw exchange_name key). */
// const EXCHANGE_CRYPTO: Record<string, string[]> = {
//   // Kraken uses XBT, not BTC
//   kraken:   ['XBT', 'ETH', 'XRP', 'SOL', 'ADA', 'DOGE', 'TRX', 'AVAX', 'LINK', 'DOT', 'MATIC', 'LTC', 'UNI', 'ATOM', 'XLM', 'BCH', 'ETC', 'FIL'],
//   coinbase: ['BTC', 'ETH', 'XRP', 'SOL', 'ADA', 'DOGE', 'AVAX', 'MATIC', 'LINK', 'DOT', 'LTC', 'UNI', 'ATOM', 'ALGO', 'SHIB'],
// };
//
// /** Fallback lists used when the exchange is unknown. */
// const FALLBACK_STABLECOINS: string[] = ['USDT', 'USDC', 'DAI'];
// const FALLBACK_CRYPTO: string[]      = ['BTC', 'ETH', 'XRP', 'SOL', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT', 'LTC'];

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
  private allRules: any[] = [];
  private allLogs: any[] = [];
  private rulesViewMode: 'table' | 'flow' | 'log' = 'table';
  private wizardStep: 1 | 2 | 3 = 1;
  private filteredRules: any[] = [];

  constructor() {
    this.init();
  }

  private init(): void {
    this.attachEventListeners();
    this.onTriggerTypeChanged();
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
    this.applyRulesFilter();
    this.applyLogsFilter();

    // Re-populate trigger-type-specific dropdowns that depend on the exchange
    const triggerType = (document.getElementById('trigger-type') as HTMLSelectElement)?.value;
    if (triggerType === 'price_threshold') {
      const priceAssetSelect = document.getElementById('price-trigger-asset') as HTMLSelectElement;
      if (priceAssetSelect) {
        priceAssetSelect.innerHTML = '<option value="" disabled selected>Loading coins...</option>';
        priceAssetSelect.disabled = true;
      }
      this.loadPriceAssets();
    } else if (triggerType === 'balance_threshold') {
      const triggerAssetSelect = document.getElementById('trigger-asset') as HTMLSelectElement;
      if (triggerAssetSelect) {
        triggerAssetSelect.innerHTML = '<option value="" disabled selected>Loading balances...</option>';
        triggerAssetSelect.disabled = true;
      }
      this.loadBalances();
    }
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
    const orderSelect = document.getElementById('trigger-order-id') as HTMLSelectElement;
    if (orderSelect) {
      orderSelect.innerHTML = '<option value="" disabled selected>Loading orders...</option>';
      orderSelect.disabled = true;
    }
    // Reuse the store's short-lived cache so opening this page (or switching
    // back to it) doesn't refetch within a few minutes for the same exchange.
    const { orders, addresses } = await ExchangeStore.getConnectionData(this.selectedConnectionId);
    this.localOpenOrders = orders;
    this.localWithdrawalAddresses = addresses;
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

    document.getElementById('price-trigger-asset')?.addEventListener('change', () => {
      this.onPriceTriggerAssetChanged();
    });

    document.getElementById('price-trigger-threshold')?.addEventListener('input', () => {
      this.updateRuleSummary();
    });

    document.getElementById('price-quote-asset')?.addEventListener('change', () => {
      this.updateRuleSummary();
    });

    document.getElementById('price-convert-to-asset')?.addEventListener('change', () => {
      this.updateRuleSummary();
    });

    document.getElementById('price-unlimited')?.addEventListener('change', () => {
      this.onPriceUnlimitedChanged();
      this.updateRuleSummary();
    });

    document.getElementById('price-max-executions')?.addEventListener('input', () => {
      this.updateRuleSummary();
    });

    document.querySelectorAll('input[name="price-amount-mode"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        this.onPriceAmountModeChanged();
        this.updateRuleSummary();
      });
    });

    document.getElementById('price-amount-value')?.addEventListener('input', () => {
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
      } else if (action === 'edit') {
        const rule = this.allRules.find((r: any) => r.id === ruleId);
        if (rule) this.openEditModal(rule);
      }
    });

    // Tab strip toggle: Active Rules <-> Rule Flow
    document.getElementById('rules-tab-strip')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.rules-tab-btn') as HTMLElement | null;
      if (!btn) return;
      const tab = btn.getAttribute('data-tab') as 'table' | 'flow' | 'log' | null;
      if (!tab || tab === this.rulesViewMode) return;
      this.rulesViewMode = tab;
      document.querySelectorAll('.rules-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      this.applyTabView();
      // Re-render the flow once visible so SVG arrows measure real positions.
      if (tab === 'flow') this.renderRuleFlow(this.filteredRules);
    });

    // ── Create Automation wizard modal ──
    document.getElementById('new-automation-btn')?.addEventListener('click', () => this.openCreateModal());
    document.getElementById('empty-blank-btn')?.addEventListener('click', () => this.openCreateModal());
    document.getElementById('create-rule-modal-close')?.addEventListener('click', () => this.closeCreateModal());
    document.getElementById('create-rule-overlay')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'create-rule-overlay') this.closeCreateModal();
    });
    document.getElementById('wizard-next')?.addEventListener('click', () => this.wizardNext());
    document.getElementById('wizard-back')?.addEventListener('click', () => this.setWizardStep((this.wizardStep - 1) as 1 | 2 | 3));

    // Starter templates (empty state)
    document.querySelectorAll('.template-card').forEach(card => {
      card.addEventListener('click', () => {
        const tpl = card.getAttribute('data-template');
        if (tpl) this.openCreateModal(tpl);
      });
    });

    // Flow chart hover tooltips are handled internally by RuleFlow.

    // Edit rule modal
    document.getElementById('edit-rule-modal-close')?.addEventListener('click', () => this.closeEditModal());
    document.getElementById('edit-rule-cancel')?.addEventListener('click', () => this.closeEditModal());
    document.getElementById('edit-rule-save')?.addEventListener('click', () => this.saveEditModal());

    document.getElementById('edit-rule-overlay')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'edit-rule-overlay') this.closeEditModal();
    });

    document.getElementById('edit-unlimited')?.addEventListener('change', () => {
      const checked = (document.getElementById('edit-unlimited') as HTMLInputElement).checked;
      const maxInput = document.getElementById('edit-max-executions') as HTMLInputElement;
      maxInput.disabled = checked;
      if (checked) maxInput.value = '';
    });

    document.querySelectorAll('input[name="edit-amount-mode"]').forEach(r => {
      r.addEventListener('change', () => {
        const mode = (document.querySelector('input[name="edit-amount-mode"]:checked') as HTMLInputElement)?.value;
        const amtInput = document.getElementById('edit-action-amount') as HTMLInputElement;
        amtInput.disabled = (mode === 'filled');
        if (mode === 'filled') amtInput.value = '';
      });
    });

    document.querySelectorAll('input[name="edit-price-amount-mode"]').forEach(r => {
      r.addEventListener('change', () => {
        const mode = (document.querySelector('input[name="edit-price-amount-mode"]:checked') as HTMLInputElement)?.value;
        const amtInput = document.getElementById('edit-price-amount-value') as HTMLInputElement;
        amtInput.disabled = (mode === 'all');
        if (mode === 'all') amtInput.value = '';
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const editOverlay = document.getElementById('edit-rule-overlay');
        if (editOverlay && !editOverlay.classList.contains('d-none')) { this.closeEditModal(); return; }
        const createOverlay = document.getElementById('create-rule-overlay');
        if (createOverlay && !createOverlay.classList.contains('d-none')) this.closeCreateModal();
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
      select.disabled = true;
      return;
    }

    select.disabled = false;

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
    const notice = document.getElementById('withdraw-unsupported-notice');
    const conn = ExchangeStore.connections.find(c => c.id === this.selectedConnectionId);
    const noAddressSupport = conn ? !ExchangeStore.exchangeSupportsWithdrawals(conn.exchange_name) : false;
    if (notice) {
      if (noAddressSupport && conn) {
        const meta = ExchangeStore.supportedExchanges.find((e: any) => e.id === conn.exchange_name);
        const name = meta?.name ?? conn.exchange_name;
        notice.textContent = `Whitelisted withdrawal addresses are not supported for ${name}. Only "Convert Crypto" is available for this exchange.`;
        notice.classList.remove('d-none');
      } else {
        notice.classList.add('d-none');
      }
    }

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

    if (triggerType === 'price_threshold') {
      withdrawFields?.classList.add('d-none');
      document.getElementById('withdraw-unsupported-notice')?.classList.add('d-none');
      convertFields?.classList.add('d-none');
      amountModeSection?.classList.add('d-none');
      convertAmountSection?.classList.add('d-none');
      this.updateRuleSummary();
      return;
    }

    if (actionType === 'convert_crypto' && triggerType === 'balance_threshold') {
      withdrawFields?.classList.add('d-none');
      document.getElementById('withdraw-unsupported-notice')?.classList.add('d-none');
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

  // /** Returns the raw exchange_name for the currently selected connection (e.g. 'kraken', 'coinbase'). */
  // private getSelectedExchangeName(): string {
  //   if (!this.selectedConnectionId) return '';
  //   const conn = ExchangeStore.connections.find((c) => c.id === this.selectedConnectionId);
  //   return conn?.exchange_name ?? '';
  // }

  // private appendCommonAssets(
  //   select: HTMLSelectElement,
  //   ownedSet: Set<string>,
  //   excludeSet: Set<string> = new Set(),
  // ): void {
  //   const exchangeName = this.getSelectedExchangeName();
  //   const stableList = EXCHANGE_STABLECOINS[exchangeName] ?? FALLBACK_STABLECOINS;
  //   const cryptoList  = EXCHANGE_CRYPTO[exchangeName]     ?? FALLBACK_CRYPTO;
  //
  //   const stableOptions = stableList.filter(
  //     (c) => !ownedSet.has(c) && !excludeSet.has(c),
  //   );
  //   const cryptoOptions = cryptoList.filter(
  //     (c) => !ownedSet.has(c) && !excludeSet.has(c),
  //   );
  //
  //   if (stableOptions.length > 0) {
  //     const group = document.createElement('optgroup');
  //     group.label = 'Stablecoins';
  //     for (const coin of stableOptions) {
  //       const opt = document.createElement('option');
  //       opt.value = coin;
  //       opt.textContent = coin;
  //       group.appendChild(opt);
  //     }
  //     select.appendChild(group);
  //   }
  //
  //   if (cryptoOptions.length > 0) {
  //     const group = document.createElement('optgroup');
  //     group.label = 'Popular Coins';
  //     for (const coin of cryptoOptions) {
  //       const opt = document.createElement('option');
  //       opt.value = coin;
  //       opt.textContent = coin;
  //       group.appendChild(opt);
  //     }
  //     select.appendChild(group);
  //   }
  // }

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

    // To asset: all balance assets except the trigger asset, supplemented with common defaults
    toSelect.innerHTML = '';
    toSelect.disabled = false;

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.selected = true;
    placeholder.textContent = 'Select target asset...';
    toSelect.appendChild(placeholder);

    const defaultAssets = [
      'USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'FDUSD',
      'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE',
      'AVAX', 'DOT', 'MATIC', 'LINK', 'ATOM', 'LTC', 'UNI',
      'SHIB', 'TRX', 'ALGO', 'EUR', 'USD',
    ];
    const allTargets = new Set<string>([...defaultAssets, ...Object.keys(this.balances)]);
    if (triggerAsset) allTargets.delete(triggerAsset);

    for (const asset of Array.from(allTargets).sort((a, b) => a.localeCompare(b))) {
      const opt = document.createElement('option');
      opt.value = asset;
      opt.textContent = asset;
      toSelect.appendChild(opt);
    }

    // const ownedAssets = Object.keys(this.balances);
    // const holdingTargets = ownedAssets.filter((a) => a !== triggerAsset).sort((a, b) => a.localeCompare(b));
    // if (holdingTargets.length > 0) {
    //   const holdingsGroup = document.createElement('optgroup');
    //   holdingsGroup.label = 'Your Holdings';
    //   for (const asset of holdingTargets) {
    //     const opt = document.createElement('option');
    //     opt.value = asset;
    //     opt.textContent = asset;
    //     holdingsGroup.appendChild(opt);
    //   }
    //   toSelect.appendChild(holdingsGroup);
    // }
    // const ownedSet = new Set(ownedAssets);
    // const excludeSet = triggerAsset ? new Set([triggerAsset]) : new Set<string>();
    // this.appendCommonAssets(toSelect, ownedSet, excludeSet);
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
    const priceSections = document.querySelectorAll('.trigger-price-section');
    const amountModeSection = document.getElementById('amount-mode-section');
    const actionTypeSelect = document.getElementById('action-type') as HTMLSelectElement;

    priceSections.forEach(el => el.classList.add('d-none'));

    if (triggerType === 'balance_threshold') {
      orderSection?.classList.add('d-none');
      balanceSections.forEach(el => el.classList.remove('d-none'));
      amountModeSection?.classList.add('d-none');
      document.getElementById('action-type-divider')?.classList.remove('d-none');
      document.getElementById('action-type-row')?.classList.remove('d-none');

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
      this.onActionTypeChanged();
    } else if (triggerType === 'price_threshold') {
      orderSection?.classList.add('d-none');
      balanceSections.forEach(el => el.classList.add('d-none'));
      document.getElementById('cooldown-section')?.classList.remove('d-none');
      priceSections.forEach(el => el.classList.remove('d-none'));
      amountModeSection?.classList.add('d-none');
      document.getElementById('action-type-divider')?.classList.add('d-none');
      document.getElementById('action-type-row')?.classList.add('d-none');

      // Force convert action for price-trigger rules
      if (actionTypeSelect) {
        actionTypeSelect.value = 'convert_crypto';
      }

      const withdrawOption = actionTypeSelect?.querySelector('option[value="withdraw_crypto"]') as HTMLOptionElement;
      if (withdrawOption) withdrawOption.disabled = true;

      const convertOption = actionTypeSelect?.querySelector('option[value="convert_crypto"]') as HTMLOptionElement;
      if (convertOption) convertOption.disabled = false;

      this.resetDependentFields();
      this.loadBalances();
      this.loadPriceAssets();
      this.onPriceAmountModeChanged();
      this.onPriceUnlimitedChanged();
      this.onActionTypeChanged();
    } else {
      // Show order fields, hide balance fields
      orderSection?.classList.remove('d-none');
      balanceSections.forEach(el => el.classList.add('d-none'));
      amountModeSection?.classList.remove('d-none');
      document.getElementById('action-type-divider')?.classList.remove('d-none');
      document.getElementById('action-type-row')?.classList.remove('d-none');

      // Disable and deselect Convert Crypto option
      const actionTypeSelectOF = document.getElementById('action-type') as HTMLSelectElement;
      const convertOptionOF = actionTypeSelectOF?.querySelector('option[value="convert_crypto"]') as HTMLOptionElement;
      if (convertOptionOF) convertOptionOF.disabled = true;
      const withdrawOptionOF = actionTypeSelectOF?.querySelector('option[value="withdraw_crypto"]') as HTMLOptionElement;
      if (withdrawOptionOF) withdrawOptionOF.disabled = false;
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

      // const ownedAssets = Object.keys(this.balances);
      // if (ownedAssets.length > 0) {
      //   const holdingsGroup = document.createElement('optgroup');
      //   holdingsGroup.label = 'Your Holdings';
      //   for (const [asset, amount] of Object.entries(this.balances).sort(([a], [b]) => a.localeCompare(b))) {
      //     const opt = document.createElement('option');
      //     opt.value = asset;
      //     opt.textContent = `${asset} (Balance: ${parseFloat(amount).toFixed(8)})`;
      //     holdingsGroup.appendChild(opt);
      //   }
      //   triggerAssetSelect.appendChild(holdingsGroup);
      // }
      // const ownedSet = new Set(ownedAssets);
      // this.appendCommonAssets(triggerAssetSelect, ownedSet);

      thresholdInput.disabled = false;
    } catch {
      triggerAssetSelect.innerHTML = '<option value="" disabled selected>Failed to load balances</option>';
      triggerAssetSelect.disabled = true;
      thresholdInput.disabled = true;
    }
  }

  private async loadPriceAssets(): Promise<void> {
    const assetSelect = document.getElementById('price-trigger-asset') as HTMLSelectElement;
    const thresholdInput = document.getElementById('price-trigger-threshold') as HTMLInputElement;

    try {
      this.balances = await ExchangeController.getBalance(this.selectedConnectionId!);

      assetSelect.innerHTML = '';
      assetSelect.disabled = false;

      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.disabled = true;
      placeholder.selected = true;
      placeholder.textContent = 'Select a coin...';
      assetSelect.appendChild(placeholder);

      for (const [asset, amount] of Object.entries(this.balances).sort(([a], [b]) => a.localeCompare(b))) {
        const opt = document.createElement('option');
        opt.value = asset;
        opt.textContent = `${asset} (Balance: ${parseFloat(amount).toFixed(8)})`;
        assetSelect.appendChild(opt);
      }

      // const ownedAssets = Object.keys(this.balances);
      // if (ownedAssets.length > 0) {
      //   const holdingsGroup = document.createElement('optgroup');
      //   holdingsGroup.label = 'Your Holdings';
      //   for (const [asset, amount] of Object.entries(this.balances).sort(([a], [b]) => a.localeCompare(b))) {
      //     const opt = document.createElement('option');
      //     opt.value = asset;
      //     opt.textContent = `${asset} (Balance: ${parseFloat(amount).toFixed(8)})`;
      //     holdingsGroup.appendChild(opt);
      //   }
      //   assetSelect.appendChild(holdingsGroup);
      // }
      // const ownedSet = new Set(ownedAssets);
      // this.appendCommonAssets(assetSelect, ownedSet);

      thresholdInput.disabled = false;
    } catch {
      assetSelect.innerHTML = '<option value="" disabled selected>Failed to load balances</option>';
      assetSelect.disabled = true;
      thresholdInput.disabled = true;
    }
  }

  private onPriceTriggerAssetChanged(): void {
    const asset = (document.getElementById('price-trigger-asset') as HTMLSelectElement)?.value;
    const hint = document.getElementById('price-threshold-hint');
    const toSelect = document.getElementById('price-convert-to-asset') as HTMLSelectElement;

    if (hint) {
      const bal = asset ? this.balances[asset] : null;
      hint.textContent = bal ? `Current balance: ${parseFloat(bal).toFixed(8)} ${asset}` : '';
    }

    if (!toSelect) return;
    toSelect.innerHTML = '';

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.selected = true;
    placeholder.textContent = 'Select target asset...';
    toSelect.appendChild(placeholder);

    if (!asset) {
      toSelect.disabled = true;
      return;
    }

    const preferredTargets = [
      'USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'FDUSD',
      'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE',
      'AVAX', 'DOT', 'MATIC', 'LINK', 'ATOM', 'LTC', 'UNI',
      'SHIB', 'TRX', 'ALGO', 'EUR', 'USD',
    ];
    const allTargets = new Set<string>([...preferredTargets, ...Object.keys(this.balances)]);
    allTargets.delete(asset);

    for (const target of Array.from(allTargets).sort((a, b) => a.localeCompare(b))) {
      const opt = document.createElement('option');
      opt.value = target;
      opt.textContent = target;
      toSelect.appendChild(opt);
    }
    toSelect.disabled = false;

    // const ownedAssets = Object.keys(this.balances);
    // const ownedSet = new Set(ownedAssets);
    // const excludeSet = new Set([asset]);
    // const holdingTargets = ownedAssets.filter((a) => a !== asset).sort((a, b) => a.localeCompare(b));
    // if (holdingTargets.length > 0) {
    //   const holdingsGroup = document.createElement('optgroup');
    //   holdingsGroup.label = 'Your Holdings';
    //   for (const target of holdingTargets) {
    //     const opt = document.createElement('option');
    //     opt.value = target;
    //     opt.textContent = target;
    //     holdingsGroup.appendChild(opt);
    //   }
    //   toSelect.appendChild(holdingsGroup);
    // }
    // this.appendCommonAssets(toSelect, ownedSet, excludeSet);

    this.updatePriceAmountHint();
    this.updateRuleSummary();
  }

  private onPriceAmountModeChanged(): void {
    const mode = (document.querySelector('input[name="price-amount-mode"]:checked') as HTMLInputElement)?.value || 'all';
    const amountInput = document.getElementById('price-amount-value') as HTMLInputElement;
    if (!amountInput) return;

    if (mode === 'all') {
      amountInput.disabled = true;
      amountInput.value = '';
      amountInput.placeholder = 'Not needed for Sell All';
    } else if (mode === 'percent') {
      amountInput.disabled = false;
      amountInput.min = '0';
      amountInput.max = '100';
      amountInput.placeholder = 'e.g. 50';
    } else {
      amountInput.disabled = false;
      amountInput.min = '0';
      amountInput.removeAttribute('max');
      amountInput.placeholder = 'e.g. 25';
    }

    this.updatePriceAmountHint();
  }

  private onPriceUnlimitedChanged(): void {
    const unlimited = (document.getElementById('price-unlimited') as HTMLInputElement)?.checked ?? true;
    const input = document.getElementById('price-max-executions') as HTMLInputElement;
    if (!input) return;
    input.disabled = unlimited;
    if (unlimited) input.value = '';
  }

  private updatePriceAmountHint(): void {
    const hint = document.getElementById('price-amount-hint');
    const asset = (document.getElementById('price-trigger-asset') as HTMLSelectElement)?.value;
    const mode = (document.querySelector('input[name="price-amount-mode"]:checked') as HTMLInputElement)?.value || 'all';
    if (!hint) return;

    const balance = asset ? parseFloat(this.balances[asset] || '0') : 0;
    if (!asset || balance <= 0) {
      hint.textContent = '';
      return;
    }

    if (mode === 'all') {
      hint.textContent = `Will convert full available balance (${balance.toFixed(8)} ${asset}) each execution.`;
      return;
    }

    if (mode === 'percent') {
      hint.textContent = `Percent is applied to your current ${asset} balance each time.`;
      return;
    }

    hint.textContent = `Fixed amount will be capped to available balance (${balance.toFixed(8)} ${asset}).`;
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

    if (triggerType === 'price_threshold') {
      const triggerAsset = (document.getElementById('price-trigger-asset') as HTMLSelectElement).value;
      const triggerThreshold = (document.getElementById('price-trigger-threshold') as HTMLInputElement).value.trim();
      const triggerQuoteAsset = (document.getElementById('price-quote-asset') as HTMLSelectElement).value;
      const convertToAsset = (document.getElementById('price-convert-to-asset') as HTMLSelectElement).value;
      const amountMode = (document.querySelector('input[name="price-amount-mode"]:checked') as HTMLInputElement)?.value || 'all';
      const amountValue = (document.getElementById('price-amount-value') as HTMLInputElement).value.trim();
      const unlimited = (document.getElementById('price-unlimited') as HTMLInputElement)?.checked ?? true;
      const maxExecutionsRaw = (document.getElementById('price-max-executions') as HTMLInputElement)?.value.trim();
      const cooldownHours = parseInt((document.getElementById('cooldown-hours') as HTMLInputElement).value || '0', 10);
      const cooldownMins = parseInt((document.getElementById('cooldown-minutes') as HTMLInputElement).value || '0', 10);
      const totalCooldown = (cooldownHours * 60) + cooldownMins;

      if (!triggerAsset) {
        this.showError('Please select the coin to monitor/sell');
        return;
      }
      if (!triggerThreshold || parseFloat(triggerThreshold) <= 0) {
        this.showError('Trigger price must be a positive number');
        return;
      }
      if (!triggerQuoteAsset) {
        this.showError('Please select a trigger quote currency');
        return;
      }
      if (!convertToAsset) {
        this.showError('Please select a target currency/coin');
        return;
      }
      if (convertToAsset === triggerAsset) {
        this.showError('Target currency/coin must be different from source coin');
        return;
      }
      if (totalCooldown < 1) {
        this.showError('Cooldown must be at least 1 minute');
        return;
      }

      if (amountMode !== 'all') {
        const n = parseFloat(amountValue);
        if (!amountValue || isNaN(n) || n <= 0) {
          this.showError('Amount value must be a positive number');
          return;
        }
        if (amountMode === 'percent' && n > 100) {
          this.showError('Percent amount must be between 0 and 100');
          return;
        }
      }

      let maxExecutions: number | null = null;
      if (!unlimited) {
        const maxN = parseInt(maxExecutionsRaw || '0', 10);
        if (!maxExecutionsRaw || isNaN(maxN) || maxN < 1) {
          this.showError('Max executions must be at least 1 when unlimited is disabled');
          return;
        }
        maxExecutions = maxN;
      }

      payload.action_type = 'convert_crypto';
      payload.trigger_asset = triggerAsset;
      payload.trigger_threshold = triggerThreshold;
      payload.trigger_price_quote_asset = triggerQuoteAsset;
      payload.cooldown_minutes = totalCooldown;
      payload.action_asset = triggerAsset;
      payload.action_address_key = '';
      payload.convert_to_asset = convertToAsset;
      payload.action_amount_mode = amountMode;
      payload.action_amount = amountMode === 'all' ? '' : amountValue;
      payload.use_filled_amount = false;
      payload.max_executions = maxExecutions;
    } else if (triggerType === 'balance_threshold') {
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

      this.showSuccess('Automation created successfully');
      this.clearForm();
      this.closeCreateModal();
      this.loadRules();
    } catch (error: any) {
      this.showError(error.message || 'Failed to create rule');
    } finally {
      const btn = document.getElementById('create-rule-btn') as HTMLButtonElement;
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-plus"></i> Create Automation';
    }
  }

  private async loadRules(): Promise<void> {
    const tbody = document.getElementById('rules-tbody');
    if (tbody) tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Loading rules...</td></tr>';
    try {
      const rules = await AutomationController.getRules();
      this.allRules = rules;
      this.applyRulesFilter();
      this.populateOrderDropdown();
    } catch (error: any) {
      this.showError(error.message || 'Failed to load rules');
    }
  }

  private applyRulesFilter(): void {
    const filtered = this.selectedConnectionId !== null
      ? this.allRules.filter((r: any) => r.trigger_exchange_id === this.selectedConnectionId)
      : this.allRules;
    this.filteredRules = filtered;
    this.ruleOrderIds = new Set(filtered.map((r: any) => r.trigger_order_id).filter(Boolean));
    this.renderRules(filtered);
    this.renderRuleFlow(filtered);
    this.updateRulesCount(filtered.length);
    this.updateEmptyState(filtered.length);
  }

  private applyLogsFilter(): void {
    const filteredRuleIds = new Set(
      this.allRules
        .filter((r: any) => r.trigger_exchange_id === this.selectedConnectionId)
        .map((r: any) => r.id)
    );
    const filtered = this.selectedConnectionId !== null
      ? this.allLogs.filter((l: any) => filteredRuleIds.has(l.rule_id))
      : this.allLogs;
    this.renderLogs(filtered);
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
      let triggered = r.trigger_count > 0
        ? `${r.trigger_count}x (${new Date(r.last_triggered_at.endsWith('Z') ? r.last_triggered_at : r.last_triggered_at + 'Z').toLocaleString()})`
        : 'Never';

      if (r.trigger_type === 'price_threshold') {
        const done = Number(r.execution_count || 0);
        const max = r.max_executions == null ? 'unlimited' : String(r.max_executions);
        triggered += ` | Success: ${done}/${max}`;
      }

      return `<tr>
        <td class="rule-name-cell editable" data-action="edit" data-rule-id="${r.id}">${this.escapeHtml(r.rule_name)}</td>
        <td class="trigger-cell">${triggerText}</td>
        <td class="action-cell">${actionText}</td>
        <td><span class="status-badge ${statusClass}">${statusText}</span></td>
        <td>${this.escapeHtml(triggered)}</td>
        <td class="controls-cell">
          <button class="btn-icon" data-action="edit" data-rule-id="${r.id}" title="Edit Rule">
            <i class="fa-solid fa-pencil"></i>
          </button>
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
    if (rule.trigger_type === 'price_threshold') {
      const asset = rule.trigger_asset || '';
      const quote = rule.trigger_price_quote_asset || 'USDT';
      const threshold = rule.trigger_threshold || '0';
      const cooldown = this.formatCooldown(rule.cooldown_minutes || 1);
      return `<span class="trigger-badge trigger-badge-balance">Price ≥</span> `
        + `<strong>${this.escapeHtml(threshold)}</strong> `
        + `<span class="asset-badge">${this.escapeHtml(quote)}</span>`
        + `<br><span class="cooldown-text">${this.escapeHtml(asset)}/${this.escapeHtml(quote)} | Cooldown: ${cooldown}</span>`;
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
      let convertAmountText = rule.action_amount
        ? `<strong>${this.escapeHtml(rule.action_amount)}</strong>`
        : '<em>Full Balance</em>';
      if (rule.trigger_type === 'price_threshold') {
        const mode = (rule.action_amount_mode || 'all').toLowerCase();
        if (mode === 'percent') {
          convertAmountText = `<strong>${this.escapeHtml(rule.action_amount)}%</strong>`;
        } else if (mode === 'fixed') {
          convertAmountText = `<strong>${this.escapeHtml(rule.action_amount)}</strong>`;
        } else {
          convertAmountText = '<em>Sell All</em>';
        }
      }
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
    const tbody = document.getElementById('logs-tbody');
    if (tbody) tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Loading logs...</td></tr>';
    try {
      const logs = await AutomationController.getLogs(30);
      this.allLogs = logs;
      this.applyLogsFilter();
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
    if (el) el.textContent = `Your Automations (${count})`;
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

    const priceAsset = document.getElementById('price-trigger-asset') as HTMLSelectElement;
    if (priceAsset) priceAsset.selectedIndex = 0;
    const priceThreshold = document.getElementById('price-trigger-threshold') as HTMLInputElement;
    if (priceThreshold) priceThreshold.value = '';
    const priceQuote = document.getElementById('price-quote-asset') as HTMLSelectElement;
    if (priceQuote) priceQuote.value = 'USDT';
    const priceTo = document.getElementById('price-convert-to-asset') as HTMLSelectElement;
    if (priceTo) priceTo.selectedIndex = 0;
    const priceAllRadio = document.querySelector('input[name="price-amount-mode"][value="all"]') as HTMLInputElement;
    if (priceAllRadio) priceAllRadio.checked = true;
    const priceAmount = document.getElementById('price-amount-value') as HTMLInputElement;
    if (priceAmount) priceAmount.value = '';
    const priceUnlimited = document.getElementById('price-unlimited') as HTMLInputElement;
    if (priceUnlimited) priceUnlimited.checked = true;
    const priceMax = document.getElementById('price-max-executions') as HTMLInputElement;
    if (priceMax) {
      priceMax.value = '';
      priceMax.disabled = true;
    }

    this.onTriggerTypeChanged();
    this.resetDependentFields();
  }

  // ─── Create Automation wizard ──────────────────────────────────────────────

  private openCreateModal(template?: string): void {
    if (!this.selectedConnectionId) {
      this.showError('Select an exchange first, then create an automation.');
      return;
    }

    this.clearForm();
    document.getElementById('create-rule-error')?.classList.add('d-none');

    // Apply a starter template, if one was chosen from the empty state.
    const triggerSel = document.getElementById('trigger-type') as HTMLSelectElement;
    const actionSel  = document.getElementById('action-type') as HTMLSelectElement;
    if (template === 'take_profit') {
      triggerSel.value = 'price_threshold';
      this.onTriggerTypeChanged();
    } else if (template === 'convert_balance') {
      triggerSel.value = 'balance_threshold';
      this.onTriggerTypeChanged();
      if (actionSel) { actionSel.value = 'convert_crypto'; this.onActionTypeChanged(); }
    } else if (template === 'auto_withdraw') {
      triggerSel.value = 'order_filled';
      this.onTriggerTypeChanged();
      if (actionSel) { actionSel.value = 'withdraw_crypto'; this.onActionTypeChanged(); }
    }

    this.setWizardStep(1);
    document.getElementById('create-rule-overlay')?.classList.remove('d-none');
  }

  private closeCreateModal(): void {
    document.getElementById('create-rule-overlay')?.classList.add('d-none');
  }

  private setWizardStep(step: 1 | 2 | 3): void {
    this.wizardStep = step;
    document.getElementById('create-rule-error')?.classList.add('d-none');

    const stepIds: Record<number, string> = {
      1: 'wizard-step-when', 2: 'wizard-step-then', 3: 'wizard-step-review',
    };
    Object.entries(stepIds).forEach(([n, id]) => {
      document.getElementById(id)?.classList.toggle('d-none', Number(n) !== step);
    });

    document.querySelectorAll('.wizard-dot').forEach(dot => {
      const dStep = Number(dot.getAttribute('data-step'));
      dot.classList.toggle('active', dStep === step);
      dot.classList.toggle('done', dStep < step);
    });

    const labels: Record<number, string> = {
      1: 'Step 1 of 3 · When this happens',
      2: 'Step 2 of 3 · Then do this',
      3: 'Step 3 of 3 · Review & name',
    };
    const lbl = document.getElementById('wizard-step-label');
    if (lbl) lbl.textContent = labels[step];

    document.getElementById('wizard-back')?.classList.toggle('d-none', step === 1);
    document.getElementById('wizard-next')?.classList.toggle('d-none', step === 3);
    document.getElementById('create-rule-btn')?.classList.toggle('d-none', step !== 3);

    if (step === 3) this.updateRuleSummary();
  }

  private wizardNext(): void {
    if (this.wizardStep === 1 && !this.validateWizardStep1()) return;
    if (this.wizardStep === 2 && !this.validateWizardStep2()) return;
    if (this.wizardStep < 3) this.setWizardStep((this.wizardStep + 1) as 1 | 2 | 3);
  }

  private validateWizardStep1(): boolean {
    const t = (document.getElementById('trigger-type') as HTMLSelectElement).value;
    if (t === 'order_filled') {
      const v = (document.getElementById('trigger-order-id') as HTMLSelectElement).value;
      if (!v) { this.showError('Pick an order that should trigger this automation.'); return false; }
    } else if (t === 'balance_threshold') {
      const a = (document.getElementById('trigger-asset') as HTMLSelectElement).value;
      const th = (document.getElementById('trigger-threshold') as HTMLInputElement).value.trim();
      if (!a || !th) { this.showError('Choose an asset to monitor and a threshold amount.'); return false; }
    } else if (t === 'price_threshold') {
      const a = (document.getElementById('price-trigger-asset') as HTMLSelectElement).value;
      const th = (document.getElementById('price-trigger-threshold') as HTMLInputElement).value.trim();
      if (!a || !th) { this.showError('Choose a coin to monitor and a trigger price.'); return false; }
    }
    return true;
  }

  private validateWizardStep2(): boolean {
    const t = (document.getElementById('trigger-type') as HTMLSelectElement).value;
    if (t === 'price_threshold') {
      const to = (document.getElementById('price-convert-to-asset') as HTMLSelectElement).value;
      if (!to) { this.showError('Choose what to convert into.'); return false; }
      return true;
    }
    const action = (document.getElementById('action-type') as HTMLSelectElement).value;
    if (action === 'withdraw_crypto') {
      const asset = (document.getElementById('action-asset') as HTMLSelectElement).value;
      const addr  = (document.getElementById('action-address-key') as HTMLSelectElement).value;
      if (!asset || !addr) { this.showError('Choose the asset and withdrawal address.'); return false; }
    } else {
      const to = (document.getElementById('convert-to-asset') as HTMLSelectElement).value;
      if (!to) { this.showError('Choose the asset to convert into.'); return false; }
    }
    return true;
  }

  private applyTabView(): void {
    const views: Record<string, string> = {
      table: 'rules-table-view', flow: 'rules-flow-view', log: 'rules-log-view',
    };
    Object.entries(views).forEach(([mode, id]) => {
      document.getElementById(id)?.classList.toggle('d-none', mode !== this.rulesViewMode);
    });
  }

  private updateEmptyState(count: number): void {
    const isEmpty = count === 0;
    document.getElementById('rules-empty-state')?.classList.toggle('d-none', !isEmpty);
    document.getElementById('rules-tab-strip')?.classList.toggle('d-none', isEmpty);
    if (isEmpty) {
      ['rules-table-view', 'rules-flow-view', 'rules-log-view'].forEach(id =>
        document.getElementById(id)?.classList.add('d-none'));
    } else {
      this.applyTabView();
    }
  }

  private showError(message: string): void {
    // When the create wizard is open it covers the page, so surface errors
    // inside the modal instead of on the (hidden) page banner.
    const createOverlay = document.getElementById('create-rule-overlay');
    if (createOverlay && !createOverlay.classList.contains('d-none')) {
      const inline = document.getElementById('create-rule-error');
      if (inline) {
        inline.textContent = message;
        inline.classList.remove('d-none');
        return;
      }
    }
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

  // ─── Rule Flow ─────────────────────────────────────────────────────────────

  private renderRuleFlow(rules: any[]): void {
    const chart = document.getElementById('rules-flow-chart');
    if (!chart) return;
    RuleFlow.render(chart, rules, { exchangeName: (id) => ExchangeStore.getExchangeName(id) });
  }

  // ──────────────────────────────────────────────────────────────────────────

  // ─── Edit Rule Modal ──────────────────────────────────────────────────

  private async openEditModal(rule: any): Promise<void> {
    // Populate hidden id
    (document.getElementById('edit-rule-id') as HTMLInputElement).value = String(rule.id);

    // Rule name
    (document.getElementById('edit-rule-name') as HTMLInputElement).value = rule.rule_name || '';

    // Execution limit
    const unlimitedCb = document.getElementById('edit-unlimited') as HTMLInputElement;
    const maxExecInput = document.getElementById('edit-max-executions') as HTMLInputElement;
    if (rule.max_executions == null) {
      unlimitedCb.checked = true;
      maxExecInput.disabled = true;
      maxExecInput.value = '';
    } else {
      unlimitedCb.checked = false;
      maxExecInput.disabled = false;
      maxExecInput.value = String(rule.max_executions);
    }

    // Hide all conditional rows first
    ['edit-threshold-row', 'edit-quote-row', 'edit-price-amount-row', 'edit-cooldown-row',
     'edit-address-row', 'edit-order-amount-row', 'edit-convert-row'].forEach(id => {
      document.getElementById(id)?.classList.add('d-none');
    });

    // Trigger-type-specific fields
    if (rule.trigger_type === 'balance_threshold' || rule.trigger_type === 'price_threshold') {
      // Threshold
      const threshRow = document.getElementById('edit-threshold-row');
      const threshLabel = document.getElementById('edit-threshold-label');
      const threshInput = document.getElementById('edit-trigger-threshold') as HTMLInputElement;
      threshRow?.classList.remove('d-none');
      threshLabel!.textContent = rule.trigger_type === 'price_threshold' ? 'Trigger Price' : 'Threshold Amount';
      threshInput.value = rule.trigger_threshold || '';

      // Cooldown
      document.getElementById('edit-cooldown-row')?.classList.remove('d-none');
      const cooldownMins = Number(rule.cooldown_minutes || 1440);
      (document.getElementById('edit-cooldown-hours') as HTMLInputElement).value = String(Math.floor(cooldownMins / 60));
      (document.getElementById('edit-cooldown-minutes') as HTMLInputElement).value = String(cooldownMins % 60);
    }

    if (rule.trigger_type === 'price_threshold') {
      // Quote currency
      document.getElementById('edit-quote-row')?.classList.remove('d-none');
      const quoteSelect = document.getElementById('edit-price-quote-asset') as HTMLSelectElement;
      quoteSelect.value = rule.trigger_price_quote_asset || 'USDT';

      // Amount mode
      document.getElementById('edit-price-amount-row')?.classList.remove('d-none');
      const mode = rule.action_amount_mode || 'all';
      const modeRadio = document.querySelector(`input[name="edit-price-amount-mode"][value="${mode}"]`) as HTMLInputElement | null;
      if (modeRadio) modeRadio.checked = true;
      const priceAmtInput = document.getElementById('edit-price-amount-value') as HTMLInputElement;
      priceAmtInput.disabled = (mode === 'all');
      priceAmtInput.value = (mode !== 'all' && rule.action_amount) ? String(rule.action_amount) : '';
    }

    // Subtitle (set before action-type branching so withdraw rules get it too)
    const triggerLabel: Record<string, string> = {
      order_filled: 'Order Filled',
      balance_threshold: 'Balance Threshold',
      price_threshold: 'Price Threshold'
    };
    const actionLabel: Record<string, string> = {
      withdraw_crypto: 'Withdraw',
      convert_crypto: 'Convert'
    };
    const subtitle = document.getElementById('edit-rule-modal-subtitle');
    if (subtitle) {
      subtitle.textContent = `${triggerLabel[rule.trigger_type] || rule.trigger_type} → ${actionLabel[rule.action_type] || rule.action_type}`;
    }

    // Action-type-specific fields
    if (rule.action_type === 'withdraw_crypto') {
      // Address key — show row immediately with loading state, fetch addresses async
      document.getElementById('edit-address-row')?.classList.remove('d-none');
      const addrSelect = document.getElementById('edit-action-address-key') as HTMLSelectElement;
      addrSelect.innerHTML = '<option value="" disabled selected>Loading addresses...</option>';
      addrSelect.disabled = true;

      // Show modal now so the user sees it while addresses load
      document.getElementById('edit-rule-error')?.classList.add('d-none');
      document.getElementById('edit-rule-overlay')?.classList.remove('d-none');
      (document.getElementById('edit-rule-name') as HTMLInputElement).focus();

      try {
        const connectionId = rule.action_exchange_id || this.selectedConnectionId;
        const addresses: any[] = connectionId
          ? await ExchangeController.getWithdrawalAddresses(connectionId)
          : [];

        addrSelect.innerHTML = '';
        if (addresses.length === 0) {
          const opt = document.createElement('option');
          opt.value = ''; opt.disabled = true; opt.selected = true;
          opt.textContent = 'No withdrawal addresses available';
          addrSelect.appendChild(opt);
          addrSelect.disabled = true;
        } else {
          addrSelect.disabled = false;
          const placeholder = document.createElement('option');
          placeholder.value = ''; placeholder.disabled = true; placeholder.selected = true;
          placeholder.textContent = 'Select an address...';
          addrSelect.appendChild(placeholder);
          const sorted = [...addresses].sort((a: any, b: any) => a.nickname_key.localeCompare(b.nickname_key));
          for (const addr of sorted) {
            const opt = document.createElement('option');
            opt.value = addr.nickname_key;
            opt.textContent = `${addr.nickname_key} (${addr.asset} - ${addr.method})`;
            addrSelect.appendChild(opt);
          }
          if (rule.action_address_key) {
            const target = String(rule.action_address_key).trim().toLowerCase();
            for (let i = 0; i < addrSelect.options.length; i++) {
              if (addrSelect.options[i].value.trim().toLowerCase() === target) {
                addrSelect.selectedIndex = i;
                break;
              }
            }
          }
        }
      } catch {
        addrSelect.innerHTML = '<option value="" disabled selected>Failed to load addresses</option>';
        addrSelect.disabled = true;
      }

      // order_filled: amount mode
      if (rule.trigger_type === 'order_filled') {
        document.getElementById('edit-order-amount-row')?.classList.remove('d-none');
        const useFilled = Boolean(rule.use_filled_amount);
        const modeRadio = document.querySelector(
          `input[name="edit-amount-mode"][value="${useFilled ? 'filled' : 'fixed'}"]`
        ) as HTMLInputElement | null;
        if (modeRadio) modeRadio.checked = true;
        const amtInput = document.getElementById('edit-action-amount') as HTMLInputElement;
        amtInput.disabled = useFilled;
        amtInput.value = (!useFilled && rule.action_amount) ? String(rule.action_amount) : '';
      }

      // Return early — modal already shown above
      return;
    }

    if (rule.action_type === 'convert_crypto' && rule.trigger_type === 'balance_threshold') {
      document.getElementById('edit-convert-row')?.classList.remove('d-none');
      (document.getElementById('edit-convert-to-asset') as HTMLInputElement).value = rule.convert_to_asset || '';
      (document.getElementById('edit-convert-amount') as HTMLInputElement).value = rule.action_amount || '';
    }

    // Clear error, show modal
    const errEl = document.getElementById('edit-rule-error');
    if (errEl) { errEl.textContent = ''; errEl.classList.add('d-none'); }
    document.getElementById('edit-rule-overlay')?.classList.remove('d-none');
    (document.getElementById('edit-rule-name') as HTMLInputElement).focus();
  }

  private closeEditModal(): void {
    document.getElementById('edit-rule-overlay')?.classList.add('d-none');
    const errEl = document.getElementById('edit-rule-error');
    if (errEl) { errEl.textContent = ''; errEl.classList.add('d-none'); }
  }

  private async saveEditModal(): Promise<void> {
    const ruleId = parseInt((document.getElementById('edit-rule-id') as HTMLInputElement).value || '0', 10);
    if (!ruleId) return;

    const rule = this.allRules.find((r: any) => r.id === ruleId);
    if (!rule) return;

    const showModalError = (msg: string) => {
      const errEl = document.getElementById('edit-rule-error');
      if (errEl) { errEl.textContent = msg; errEl.classList.remove('d-none'); }
    };

    // Validate + build payload
    const payload: Record<string, any> = {};

    const ruleName = (document.getElementById('edit-rule-name') as HTMLInputElement).value.trim();
    if (!ruleName) { showModalError('Rule name cannot be empty.'); return; }
    payload.rule_name = ruleName;

    const isUnlimited = (document.getElementById('edit-unlimited') as HTMLInputElement).checked;
    if (isUnlimited) {
      payload.max_executions = null;
    } else {
      const maxVal = (document.getElementById('edit-max-executions') as HTMLInputElement).value.trim();
      if (!maxVal) { showModalError('Enter a max execution count or check Unlimited.'); return; }
      const maxNum = parseInt(maxVal, 10);
      if (isNaN(maxNum) || maxNum < 1) { showModalError('Max executions must be at least 1.'); return; }
      payload.max_executions = maxNum;
    }

    if (rule.trigger_type === 'balance_threshold' || rule.trigger_type === 'price_threshold') {
      const thresh = (document.getElementById('edit-trigger-threshold') as HTMLInputElement).value.trim();
      if (!thresh) { showModalError('Threshold cannot be empty.'); return; }
      const threshNum = parseFloat(thresh);
      if (isNaN(threshNum) || threshNum <= 0) { showModalError('Threshold must be a positive number.'); return; }
      payload.trigger_threshold = thresh;

      const hours = parseInt((document.getElementById('edit-cooldown-hours') as HTMLInputElement).value || '0', 10) || 0;
      const mins  = parseInt((document.getElementById('edit-cooldown-minutes') as HTMLInputElement).value || '0', 10) || 0;
      const totalMins = hours * 60 + mins;
      if (totalMins < 1) { showModalError('Cooldown must be at least 1 minute.'); return; }
      payload.cooldown_minutes = totalMins;
    }

    if (rule.trigger_type === 'price_threshold') {
      payload.trigger_price_quote_asset = (document.getElementById('edit-price-quote-asset') as HTMLSelectElement).value;
      const priceMode = (document.querySelector('input[name="edit-price-amount-mode"]:checked') as HTMLInputElement)?.value || 'all';
      payload.action_amount_mode = priceMode;
      if (priceMode !== 'all') {
        const priceAmt = (document.getElementById('edit-price-amount-value') as HTMLInputElement).value.trim();
        if (!priceAmt) { showModalError('Amount is required for percent/fixed mode.'); return; }
        const priceAmtNum = parseFloat(priceAmt);
        if (isNaN(priceAmtNum) || priceAmtNum <= 0) { showModalError('Amount must be a positive number.'); return; }
        if (priceMode === 'percent' && priceAmtNum > 100) { showModalError('Percent must be between 1 and 100.'); return; }
        payload.action_amount = priceAmt;
      } else {
        payload.action_amount = '';
      }
    }

    if (rule.action_type === 'withdraw_crypto') {
      const addrSelect = document.getElementById('edit-action-address-key') as HTMLSelectElement;
      if (addrSelect.value) payload.action_address_key = addrSelect.value;

      if (rule.trigger_type === 'order_filled') {
        const amtMode = (document.querySelector('input[name="edit-amount-mode"]:checked') as HTMLInputElement)?.value || 'fixed';
        payload.use_filled_amount = (amtMode === 'filled');
        if (amtMode === 'fixed') {
          const amt = (document.getElementById('edit-action-amount') as HTMLInputElement).value.trim();
          if (!amt) { showModalError('Amount is required for fixed amount mode.'); return; }
          const amtNum = parseFloat(amt);
          if (isNaN(amtNum) || amtNum <= 0) { showModalError('Amount must be a positive number.'); return; }
          payload.action_amount = amt;
        }
      }
    }

    if (rule.action_type === 'convert_crypto' && rule.trigger_type === 'balance_threshold') {
      const target = (document.getElementById('edit-convert-to-asset') as HTMLInputElement).value.trim().toUpperCase();
      if (!target) { showModalError('Target asset cannot be empty.'); return; }
      if (target === (rule.action_asset || '').toUpperCase()) { showModalError('Source and target assets must be different.'); return; }
      payload.convert_to_asset = target;
      const convertAmt = (document.getElementById('edit-convert-amount') as HTMLInputElement).value.trim();
      payload.action_amount = convertAmt;
    }

    const saveBtn = document.getElementById('edit-rule-save') as HTMLButtonElement;
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
    try {
      await AutomationController.updateRule(ruleId, payload);
      this.closeEditModal();
      await this.loadRules();
    } catch (error: any) {
      showModalError(error.message || 'Failed to save rule.');
    } finally {
      saveBtn.disabled = false;
      saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Changes';
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

    const exchangeName = this.selectedConnectionId
      ? ExchangeStore.getExchangeName(this.selectedConnectionId)
      : null;
    const exchangePrefix = exchangeName ? `${exchangeName} ` : '';

    if (triggerType === 'price_threshold') {
      const asset = (document.getElementById('price-trigger-asset') as HTMLSelectElement)?.value;
      const triggerPrice = (document.getElementById('price-trigger-threshold') as HTMLInputElement)?.value;
      const quote = (document.getElementById('price-quote-asset') as HTMLSelectElement)?.value || 'USDT';
      const target = (document.getElementById('price-convert-to-asset') as HTMLSelectElement)?.value;
      const mode = (document.querySelector('input[name="price-amount-mode"]:checked') as HTMLInputElement)?.value || 'all';
      const amount = (document.getElementById('price-amount-value') as HTMLInputElement)?.value;
      const unlimited = (document.getElementById('price-unlimited') as HTMLInputElement)?.checked ?? true;
      const maxExec = (document.getElementById('price-max-executions') as HTMLInputElement)?.value;
      const cooldownHours = parseInt((document.getElementById('cooldown-hours') as HTMLInputElement)?.value || '0', 10);
      const cooldownMins = parseInt((document.getElementById('cooldown-minutes') as HTMLInputElement)?.value || '0', 10);
      const totalCooldown = (cooldownHours * 60) + cooldownMins;

      if (!asset || !triggerPrice || !target) {
        summaryContainer.classList.add('d-none');
        return;
      }

      const amountDisplay = mode === 'all'
        ? `sell all ${asset}`
        : mode === 'percent'
          ? `convert ${amount || '___'}% of ${asset}`
          : `convert ${amount || '___'} ${asset}`;
      const maxDisplay = unlimited ? 'unlimited times' : `${maxExec || '___'} times`;
      const cooldownDisplay = this.formatCooldown(totalCooldown);

      summary = `${exchangePrefix}When ${asset}/${quote} hits ${parseFloat(triggerPrice).toFixed(8).replace(/\.?0+$/, '')}, ${amountDisplay} to ${target}, then wait ${cooldownDisplay} between runs, up to ${maxDisplay}`;
    } else if (triggerType === 'balance_threshold') {
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
        summary = `${exchangePrefix}When ${assetDisplay} balance reaches ${parseFloat(threshold).toFixed(8).replace(/\.?0+$/, '')}, wait ${cooldownDisplay}, then convert ${convertAmountDisplay} to ${convertTo}`;
      } else {
        summary = `${exchangePrefix}When ${assetDisplay} balance reaches ${parseFloat(threshold).toFixed(8).replace(/\.?0+$/, '')}, wait ${cooldownDisplay}, then withdraw full balance to ${addressKey}`;
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
        summary = `${exchangePrefix}When order ${orderIdShort} fills, withdraw filled amount of ${assetDisplay} to ${addressKey}`;
      } else {
        let amountDisplay = '___';
        if (amount && parseFloat(amount) > 0) {
          amountDisplay = parseFloat(amount).toFixed(8).replace(/\.?0+$/, '');
        }
        summary = `${exchangePrefix}When order ${orderIdShort} fills, withdraw ${amountDisplay} ${assetDisplay} to ${addressKey}`;
      }
    }

    summaryText.textContent = summary;
    summaryContainer.classList.remove('d-none');
  }
}

new CommandsController();

})();
