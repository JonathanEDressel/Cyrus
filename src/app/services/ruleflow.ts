/**
 * RuleFlow — automations drawn as a left-to-right flow map.
 *
 * Columns read left to right: the coins that send money; a chip per rule
 * (what sets it off and how much it moves); any coin the money passes through
 * on the way; and where it ends up — a coin, or a withdrawal address. Every
 * rule is its own chip and its own line, coloured by what triggers it, and
 * paused rules are dashed. Clicking a chip lights up that rule's path and
 * shows it in plain English underneath, with Edit and Pause/Resume when the
 * page hosting the chart offers them.
 *
 * The layout, selection and details strip are FlowMap's (services/flowmap.ts),
 * shared with the Open Orders chart; this file turns rules into its items.
 *
 * Used by the Automations page (Flow tab) and the Overview page's Flow widget.
 */
const RuleFlow = (() => {
  type TrigKind = 'price' | 'balance' | 'order' | 'alloc';

  interface RenderOpts {
    exchangeName?: (id: any) => string;
    /** Opens the editor for a rule. Shows an Edit button in the details strip. */
    onEditRule?: (rule: any) => void;
    /** Older name for onEditRule. */
    onSelectRule?: (rule: any) => void;
    /** Pauses or resumes a rule. Shows a Pause/Resume button. */
    onToggleRule?: (rule: any) => void;
    /** Overrides the Edit button's label (e.g. "Open in Automations"). */
    editLabel?: string;
  }

  const KIND_LABEL: Record<TrigKind, string> = {
    price: 'Price target', balance: 'Balance builds up', order: 'Order fills', alloc: 'Allocation cap',
  };
  const KIND_SHORT: Record<TrigKind, string> = { price: 'PRICE', balance: 'BAL', order: 'FILL', alloc: 'CAP' };

  function esc(str: any): string {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  }
  function escAttr(str: any): string {
    return esc(str).replace(/"/g, '&quot;');
  }

  function sourceAsset(rule: any): string | null {
    if (rule.trigger_type === 'balance_threshold' || rule.trigger_type === 'price_threshold'
        || rule.trigger_type === 'allocation_threshold') {
      return (rule.trigger_asset || rule.action_asset || '').toUpperCase() || null;
    }
    return (rule.action_asset || '').toUpperCase() || null; // order_filled
  }

  function destInfo(rule: any): { key: string; label: string; kind: 'asset' | 'wallet' } | null {
    if (rule.action_type === 'convert_crypto') {
      const a = (rule.convert_to_asset || '').toUpperCase();
      return a ? { key: 'A:' + a, label: a, kind: 'asset' } : null;
    }
    if (rule.action_type === 'withdraw_crypto') {
      const w = rule.action_address_key || 'wallet';
      return { key: 'W:' + w, label: w, kind: 'wallet' };
    }
    return null;
  }

  function kindOf(rule: any): TrigKind {
    switch (rule.trigger_type) {
      case 'price_threshold': return 'price';
      case 'balance_threshold': return 'balance';
      case 'allocation_threshold': return 'alloc';
      default: return 'order';
    }
  }

  function amountText(rule: any): string {
    if (rule.trigger_type === 'allocation_threshold') {
      return `the excess above ${rule.rebalance_target_percent ?? '?'}% of`;
    }
    if (rule.action_type === 'withdraw_crypto') {
      if (rule.trigger_type === 'balance_threshold') return 'the full balance of';
      if (rule.use_filled_amount) return 'the filled amount of';
      return rule.action_amount ? `${rule.action_amount}` : 'the full balance of';
    }
    const mode = (rule.action_amount_mode || 'all').toLowerCase();
    if (mode === 'percent') return `${rule.action_amount}% of`;
    if (mode === 'fixed') return `${rule.action_amount}`;
    return 'all';
  }

  /** A plain-English sentence describing what a single rule does. */
  function describeRule(rule: any, markPaused = true): string {
    const src = sourceAsset(rule) || rule.action_asset || 'funds';

    let trig: string;
    if (rule.trigger_type === 'price_threshold') {
      const quote = rule.trigger_price_quote_asset || 'USDT';
      trig = `When ${rule.trigger_asset || src} hits ${rule.trigger_threshold ?? '?'} ${quote}`;
    } else if (rule.trigger_type === 'balance_threshold') {
      const a = rule.trigger_asset || src;
      trig = `When your ${a} balance reaches ${rule.trigger_threshold ?? '?'} ${a}`;
    } else if (rule.trigger_type === 'allocation_threshold') {
      trig = `When ${src} grows past ${rule.trigger_allocation_percent ?? '?'}% of your portfolio`;
    } else {
      const oid = rule.trigger_order_id ? `order ${String(rule.trigger_order_id).slice(0, 8)}…` : 'an order';
      trig = `When ${oid} fills`;
    }

    let act: string;
    if (rule.action_type === 'convert_crypto') {
      act = `convert ${amountText(rule)} ${src} into ${rule.convert_to_asset || '?'}`;
    } else {
      act = `withdraw ${amountText(rule)} ${rule.action_asset || src} to ${rule.action_address_key || 'your wallet'}`;
    }

    let sentence = `${trig}, ${act}.`;
    if (markPaused && !rule.is_active) sentence += ' (paused)';
    return sentence;
  }

  /** "12,345.6" without trailing zeros, for chip labels. */
  function num(v: any): string {
    const n = Number(v);
    if (!isFinite(n)) return String(v ?? '?');
    return n.toLocaleString(undefined, { maximumFractionDigits: n >= 1 ? 2 : 8 });
  }

  /** The short text on a rule's chip: the condition, then how much it moves. */
  function chipText(rule: any): string {
    const kind = kindOf(rule);
    const asset = sourceAsset(rule) || '';
    let cond: string;
    if (kind === 'price') {
      const quote = (rule.trigger_price_quote_asset || 'USDT').toUpperCase();
      cond = /^(USD|USDC|USDT|GUSD)$/.test(quote)
        ? `≥ $${num(rule.trigger_threshold)}` : `≥ ${num(rule.trigger_threshold)} ${quote}`;
    } else if (kind === 'balance') {
      cond = `≥ ${num(rule.trigger_threshold)} ${asset}`;
    } else if (kind === 'alloc') {
      return `over ${rule.trigger_allocation_percent ?? '?'}% → ${rule.rebalance_target_percent ?? '?'}%`;
    } else {
      cond = rule.trigger_order_id ? `order ${String(rule.trigger_order_id).slice(0, 6)} fills` : 'order fills';
    }
    let amt = '';
    if (rule.action_type === 'withdraw_crypto') {
      amt = rule.use_filled_amount ? 'filled amt' : (rule.action_amount ? `${num(rule.action_amount)} ${asset}` : 'all');
    } else {
      const mode = (rule.action_amount_mode || 'all').toLowerCase();
      amt = mode === 'percent' ? `${rule.action_amount}%` : mode === 'fixed' ? `${num(rule.action_amount)} ${asset}` : 'all';
    }
    return kind === 'order' ? cond : `${cond} · ${amt}`;
  }

  function relTime(iso: string | null | undefined): string {
    if (!iso) return 'never';
    const t = new Date(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z').getTime();
    if (!isFinite(t)) return 'never';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400 * 2) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }

  function runsText(rule: any): string {
    const n = Number(rule.trigger_count || 0);
    if (rule.max_executions != null) return `${Number(rule.execution_count || 0)} of ${rule.max_executions} runs`;
    if (n === 0) return 'not run yet';
    return n === 1 ? '1 run' : `${n} runs`;
  }

  // ── Render ──────────────────────────────────────────────────────────────

  function detailHtml(rule: any, opts: RenderOpts, ctx: { multiGroup: boolean; groupName: string }): string {
    const kind = kindOf(rule);
    const paused = !rule.is_active;
    const canEdit = !!(opts.onEditRule || opts.onSelectRule);
    const editLabel = opts.editLabel
      || (rule.trigger_type === 'allocation_threshold' ? 'Edit on Balancer' : 'Edit');
    const exName = ctx.multiGroup ? ctx.groupName : '';
    return `
      <span class="rf-detail-kind rf-k-${kind}">${esc(KIND_LABEL[kind])}</span>
      <div class="rf-detail-text">
        <strong>${esc(rule.rule_name || `Rule ${rule.id}`)}${exName ? ` <span class="rf-detail-ex">· ${esc(exName)}</span>` : ''}</strong>
        <span>${esc(describeRule(rule, false))}</span>
      </div>
      <span class="rf-detail-meta">${paused ? 'Paused' : 'Active'} · ${esc(runsText(rule))}${rule.last_triggered_at ? ` · last ${esc(relTime(rule.last_triggered_at))}` : ''}</span>
      <div class="rf-detail-actions">
        ${canEdit ? `<button type="button" class="btn-secondary" data-rf-action="edit">${esc(editLabel)}</button>` : ''}
        ${opts.onToggleRule ? `<button type="button" class="btn-secondary" data-rf-action="toggle">${paused ? 'Resume' : 'Pause'}</button>` : ''}
      </div>`;
  }

  function render(container: HTMLElement, rules: any[], opts: RenderOpts = {}): void {
    if (!container) return;
    // The old circle chart's hover tooltip lived on <body>; drop it if present.
    document.getElementById('rf-tooltip')?.remove();

    const items: FlowItem[] = [];
    (rules || []).forEach((r, i) => {
      const ex = r.trigger_exchange_id ?? r.action_exchange_id ?? null;
      const src = sourceAsset(r);
      const dest = destInfo(r);
      if (ex == null || !src || !dest) return;
      const kind = kindOf(r);
      const paused = !r.is_active;
      const name = r.rule_name || `Rule ${r.id}`;
      items.push({
        id: String(r.id ?? `i${i}`),
        group: String(ex),
        src: { key: 'A:' + src, label: src, kind: 'asset' },
        dst: dest,
        tone: kind,
        dashed: paused,
        chipTag: paused ? 'PAUSED' : KIND_SHORT[kind],
        chipText: chipText(r),
        title: `${name}${paused ? ' (paused)' : ''}\n${describeRule(r, false)}`,
        data: r,
      });
    });

    FlowMap.render(container, items, {
      emptyText: 'No automations to chart yet.',
      noun: ['rule', 'rules'],
      groupName: (g) => opts.exchangeName?.(isNaN(Number(g)) ? g : Number(g)) || `Exchange ${g}`,
      detailHtml: (item, ctx) => detailHtml(item.data, opts, ctx),
      onAction: (action, item) => {
        if (action === 'edit') (opts.onEditRule || opts.onSelectRule)?.(item.data);
        if (action === 'toggle') opts.onToggleRule?.(item.data);
      },
    });
  }

  return { render, describeRule };
})();
