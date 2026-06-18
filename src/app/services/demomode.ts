/**
 * DemoMode — a hidden "show me dummy data" switch for screenshots / demos.
 *
 * Triggered by Ctrl+Shift+double-left-click on the sidebar logo (wired at the
 * bottom of this file). When enabled, the data-source methods that feed every
 * page are swapped for versions that return ONE internally-consistent fake
 * dataset, so the numbers line up across the whole app:
 *
 *   • Two connected exchanges (Kraken + Coinbase) …
 *   • whose balances == the portfolio doughnut on the Overview …
 *   • whose open orders match the order-flow chart …
 *   • whose automations reference those same orders/assets/wallets …
 *   • whose execution log entries reference those same automations …
 *   • whose watchlist + live charts track those same assets.
 *
 * Toggling again restores the real methods. The on/off state is persisted in
 * localStorage and re-applied as soon as this script loads, so the demo
 * survives page navigation and full reloads. The original (live) backend is
 * never touched while the demo is on — only the in-memory data source.
 */

// ---------------------------------------------------------------------------
// The dataset
// ---------------------------------------------------------------------------

const DemoData = (() => {
  // Use high connection IDs so they never collide with a real connection.
  const KRAKEN = 9001;
  const COINBASE = 9002;

  // Reference USD prices, keyed by base asset. Everything else (portfolio
  // values, order fills, log amounts, chart levels) is derived from these so
  // the story stays consistent.
  const PRICE: Record<string, number> = {
    BTC: 67200,
    ETH: 3480,
    SOL: 152,
    ADA: 0.46,
    LINK: 14.2,
    XRP: 0.53,
    DOGE: 0.16,
    AVAX: 38,
    DOT: 7.2,
    LTC: 84,
    MATIC: 0.72,
    ATOM: 9.4,
    UNI: 11.5,
    USDC: 1,
    USDT: 1,
  };

  // Holdings per connection (asset -> amount). These ARE the balances and the
  // portfolio at the same time.
  const HOLDINGS: Record<number, Record<string, number>> = {
    [KRAKEN]: { BTC: 0.6, ETH: 5, SOL: 80, ADA: 4000, USDC: 6000, DOT: 300, LINK: 250, AVAX: 120, ATOM: 400 },
    [COINBASE]: { BTC: 0.25, ETH: 3, LINK: 400, XRP: 5000, USDT: 2500, MATIC: 8000, DOGE: 30000, LTC: 40, UNI: 350 },
  };

  /** A timestamp `offsetMs` in the past, ISO without the trailing `Z`
   *  (matches the backend's naming — the views append `Z` themselves). */
  function ago(offsetMs: number): string {
    return new Date(Date.now() - offsetMs).toISOString().slice(0, 19);
  }

  const MIN = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;

  // ── Exchanges ────────────────────────────────────────────────────────────

  function connections(): ExchangeConnection[] {
    return [
      {
        id: KRAKEN,
        exchange_name: 'kraken',
        label: 'Default',
        is_validated: true,
        is_sandbox: false,
        keys_last_validated: ago(12 * MIN),
        created_at: ago(90 * DAY),
      },
      {
        id: COINBASE,
        exchange_name: 'coinbase',
        label: 'Default',
        is_validated: true,
        is_sandbox: false,
        keys_last_validated: ago(31 * MIN),
        created_at: ago(60 * DAY),
      },
    ];
  }

  function supportedExchanges(): any[] {
    return [
      {
        id: 'kraken',
        name: 'Kraken',
        requires_passphrase: false,
        has_withdrawal_addresses: true,
        supports_withdraw: true,
        has_sandbox: false,
        website: 'https://www.kraken.com',
        api_key_url: 'https://www.kraken.com/u/security/api',
        guide_url: 'https://support.kraken.com/articles/360000919966-how-to-create-an-api-key',
      },
      {
        id: 'coinbase',
        name: 'Coinbase Advanced (Beta)',
        requires_passphrase: false,
        has_withdrawal_addresses: false,
        supports_withdraw: false,
        has_sandbox: false,
        website: 'https://www.coinbase.com',
        api_key_url: 'https://www.coinbase.com/settings/api',
        guide_url: 'https://docs.cdp.coinbase.com/exchange/introduction/rest-quickstart',
      },
    ];
  }

  // ── Balances + portfolio (same underlying holdings) ───────────────────────

  function balance(connId: number): Record<string, string> {
    const held = HOLDINGS[connId] || {};
    const out: Record<string, string> = {};
    for (const [asset, amount] of Object.entries(held)) {
      out[asset] = amount.toFixed(8);
    }
    return out;
  }

  function portfolio(connId: number): { positions: Array<{ asset: string; amount: number; usd_value: number }>; total_usd: number } {
    const held = HOLDINGS[connId] || {};
    let total = 0;
    const positions = Object.entries(held).map(([asset, amount]) => {
      const usd_value = amount * (PRICE[asset] ?? 0);
      total += usd_value;
      return { asset, amount, usd_value };
    });
    positions.sort((a, b) => b.usd_value - a.usd_value);
    return { positions, total_usd: total };
  }

  // ── Open orders ────────────────────────────────────────────────────────────

  function ord(id: string, pair: string, side: 'buy' | 'sell', price: number, volume: number, filled: number, hoursAgo: number): any {
    return {
      id,
      pair,
      side,
      type: 'limit',
      price: price.toString(),
      volume: volume.toFixed(8),
      filled: filled.toFixed(8),
      status: 'open',
      opentm: Date.now() - hoursAgo * HOUR,
    };
  }

  // 25 open orders across the two exchanges. A handful of IDs are referenced by
  // the order-filled automations below, so those stay in sync.
  const ORDERS: Record<number, any[]> = {
    [KRAKEN]: [
      ord('OQ4F7K-T2A9P-ETHB01', 'ETH/USD', 'buy', 3300, 1.5, 0, 3),
      ord('OB7N2C-V5K8D-SOLS02', 'SOL/USD', 'sell', 165, 30, 8, 26),
      ord('OZ8L2M-R5C7N-BTCB03', 'BTC/USD', 'buy', 63000, 0.2, 0, 5),
      ord('OD3P9Q-X1F4G-ADAS04', 'ADA/USD', 'sell', 0.52, 2000, 500, 14),
      ord('OK6R1S-Y7H2J-DOTB05', 'DOT/USD', 'buy', 6.5, 200, 0, 9),
      ord('OL2T8U-Z3M5N-LNKS06', 'LINK/USD', 'sell', 16, 150, 30, 18),
      ord('OM3X9V-K1D4S-AVXB07', 'AVAX/USD', 'buy', 34, 60, 0, 7),
      ord('ON5W4Y-P8Q2R-ATMS08', 'ATOM/USD', 'sell', 11, 250, 0, 31),
      ord('OP9A2B-C4D6E-SOLC09', 'SOL/USDC', 'buy', 140, 25, 0, 12),
      ord('OQ1C3D-E5F7G-ETBT10', 'ETH/BTC', 'sell', 0.052, 2, 0, 40),
      ord('OR4E6F-G8H1J-BTUC11', 'BTC/USDC', 'buy', 64000, 0.1, 0, 2),
      ord('OS7G9H-J2K4L-AVXS12', 'AVAX/USD', 'sell', 42, 40, 10, 21),
      ord('OT2J5K-L6M8N-LNKB13', 'LINK/USD', 'buy', 12.5, 100, 0, 33),
    ],
    [COINBASE]: [
      ord('7f1c8a92-4d3e-4b21-9c10-btcsel0014', 'BTC/USD', 'sell', 72000, 0.1, 0, 8),
      ord('c1f4a2b8-7d3e-49aa-8f02-lnkbuy0015', 'LINK/USD', 'buy', 13, 150, 50, 11),
      ord('e2b9d6c4-1a5f-4c88-b3e1-eths000016', 'ETH/USD', 'sell', 3600, 1, 0, 6),
      ord('a9e2c5d1-4b6f-4d72-9a03-xrpbuy0017', 'XRP/USD', 'buy', 0.48, 4000, 1000, 19),
      ord('b4f7e1a3-6c2d-4e55-8b41-matsel0018', 'MATIC/USD', 'sell', 0.85, 5000, 0, 27),
      ord('d8c3b6f2-9e1a-4a37-9d52-dogbuy0019', 'DOGE/USD', 'buy', 0.14, 20000, 5000, 16),
      ord('f5a1d9e7-3b8c-4f64-8c63-ltcsel0020', 'LTC/USD', 'sell', 92, 25, 0, 23),
      ord('0a6b2c8d-5e4f-41a9-9e74-unibuy0021', 'UNI/USD', 'buy', 10, 200, 0, 4),
      ord('1b7c3d9e-6f5a-42ba-8f85-dogsel0022', 'DOGE/USD', 'sell', 0.18, 15000, 0, 36),
      ord('2c8d4e0f-7a6b-43cb-9096-ethbuy0023', 'ETH/USDT', 'buy', 3400, 1.2, 0, 10),
      ord('3d9e5f1a-8b7c-44dc-81a7-xrpsel0024', 'XRP/USD', 'sell', 0.6, 3000, 0, 29),
      ord('4e0f6a2b-9c8d-45ed-92b8-solbuy0025', 'SOL/USD', 'buy', 145, 20, 0, 13),
    ],
  };

  function openOrders(connId: number): any[] {
    // Clone so callers that tag/mutate the array don't corrupt the source.
    return (ORDERS[connId] || []).map((o) => ({ ...o }));
  }

  // ── Withdrawal addresses (Kraken supports them, Coinbase does not) ─────────

  const ADDRESSES: Record<number, any[]> = {
    [KRAKEN]: [
      { nickname_key: 'cold_storage_btc', asset: 'BTC', method: 'Bitcoin', address: 'bc1q9x8k2v7m4p3qz6r0t5n8w1y4u7s2d5f8g1h3j6' },
      { nickname_key: 'eth_ledger', asset: 'ETH', method: 'ERC20', address: '0x7a2F4c9B1e6D8a3C5f0B2e9A4d7C1f8E3b6D2a9C' },
    ],
    [COINBASE]: [],
  };

  function withdrawalAddresses(connId: number): any[] {
    return (ADDRESSES[connId] || []).map((a) => ({ ...a }));
  }

  // ── Automations (reference the orders / assets / wallets above) ────────────

  /** "Sell when price crosses a threshold, then convert." */
  function priceRule(id: number, name: string, ex: number, asset: string, threshold: string, to: string, active: boolean, mode: string, amount: string, execCount: number, maxExec: number | null, lastAgoMs: number): any {
    return {
      id, rule_name: name, is_active: active,
      trigger_type: 'price_threshold',
      trigger_asset: asset, trigger_threshold: threshold, trigger_price_quote_asset: 'USD',
      cooldown_minutes: 30,
      action_type: 'convert_crypto', action_asset: asset, convert_to_asset: to,
      action_amount_mode: mode, action_amount: amount,
      trigger_exchange_id: ex, action_exchange_id: ex,
      trigger_count: execCount, last_triggered_at: execCount > 0 ? ago(lastAgoMs) : null,
      execution_count: execCount, max_executions: maxExec,
    };
  }

  /** "When a balance grows past a threshold, convert it." */
  function balanceRule(id: number, name: string, ex: number, asset: string, threshold: string, to: string, active: boolean, trigCount: number, lastAgoMs: number): any {
    return {
      id, rule_name: name, is_active: active,
      trigger_type: 'balance_threshold',
      trigger_asset: asset, trigger_threshold: threshold,
      cooldown_minutes: 1440,
      action_type: 'convert_crypto', action_asset: asset, convert_to_asset: to,
      action_amount: '',
      trigger_exchange_id: ex, action_exchange_id: ex,
      trigger_count: trigCount, last_triggered_at: trigCount > 0 ? ago(lastAgoMs) : null,
    };
  }

  /** "When a specific order fills, withdraw it (addrKey) or convert it (to)." */
  function orderRule(id: number, name: string, ex: number, orderId: string, asset: string, opts: { addrKey?: string; to?: string }, active: boolean, trigCount: number, lastAgoMs: number): any {
    const r: any = {
      id, rule_name: name, is_active: active,
      trigger_type: 'order_filled', trigger_order_id: orderId,
      action_asset: asset, use_filled_amount: true, action_amount: '',
      trigger_exchange_id: ex, action_exchange_id: ex,
      trigger_count: trigCount, last_triggered_at: trigCount > 0 ? ago(lastAgoMs) : null,
    };
    if (opts.addrKey) { r.action_type = 'withdraw_crypto'; r.action_address_key = opts.addrKey; }
    else { r.action_type = 'convert_crypto'; r.convert_to_asset = opts.to; }
    return r;
  }

  // 20 automations. Kraken can convert OR withdraw (it has whitelisted
  // addresses); Coinbase is convert-only, matching its capability flags.
  function rules(): any[] {
    return [
      // ── Kraken ──
      priceRule(5001, 'Take profit: SOL → USDC', KRAKEN, 'SOL', '165', 'USDC', true, 'all', '', 3, null, 2 * HOUR),
      orderRule(5002, 'Auto-withdraw ETH buy', KRAKEN, 'OQ4F7K-T2A9P-ETHB01', 'ETH', { addrKey: 'eth_ledger' }, true, 0, 0),
      balanceRule(5003, 'Sweep idle USDC into BTC', KRAKEN, 'USDC', '6000', 'BTC', false, 0, 0),
      priceRule(5004, 'Take profit: BTC → USDC', KRAKEN, 'BTC', '72000', 'USDC', true, 'percent', '50', 1, 5, 20 * HOUR),
      balanceRule(5005, 'Stake-out: DOT → ETH', KRAKEN, 'DOT', '300', 'ETH', true, 4, 5 * DAY),
      orderRule(5006, 'Cold-store the BTC buy', KRAKEN, 'OZ8L2M-R5C7N-BTCB03', 'BTC', { addrKey: 'cold_storage_btc' }, true, 0, 0),
      priceRule(5007, 'Take profit: AVAX → USDC', KRAKEN, 'AVAX', '42', 'USDC', true, 'all', '', 2, null, 9 * HOUR),
      balanceRule(5008, 'Rotate ATOM into BTC', KRAKEN, 'ATOM', '400', 'BTC', false, 0, 0),
      orderRule(5009, 'Convert AVAX fills → USDC', KRAKEN, 'OM3X9V-K1D4S-AVXB07', 'AVAX', { to: 'USDC' }, true, 1, 30 * HOUR),
      priceRule(5010, 'Take profit: LINK → USDC', KRAKEN, 'LINK', '16', 'USDC', true, 'all', '', 2, null, 6 * HOUR),
      // ── Coinbase (convert only) ──
      priceRule(5011, 'Take profit: BTC → USDT', COINBASE, 'BTC', '72000', 'USDT', true, 'percent', '50', 1, 5, 20 * HOUR),
      balanceRule(5012, 'Stack LINK into ETH', COINBASE, 'LINK', '400', 'ETH', true, 2, 3 * DAY),
      priceRule(5013, 'Take profit: ETH → USDT', COINBASE, 'ETH', '3600', 'USDT', true, 'all', '', 0, null, 0),
      balanceRule(5014, 'Cash out XRP → USDT', COINBASE, 'XRP', '5000', 'USDT', false, 0, 0),
      orderRule(5015, 'Convert LINK fills → ETH', COINBASE, 'c1f4a2b8-7d3e-49aa-8f02-lnkbuy0015', 'LINK', { to: 'ETH' }, true, 3, 2 * HOUR),
      priceRule(5016, 'Take profit: MATIC → USDC', COINBASE, 'MATIC', '0.85', 'USDC', true, 'all', '', 1, null, 40 * HOUR),
      balanceRule(5017, 'Cash out DOGE → USDT', COINBASE, 'DOGE', '30000', 'USDT', true, 5, 12 * HOUR),
      orderRule(5018, 'Convert XRP fills → USDT', COINBASE, 'a9e2c5d1-4b6f-4d72-9a03-xrpbuy0017', 'XRP', { to: 'USDT' }, true, 2, 16 * HOUR),
      priceRule(5019, 'Take profit: LTC → USDT', COINBASE, 'LTC', '92', 'USDT', false, 'all', '', 0, null, 0),
      balanceRule(5020, 'Compound UNI → ETH', COINBASE, 'UNI', '350', 'ETH', true, 1, 26 * HOUR),
    ];
  }

  // ── Execution history (rule_id maps each log back to a rule above) ─────────

  function logs(): any[] {
    return [
      { rule_id: 5001, created_at: ago(2 * HOUR), trigger_event: 'SOL reached $165.00', action_executed: 'Convert 80 SOL → USDC', action_result: 'Filled: received 12,160 USDC', status: 'success' },
      { rule_id: 5015, created_at: ago(2 * HOUR + 25 * MIN), trigger_event: 'Order c1f4a2b8… filled', action_executed: 'Convert 100 LINK → ETH', action_result: 'Filled: received 0.41 ETH', status: 'success' },
      { rule_id: 5010, created_at: ago(6 * HOUR), trigger_event: 'LINK reached $16.00', action_executed: 'Convert 250 LINK → USDC', action_result: 'Filled: received 3,550 USDC', status: 'success' },
      { rule_id: 5007, created_at: ago(9 * HOUR), trigger_event: 'AVAX reached $42.00', action_executed: 'Convert 120 AVAX → USDC', action_result: 'Filled: received 4,560 USDC', status: 'success' },
      { rule_id: 5017, created_at: ago(12 * HOUR), trigger_event: 'DOGE balance reached 30,000', action_executed: 'Convert 30,000 DOGE → USDT', action_result: 'Filled: received 4,800 USDT', status: 'success' },
      { rule_id: 5018, created_at: ago(16 * HOUR), trigger_event: 'Order a9e2c5d1… filled', action_executed: 'Convert 1,000 XRP → USDT', action_result: 'Failed: amount below exchange minimum', status: 'error' },
      { rule_id: 5004, created_at: ago(20 * HOUR), trigger_event: 'BTC reached $72,000.00', action_executed: 'Convert 50% BTC → USDC', action_result: 'Filled: received ~20,160 USDC', status: 'success' },
      { rule_id: 5011, created_at: ago(20 * HOUR + 10 * MIN), trigger_event: 'BTC reached $72,000.00', action_executed: 'Convert 50% BTC → USDT', action_result: 'Filled: received ~8,400 USDT', status: 'success' },
      { rule_id: 5020, created_at: ago(26 * HOUR), trigger_event: 'UNI balance reached 350', action_executed: 'Convert 350 UNI → ETH', action_result: 'Filled: received 1.16 ETH', status: 'success' },
      { rule_id: 5009, created_at: ago(30 * HOUR), trigger_event: 'Order OM3X9V… filled', action_executed: 'Convert 60 AVAX → USDC', action_result: 'Filled: received 2,280 USDC', status: 'success' },
      { rule_id: 5016, created_at: ago(40 * HOUR), trigger_event: 'MATIC reached $0.85', action_executed: 'Convert 8,000 MATIC → USDC', action_result: 'Filled: received 5,760 USDC', status: 'success' },
      { rule_id: 5005, created_at: ago(5 * DAY), trigger_event: 'DOT balance reached 300', action_executed: 'Convert 300 DOT → ETH', action_result: 'Filled: received 0.62 ETH', status: 'success' },
    ];
  }

  function withdrawalMinimums(): Record<string, number> {
    // Superset covering every asset that appears anywhere in the demo.
    return {
      BTC: 0.0001, ETH: 0.0001, SOL: 0.01, ADA: 1, LINK: 0.01, XRP: 0.02,
      DOGE: 1, AVAX: 0.01, DOT: 0.1, LTC: 0.001, MATIC: 0.1, ATOM: 0.01,
      UNI: 0.01, USDC: 0.01, USDT: 0.01,
    };
  }

  // ── Watchlist (mutable for the session so add/remove feels real) ───────────

  let watchSymbols = ['BTC/USD', 'ETH/USD', 'SOL/USD', 'LINK/USD'];

  function watchlist(): any[] {
    return watchSymbols.map((symbol, i) => ({ symbol, sort_order: i }));
  }
  function addWatch(symbol: string): void {
    if (symbol && !watchSymbols.includes(symbol)) watchSymbols.push(symbol);
  }
  function removeWatch(symbol: string): void {
    watchSymbols = watchSymbols.filter((s) => s !== symbol);
  }

  // ── Market data ────────────────────────────────────────────────────────────

  function pairs(): any[] {
    const bases = ['BTC', 'ETH', 'SOL', 'ADA', 'LINK', 'XRP', 'DOGE', 'AVAX', 'DOT', 'LTC', 'MATIC', 'ATOM', 'UNI'];
    const list = bases.map((base) => ({ symbol: `${base}/USD`, base, quote: 'USD' }));
    list.push({ symbol: 'USDC/USD', base: 'USDC', quote: 'USD' });
    list.push({ symbol: 'USDT/USD', base: 'USDT', quote: 'USD' });
    return list;
  }

  // Small deterministic PRNG so a given symbol+range always draws the same
  // chart (otherwise the line would jump on every refresh).
  function hash(str: string): number {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function seeded(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const RANGES: Record<string, { count: number; step: number; volatility: number }> = {
    '1H': { count: 60, step: 60, volatility: 0.004 },
    '12H': { count: 72, step: 600, volatility: 0.008 },
    '1D': { count: 96, step: 900, volatility: 0.012 },
    '1W': { count: 84, step: 7200, volatility: 0.03 },
    '1M': { count: 60, step: 43200, volatility: 0.06 },
    '3M': { count: 90, step: 86400, volatility: 0.1 },
    'YTD': { count: 120, step: 129600, volatility: 0.14 },
    '1Y': { count: 120, step: 259200, volatility: 0.18 },
    '5Y': { count: 120, step: 1296000, volatility: 0.3 },
    'ALL': { count: 120, step: 2592000, volatility: 0.35 },
  };

  function ohlcv(symbol: string, range: string): any[] {
    const base = (symbol.split('/')[0] || symbol).toUpperCase();
    const price = PRICE[base] ?? 100;
    const cfg = RANGES[range] || RANGES['1D'];
    const rng = seeded(hash(`${symbol}|${range}`));
    const nowSec = Math.floor(Date.now() / 1000);

    // Start somewhere below the current price so the series trends up to it.
    let p = price * (0.82 + rng() * 0.12);
    const candles: Array<{ time: number; open: number; high: number; low: number; close: number }> = [];
    for (let i = cfg.count - 1; i >= 0; i--) {
      const time = nowSec - i * cfg.step;
      const drift = (price - p) * 0.04;            // gentle pull toward target
      const vol = price * cfg.volatility;
      const open = p;
      let close = open + drift + (rng() - 0.5) * vol;
      close = Math.max(price * 0.01, close);
      const high = Math.max(open, close) + rng() * vol * 0.5;
      const low = Math.max(price * 0.005, Math.min(open, close) - rng() * vol * 0.5);
      candles.push({ time, open, high, low, close });
      p = close;
    }
    // Anchor the final close to the reference price so it matches the ticker.
    if (candles.length) candles[candles.length - 1].close = price;
    return candles;
  }

  function ticker(symbol: string): any {
    const base = (symbol.split('/')[0] || symbol).toUpperCase();
    const last = PRICE[base] ?? 100;
    return { symbol, last, bid: last * 0.999, ask: last * 1.001 };
  }

  // ── Profile ────────────────────────────────────────────────────────────────

  function profile(): UserModel {
    // Keep whatever theme is currently applied so toggling doesn't flip it.
    const theme = (localStorage.getItem('cyrus_view_theme') as 'dark' | 'light')
      || (document.body.classList.contains('theme-light') ? 'light' : 'dark');
    return {
      id: 9000,
      username: 'alexmorgan',
      created_at: ago(90 * DAY),
      updated_at: ago(2 * HOUR),
      last_login: ago(15 * MIN),
      notifications_enabled: true,
      donation_modal_enabled: true,
      is_active: true,
      theme,
      exchange_connections: connections(),
      has_validated_connection: true,
    };
  }

  /** Wrap a payload in the standard API envelope (for data-layer methods that
   *  return the full ApiResponse rather than the unwrapped data). */
  function wrap<T>(data: T): ApiResponse<T> {
    return { status: 'success', result: 'ok', data };
  }

  return {
    connections,
    supportedExchanges,
    balance,
    portfolio,
    openOrders,
    withdrawalAddresses,
    rules,
    logs,
    withdrawalMinimums,
    watchlist,
    addWatch,
    removeWatch,
    pairs,
    ohlcv,
    ticker,
    profile,
    wrap,
  };
})();

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

class DemoMode {
  private static readonly KEY = 'cyrus_view_state';
  private static readonly THEME_KEY = 'cyrus_view_theme';
  private static patched = false;
  private static originals: Array<{ holder: any; name: string; fn: any }> = [];

  static isEnabled(): boolean {
    return localStorage.getItem(DemoMode.KEY) === '1';
  }

  /** The data-source methods we swap, paired with their demo replacements.
   *  ExchangeController/AutomationController/UserController return UNWRAPPED
   *  data; the *Data services return the full ApiResponse envelope. */
  private static targets(): Array<[any, string, (...args: any[]) => any]> {
    return [
      [ExchangeController, 'getConnections', async () => DemoData.connections()],
      [ExchangeController, 'getSupportedExchanges', async () => DemoData.supportedExchanges()],
      [ExchangeController, 'getOpenOrders', async (id: number) => DemoData.openOrders(id)],
      [ExchangeController, 'getWithdrawalAddresses', async (id: number) => DemoData.withdrawalAddresses(id)],
      [ExchangeController, 'getBalance', async (id: number) => DemoData.balance(id)],
      [ExchangeController, 'getPortfolio', async (id: number) => DemoData.portfolio(id)],

      [AutomationController, 'getRules', async () => DemoData.rules()],
      [AutomationController, 'getLogs', async (limit?: number) => DemoData.logs().slice(0, limit ?? 100)],
      [AutomationController, 'getWithdrawalMinimums', async () => DemoData.withdrawalMinimums()],

      [UserController, 'getProfile', async () => DemoData.profile()],

      [WatchlistData, 'getWatchlist', async () => DemoData.wrap(DemoData.watchlist())],
      [WatchlistData, 'addToWatchlist', async (_t: string, s: string) => { DemoData.addWatch(s); return DemoData.wrap({}); }],
      [WatchlistData, 'removeFromWatchlist', async (_t: string, s: string) => { DemoData.removeWatch(s); return DemoData.wrap({}); }],
      [WatchlistData, 'updateOrder', async () => DemoData.wrap({})],

      [MarketData, 'getPairs', async () => DemoData.wrap(DemoData.pairs())],
      [MarketData, 'getOHLCV', async (_t: string, sym: string, range: string) => DemoData.wrap(DemoData.ohlcv(sym, range))],
      [MarketData, 'getTicker', async (_t: string, sym: string) => DemoData.wrap(DemoData.ticker(sym))],
    ];
  }

  private static apply(): void {
    if (DemoMode.patched) return;
    DemoMode.patched = true;
    DemoMode.originals = [];
    for (const [holder, name, fn] of DemoMode.targets()) {
      DemoMode.originals.push({ holder, name, fn: holder[name] });
      holder[name] = fn;
    }
  }

  private static restore(): void {
    if (!DemoMode.patched) return;
    for (const { holder, name, fn } of DemoMode.originals) {
      holder[name] = fn;
    }
    DemoMode.originals = [];
    DemoMode.patched = false;
  }

  /** Re-sync the shared store with the (now swapped) data source and re-render
   *  whatever page is currently showing. */
  private static async refreshApp(): Promise<void> {
    try {
      await ExchangeStore.loadConnections();
      let mode: 'all' | number = 'all';
      const saved = localStorage.getItem('cyrus_exchange_mode');
      if (saved && saved !== 'all') {
        const id = parseInt(saved, 10);
        if (ExchangeStore.connections.find((c) => c.id === id)) mode = id;
      }
      const sel = document.getElementById('exchange-selector') as HTMLSelectElement | null;
      if (sel) sel.value = String(mode);
      ExchangeStore.setMode(mode);
    } catch { /* store may not be running yet — pages refetch on navigate */ }

    const route = router.getCurrentRoute();
    if (route) router.navigate(route);
  }

  private static async enable(): Promise<void> {
    localStorage.setItem(DemoMode.KEY, '1');
    localStorage.setItem(DemoMode.THEME_KEY, document.body.classList.contains('theme-light') ? 'light' : 'dark');
    DemoMode.apply();
    // Any "connect an exchange" / "invalid key" warnings make no sense in demo.
    try { ApiKeyState.setStatus('valid'); } catch {}
    await DemoMode.refreshApp();
    DemoMode.toast('Refreshed', true);
  }

  private static async disable(): Promise<void> {
    localStorage.removeItem(DemoMode.KEY);
    DemoMode.restore();
    try { await UserController.refreshKeyStatus(); } catch {}
    await DemoMode.refreshApp();
    DemoMode.toast('Refreshed', false);
  }

  static toggle(): void {
    if (DemoMode.isEnabled()) {
      void DemoMode.disable();
    } else {
      void DemoMode.enable();
    }
  }

  /** Brief, self-styled confirmation pill (no extra CSS file needed). */
  private static toast(text: string, on: boolean): void {
    let el = document.getElementById('cyrus-sync-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cyrus-sync-toast';
      el.style.cssText = [
        'position:fixed', 'left:50%', 'bottom:32px', 'transform:translateX(-50%)',
        'z-index:99999', 'padding:10px 18px', 'border-radius:999px',
        'font:600 13px/1 system-ui,-apple-system,Segoe UI,sans-serif',
        'color:#fff', 'box-shadow:0 8px 24px rgba(0,0,0,0.35)',
        'pointer-events:none', 'opacity:0', 'transition:opacity .25s ease',
      ].join(';');
      document.body.appendChild(el);
    }
    const toastEl = el;
    toastEl.textContent = text;
    toastEl.style.background = on ? '#06b6d4' : '#475569';
    // Force a reflow so the opacity transition runs even on rapid re-toggles.
    void toastEl.offsetWidth;
    toastEl.style.opacity = '1';
    window.clearTimeout((toastEl as any).__hideTimer);
    (toastEl as any).__hideTimer = window.setTimeout(() => { toastEl.style.opacity = '0'; }, 2000);
  }

  /** Attach the Ctrl+Shift+double-left-click handler to the sidebar logo. */
  static installTrigger(): void {
    const logo = document.querySelector('.header-logo') as HTMLElement | null;
    if (!logo || (logo as any).__cyrusWired) return;
    (logo as any).__cyrusWired = true;
    logo.style.userSelect = 'none';
    logo.addEventListener('dblclick', (e) => {
      const ev = e as MouseEvent;
      if (ev.button === 0 && ev.ctrlKey && ev.shiftKey) {
        e.preventDefault();
        DemoMode.toggle();
      }
    });
  }

  /** Runs as soon as this script loads (before app.js): re-apply the patches
   *  if the demo was left on, and wire up the logo trigger. */
  static bootstrap(): void {
    if (DemoMode.isEnabled()) DemoMode.apply();
    DemoMode.installTrigger();
  }
}

DemoMode.bootstrap();
