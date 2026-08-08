/**
 * DemoMode — a hidden "show me dummy data" switch for screenshots / demos.
 *
 * Triggered by Ctrl+Shift+double-left-click on the sidebar logo (wired at the
 * bottom of this file). When enabled, the data-source methods that feed every
 * page are swapped for versions that return ONE internally-consistent fake
 * dataset, so the numbers line up across the whole app:
 *
 *   • Four connected exchanges (Kraken, Coinbase, Binance, Robinhood) …
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
  const BINANCE = 9003;
  const ROBINHOOD = 9004;

  const EXCHANGE_OF: Record<number, string> = {
    [KRAKEN]: 'kraken',
    [COINBASE]: 'coinbase',
    [BINANCE]: 'binance',
    [ROBINHOOD]: 'robinhood',
  };

  const ALL_CONNS = [KRAKEN, COINBASE, BINANCE, ROBINHOOD];

  // Reference USD prices, keyed by base asset. Everything else (portfolio
  // values, order fills, log amounts, chart levels) is derived from these so
  // the story stays consistent.
  const PRICE: Record<string, number> = {
    BTC:     63518,
    ETH:     1856.41,
    SOL:     73.40,
    ADA:     0.1939,
    LINK:    8.17,
    XRP:     1.074,
    DOGE:    0.070132,
    AVAX:    6.56,
    DOT:     0.8227,
    LTC:     44.17,
    POL:     0.072869,
    ATOM:    1.36,
    UNI:     3.91,
    NEAR:    1.73,
    ARB:     0.082141,
    OP:      0.087636,
    INJ:     4.96,
    SUI:     0.689381,
    TIA:     0.338527,
    RENDER:  1.36,
    FET:     0.144992,
    AAVE:    91.91,
    MKR:     1295.65,
    XLM:     0.170981,
    BCH:     213.03,
    ETC:     6.59,
    ALGO:    0.090555,
    HBAR:    0.070697,
    FIL:     0.720412,
    GRT:     0.01477962,
    IMX:     0.110698,
    SHIB:    4.99e-06,
    PEPE:    2.9e-06,
    USDC:    1,
    USDT:    1,
    DAI:     1,
    USD:     1,
  };

  // Holdings per connection (asset -> amount). These ARE the balances and the
  // portfolio at the same time. USD entries show up as cash on the Holdings
  // page rather than as a coin.
  const HOLDINGS: Record<number, Record<string, number>> = {
    [KRAKEN]: { BTC: 0.656, ETH: 10.1, SOL: 166, ADA: 9490, USDC: 6000, DOT: 2630, LINK: 435, AVAX: 695, ATOM: 2760, XLM: 8000, FIL: 2330, AAVE: 12.5, USD: 850 },
    [COINBASE]: { BTC: 0.264, ETH: 5.81, LINK: 695, XRP: 2470, USDT: 2500, POL: 79000, DOGE: 68400, LTC: 76.1, UNI: 1030, NEAR: 2120, OP: 24100, GRT: 244000 },
    [BINANCE]: { BTC: 0.19, ETH: 4.12, SOL: 93.2, ARB: 40900, INJ: 331, SUI: 5370, TIA: 7240, FET: 13900, USDT: 4000, BCH: 8.04, ALGO: 18400, RENDER: 2440 },
    [ROBINHOOD]: { BTC: 0.127, ETH: 2.62, DOGE: 137000, SHIB: 124000000, LTC: 22.8, ETC: 160, XLM: 5330, SOL: 37.3, AVAX: 174, HBAR: 25200, IMX: 14800, USD: 1450 },
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
      { id: KRAKEN, exchange_name: 'kraken', label: 'Main', is_validated: true,
        is_sandbox: false, keys_last_validated: ago(12 * MIN), created_at: ago(180 * DAY) },
      { id: COINBASE, exchange_name: 'coinbase', label: 'Trading', is_validated: true,
        is_sandbox: false, keys_last_validated: ago(31 * MIN), created_at: ago(120 * DAY) },
      { id: BINANCE, exchange_name: 'binance', label: 'Spot', is_validated: true,
        is_sandbox: false, keys_last_validated: ago(48 * MIN), created_at: ago(64 * DAY) },
      { id: ROBINHOOD, exchange_name: 'robinhood', label: 'Crypto', is_validated: true,
        is_sandbox: false, keys_last_validated: ago(9 * MIN), created_at: ago(21 * DAY) },
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
        supports_rebalance: true,
        needs_generated_keypair: false,
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
        supports_rebalance: true,
        needs_generated_keypair: false,
        has_sandbox: false,
        website: 'https://www.coinbase.com',
        api_key_url: 'https://www.coinbase.com/settings/api',
        guide_url: 'https://docs.cdp.coinbase.com/exchange/introduction/rest-quickstart',
      },
      {
        id: 'binance',
        name: 'Binance (Beta)',
        requires_passphrase: false,
        has_withdrawal_addresses: false,
        supports_withdraw: false,
        supports_rebalance: true,
        needs_generated_keypair: false,
        has_sandbox: false,
        website: 'https://www.binance.com',
        api_key_url: 'https://www.binance.com/en/my/settings/api-management',
        guide_url: 'https://www.binance.com/en/support/faq/how-to-create-api-keys-on-binance-360002502072',
      },
      {
        id: 'robinhood',
        name: 'Robinhood (Beta)',
        requires_passphrase: false,
        has_withdrawal_addresses: false,
        supports_withdraw: false,
        supports_rebalance: true,
        // Drives the key-generator offer in Profile.
        needs_generated_keypair: true,
        has_sandbox: false,
        website: 'https://robinhood.com',
        api_key_url: 'https://robinhood.com/account/crypto',
        guide_url: 'https://docs.robinhood.com/crypto/trading/',
      },
    ];
  }

  // ── Balances + portfolio (same underlying holdings) ───────────────────────

  /** Every asset the demo exchange "trades" - holdings plus unheld extras, so
   *  the not-held group in the asset pickers has something in it. */
  function tradableAssets(connId: number): string[] {
    const extras = ['USDG', 'PYUSD', 'TUSD', 'DAI', 'EUR', 'GBP', 'WBTC', 'STETH',
                    'TON', 'TAO', 'ONDO', 'JUP', 'WLD', 'SEI', 'APT', 'KAS'];
    const held = Object.keys(HOLDINGS[connId] || {});
    return Array.from(new Set([...Object.keys(PRICE), ...held, ...extras])).sort();
  }

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

  // ── Asset fundamentals (Holdings page) ────────────────────────────────────

  /** [name, rank, marketCap, circulating, total, max, ath, athDate, atl, atlDate,
   *   1h%, 24h%, 7d%, 30d%] — plausible figures, not live ones. */
  const FUNDAMENTALS: Record<string, any[]> = {
    BTC:     ['Bitcoin', 1, 1274476226211.0, 20065359.0, 20065359.0, 21000000.0, 126080, '2025-10-06', 67.81, '2013-07-05', 0.0, -0.2, -1.7, 0.4],
    ETH:     ['Ethereum', 2, 224020315797.0, 120682242.0, 120682242.0, null, 4946.05, '2025-08-24', 0.432979, '2015-10-19', -0.2, -1.9, -3.9, 3.9],
    USDT:    ['Tether', 3, 183261361489.0, 183412904323.0, 188879846173.0, null, 1.32, '2018-07-23', 0.572521, '2015-03-01', 0.0, 0.0, 0.0, 0.0],
    USDC:    ['USDC', 5, 72089263235.0, 72121605873.0, 72128738389.0, null, 1.043, '2018-11-14', 0.877647, '2023-03-11', 0.0, 0.0, 0.0, 0.0],
    XRP:     ['XRP', 6, 67159823417.0, 62533271955.0, 99985635707.0, 100000000000.0, 3.65, '2025-07-17', 0.00268621, '2014-05-21', -0.4, -1.1, -0.7, -7.8],
    SOL:     ['Solana', 7, 42656192577.0, 581192593.0, 631502859.0, null, 293.31, '2025-01-19', 0.500801, '2020-05-11', -0.2, -0.8, -2.5, -10.3],
    DOGE:    ['Dogecoin', 11, 10893643362.0, 155344326384.0, 155344686384.0, null, 0.731578, '2021-05-07', 8.69e-05, '2015-05-05', -0.3, -0.9, -2.0, -10.2],
    ADA:     ['Cardano', 16, 7260649219.0, 37347307716.0, 45000000000.0, 45000000000.0, 3.09, '2021-09-01', 0.01925275, '2020-03-12', 0.6, 3.0, 23.5, 1.2],
    LINK:    ['Chainlink', 19, 6112645237.0, 748099970.0, 1000000000.0, 1000000000.0, 52.7, '2021-05-09', 0.148183, '2017-11-28', -0.2, -2.4, -4.3, 1.8],
    XLM:     ['Stellar', 20, 5861708916.0, 34281917535.0, 50001786840.0, null, 0.875563, '2018-01-02', 0.00047612, '2015-03-04', -0.3, -2.3, -2.4, -18.1],
    BCH:     ['Bitcoin Cash', 23, 4275497466.0, 20070272.0, 20070275.0, 21000000.0, 3785.82, '2017-12-19', 76.93, '2018-12-15', 0.0, -0.3, -0.4, -8.8],
    LTC:     ['Litecoin', 28, 3421165671.0, 77456910.0, 77459585.0, 84000000.0, 410.26, '2021-05-09', 1.15, '2015-01-13', -0.4, -1.7, -5.0, -2.1],
    HBAR:    ['Hedera', 29, 3096942778.0, 43791096257.0, 50000000000.0, 50000000000.0, 0.569229, '2021-09-15', 0.00986111, '2020-01-02', 0.2, 1.4, 3.5, -7.0],
    SHIB:    ['Shiba Inu', 31, 2941753515.0, 589239665452646.0, 589496383502152.0, null, 8.616e-05, '2021-10-27', 5.6366e-11, '2020-11-28', 0.3, 1.6, -0.2, 12.1],
    AVAX:    ['Avalanche', 32, 2832590985.0, 431771961.0, 463441061.0, 720000000.0, 144.96, '2021-11-21', 2.8, '2020-12-31', 0.0, -1.2, 0.3, -6.3],
    SUI:     ['Sui', 33, 2809637891.0, 4074529886.0, 10000000000.0, 10000000000.0, 5.35, '2025-01-04', 0.364846, '2023-10-19', -0.4, -0.6, -1.2, -10.6],
    UNI:     ['Uniswap', 38, 2441231163.0, 624814424.0, 892062420.0, 1000000000.0, 44.92, '2021-05-02', 1.03, '2020-09-16', -0.7, -7.6, 3.9, 20.7],
    NEAR:    ['NEAR Protocol', 39, 2254437462.0, 1302629870.0, 1302629878.0, null, 20.44, '2022-01-16', 0.526762, '2020-11-04', -1.0, 0.9, 0.6, -13.4],
    AAVE:    ['Aave', 52, 1417698813.0, 15422142.0, 16000000.0, 16000000.0, 661.69, '2021-05-18', 26.02, '2020-11-05', -0.2, -1.0, -7.1, 3.2],
    DOT:     ['Polkadot', 53, 1395443898.0, 1696353468.0, 1696360231.0, 2100000000.0, 54.98, '2021-11-04', 0.746764, '2026-07-31', 0.0, 3.2, 5.1, -7.8],
    PEPE:    ['Pepe', 58, 1221300957.0, 420690000000000.0, 420690000000000.0, 420690000000000.0, 2.803e-05, '2024-12-09', 5.5142e-08, '2023-04-17', -0.7, -0.6, 0.6, 6.3],
    ICP:     ['Internet Computer', 59, 1170901157.0, 555296713.0, 555296713.0, null, 700.65, '2021-05-10', 2.0, '2026-08-01', -0.3, 1.0, -1.3, -6.5],
    ETC:     ['Ethereum Classic', 64, 1039025133.0, 157729284.0, 157729711.0, 210700000.0, 167.09, '2021-05-06', 0.615038, '2016-07-24', -0.4, -0.9, -4.6, -9.9],
    ALGO:    ['Algorand', 77, 813017560.0, 8969018347.0, 8969018347.0, 10000000000.0, 3.56, '2019-06-20', 0.075732, '2026-07-29', -0.3, 7.3, 11.2, -0.5],
    POL:     ['POL (ex-MATIC)', 79, 779089808.0, 10689718145.0, 10689718145.0, null, 1.29, '2024-03-13', 0.067711, '2026-07-01', 0.1, 0.0, -2.5, -1.0],
    ATOM:    ['Cosmos Hub', 82, 708506337.0, 523047003.0, 523054969.0, null, 43.84, '2021-09-19', 1.16, '2020-03-12', -0.9, 7.1, 2.2, -15.0],
    RENDER:  ['Render', 83, 703354668.0, 518772101.0, 533532275.0, 644245094.0, 13.53, '2024-03-17', 0.03665669, '2020-06-16', -0.3, -2.0, -5.6, -16.1],
    FIL:     ['Filecoin', 91, 586470679.0, 814059407.0, 1957163709.0, null, 236.84, '2021-04-01', 0.657819, '2026-07-29', -0.3, 0.0, 2.1, -10.1],
    ARB:     ['Arbitrum', 95, 543402259.0, 6614056381.0, 10000000000.0, 10000000000.0, 2.39, '2024-01-12', 0.07048, '2026-06-26', -0.4, 0.7, 4.8, 1.7],
    INJ:     ['Injective', 99, 495833616.0, 100000000.0, 100000000.0, null, 52.62, '2024-03-14', 0.657401, '2020-11-03', 0.0, -2.8, 3.8, 2.7],
    FET:     ['Artificial Superintelligence Alliance', 118, 324476738.0, 2235550632.0, 2714384547.0, 2714384547.0, 3.45, '2024-03-28', 0.00816959, '2020-03-12', 0.1, 1.8, -2.1, -21.7],
    TIA:     ['Celestia', 119, 321877716.0, 950878926.0, 1174131541.0, null, 20.85, '2024-02-10', 0.279235, '2026-06-06', -0.6, 1.8, 1.2, -14.9],
    OP:      ['Optimism', 161, 200361452.0, 2286467356.0, 4294967296.0, 4294967296.0, 4.84, '2024-03-06', 0.082043, '2026-08-01', -0.3, 0.9, -2.9, -19.6],
    GRT:     ['The Graph', 184, 159560742.0, 10799867657.0, 10800262816.0, 10800262823.0, 2.84, '2021-02-11', 0.01408775, '2026-08-01', -0.6, 0.9, -5.5, -22.3],
    IMX:     ['Immutable', 213, 221431416.0, 2000000000.0, 2000000000.0, 2000000000.0, 9.52, '2021-11-25', 0.104869, '2026-07-31', -0.4, -0.6, -8.7, -21.4],
    // CoinGecko now reports MKR under Sky, so its cap/rank are derived from the
    // circulating supply rather than taken from the feed.
    MKR:     ['Maker', 245, 114600000.0, 88442.0, 88442.0, 1005577.0, 6292.31, '2021-05-03', 168.36, '2020-03-16', -0.3, -1.1, -1.2, -2.7],
  };

  /** A deterministic 7-day squiggle that ends consistent with the 7d change. */
  function sparkFor(symbol: string, price: number, change7d: number): number[] {
    const seed = symbol.split('').reduce((a, ch) => a + ch.charCodeAt(0), 0);
    const start = price / (1 + change7d / 100);
    return Array.from({ length: 40 }, (_, i) => {
      const t = i / 39;
      const wobble = Math.sin(t * 6 + seed) * 0.012 + Math.sin(t * 17 + seed * 2) * 0.005;
      return start + (price - start) * t + price * wobble;
    });
  }

  function fundamentals(symbol: string): any | null {
    const f = FUNDAMENTALS[symbol];
    if (!f) return null;
    const [name, rank, cap, circ, total, max, ath, athDate, atl, atlDate, c1h, c24h, c7d, c30d] = f;
    const price = PRICE[symbol] ?? 0;
    const volume = cap * 0.06;
    return {
      coin_id: name.toLowerCase().replace(/\s+/g, '-'),
      name, symbol,
      price,
      market_cap: cap,
      market_cap_rank: rank,
      fully_diluted_valuation: max ? price * max : cap,
      total_volume: volume,
      volume_to_cap_pct: (volume / cap) * 100,
      high_24h: price * 1.02,
      low_24h: price * 0.97,
      change_1h_pct: c1h, change_24h_pct: c24h,
      change_7d_pct: c7d, change_30d_pct: c30d,
      circulating_supply: circ, total_supply: total, max_supply: max,
      supply_issued_pct: max || total ? Math.min(100, (circ / (max || total)) * 100) : null,
      ath, ath_date: `${athDate}T00:00:00.000Z`,
      ath_change_pct: ((price - ath) / ath) * 100,
      atl, atl_date: `${atlDate}T00:00:00.000Z`,
      atl_change_pct: ((price - atl) / atl) * 100,
      sparkline_7d: sparkFor(symbol, price, c7d),
    };
  }

  const FIAT = new Set(['USD', 'ZUSD', 'EUR']);

  function holdings(connId: number | string = 'all'): any {
    const ids = connId === 'all' || connId == null
      ? ALL_CONNS.slice()
      : [typeof connId === 'string' ? parseInt(connId, 10) : connId];

    const merged: Record<string, any> = {};
    for (const id of ids) {
      const label = EXCHANGE_OF[id] || 'exchange';
      for (const p of portfolio(id).positions) {
        const entry = merged[p.asset] || (merged[p.asset] = {
          asset: p.asset, amount: 0, usd_value: 0, venues: [],
        });
        entry.amount += p.amount;
        entry.usd_value += p.usd_value;
        entry.venues.push({ exchange_label: label, connection_id: id, amount: p.amount, usd_value: p.usd_value });
      }
    }

    const total = Object.values(merged).reduce((s: number, e: any) => s + e.usd_value, 0);
    const positions = Object.values(merged).map((e: any) => {
      const info = fundamentals(e.asset);
      const c24 = info?.change_24h_pct;
      return {
        ...e,
        is_cash: FIAT.has(e.asset),
        unit_price: e.amount ? e.usd_value / e.amount : 0,
        weight_percent: total ? (e.usd_value / total) * 100 : 0,
        value_change_24h_usd: c24 != null ? e.usd_value - e.usd_value / (1 + c24 / 100) : null,
        info,
      };
    }).sort((a: any, b: any) => b.usd_value - a.usd_value);

    return {
      total_usd: total, positions,
      market_data_live: true, market_data_stale_seconds: 0, errors: [],
    };
  }

  function assetDetail(symbol: string): any {
    const sym = String(symbol || '').toUpperCase();
    const info = fundamentals(sym);
    const price = PRICE[sym] ?? 0;
    return {
      symbol: sym,
      is_cash: FIAT.has(sym),
      info,
      exchange: info ? {
        available: true, pair: `${sym}/USD`,
        high: info.ath * 0.98, high_date: String(info.ath_date).slice(0, 10),
        low: price * 0.35, low_date: '2022-11-21',
        high_52w: price * 1.28, low_52w: price * 0.61,
        since: '2017-06-05',
        min_order_amount: price > 1000 ? 0.0001 : 0.5,
        min_order_cost: null, maker_fee: 0.0016, taker_fee: 0.0026,
      } : { available: false },
      market_data_live: true, market_data_stale_seconds: 0,
    };
  }

  // ── Balancer (allocation caps over the same holdings) ─────────────────────

  const CONVERT_TARGETS = ['USD', 'USDC', 'USDT', 'BTC', 'ETH'];

  /** Caps per connection: asset -> [max %, down-to %, destination]. */
  const CAPS: Record<number, Record<string, [number, number, string]>> = {
    [KRAKEN]: { BTC: [30, 25, 'USDC'], ETH: [22, 18, 'USDC'], SOL: [12, 9, 'USDC'] },
    [COINBASE]: { BTC: [28, 24, 'USDT'], LINK: [18, 14, 'USDT'] },
    [BINANCE]: { BTC: [26, 22, 'USDT'], SOL: [15, 11, 'USDT'] },
    [ROBINHOOD]: { BTC: [32, 27, 'USD'], DOGE: [12, 9, 'USD'] },
  };

  function allocations(connId: number): any {
    const pf = portfolio(connId);
    const caps = CAPS[connId] || {};
    const minTrade = 25;

    const positions = pf.positions.map((p) => {
      const cap = caps[p.asset];
      const weight = pf.total_usd > 0 ? (p.usd_value / pf.total_usd) * 100 : 0;
      const row: any = {
        asset: p.asset,
        amount: p.amount,
        usd_value: p.usd_value,
        weight_percent: Number(weight.toFixed(4)),
        held: true,
        convert_targets: CONVERT_TARGETS.filter((t) => t !== p.asset),
        rule_id: null,
        enabled: false,
        max_percent: null,
        target_percent: null,
        convert_to_asset: null,
        excess_usd: 0,
        would_convert_amount: 0,
        over_cap: false,
      };
      if (!cap) return row;

      const [max, target, to] = cap;
      row.rule_id = 6000 + Object.keys(caps).indexOf(p.asset);
      row.enabled = true;
      row.max_percent = max;
      row.target_percent = target;
      row.convert_to_asset = to;
      if (weight >= max) {
        const excess = ((weight - target) / 100) * pf.total_usd;
        row.over_cap = true;
        row.excess_usd = Number(excess.toFixed(2));
        if (excess >= minTrade && p.amount > 0) {
          row.would_convert_amount = Math.min(excess / (p.usd_value / p.amount), p.amount);
        }
      }
      return row;
    });

    return {
      connection: { id: connId, exchange_name: EXCHANGE_OF[connId] || 'kraken', label: 'Default' },
      total_usd: pf.total_usd,
      settings: { cooldown_minutes: 1440, min_trade_usd: minTrade, dry_run: false },
      positions,
    };
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
      ord('O7Q9SB-XGZJ3-BTC00', 'BTC/USD', 'buy', 61294.87, 0.16, 0.0, 3),
      ord('ODWFYH-5N7Q9-BTC01', 'BTC/USD', 'sell', 68091.30, 0.21, 0.0, 26),
      ord('OK4M6P-BUDWF-ETH02', 'ETH/USD', 'buy', 1804.43, 2.81, 0.93, 7),
      ord('ORATCV-H2K4M-ETH03', 'ETH/USD', 'sell', 1964.08, 3.75, 0.0, 14),
      ord('OXGZJ3-P8RAT-SOL04', 'SOL/USD', 'sell', 79.64, 82.8, 0.0, 2),
      ord('O5N7Q9-VEXGZ-SOL05', 'SOL/USD', 'buy', 69.00, 51.8, 0.0, 31),
      ord('OBUDWF-3L5N7-ADA06', 'ADA/USD', 'buy', 0.18517, 5930, 2370.0, 9),
      ord('OH2K4M-9SBUD-DOT07', 'DOT/USD', 'sell', 0.91297, 1310, 0.0, 44),
      ord('OP8RAT-FYH2K-LIN08', 'LINK/USD', 'buy', 7.84, 261, 131.0, 11),
      ord('OVEXGZ-M6P8R-LIN09', 'LINK/USD', 'sell', 8.91, 209, 0.0, 20),
      ord('O3L5N7-TCVEX-AVA10', 'AVAX/USD', 'sell', 7.25, 348, 0.0, 6),
      ord('O9SBUD-ZJ3L5-ATO11', 'ATOM/USD', 'buy', 1.28, 1380, 0.0, 38),
      ord('OFYH2K-7Q9SB-XLM12', 'XLM/USD', 'buy', 0.15901, 5330, 1330.0, 16),
      ord('OM6P8R-DWFYH-FIL13', 'FIL/USD', 'sell', 0.82076, 1170, 0.0, 52),
      ord('OTCVEX-K4M6P-AAV14', 'AAVE/USD', 'sell', 98.80, 6.27, 0.0, 4),
      ord('OZJ3L5-RATCV-BTC15', 'BTC/USDC', 'buy', 62247.64, 0.085, 0.0, 1),
      ord('O7Q9SB-XGZJ3-ETH16', 'ETH/USDC', 'sell', 1939.95, 2.25, 0.0, 29),
      ord('ODWFYH-5N7Q9-SOL17', 'SOL/USDC', 'buy', 70.10, 62.1, 0.0, 47),
      ord('OK4M6P-BUDWF-DOT18', 'DOT/USD', 'buy', 0.75643, 3500, 0.0, 63),
    ],
    [COINBASE]: [
      ord('b5f93d71-82c6-45f9-82c6-f93d71b5c60a', 'BTC/USD', 'buy', 61612.46, 0.063, 0.0, 5),
      ord('b61c72d8-83e9-450b-82d8-fa50b61cc72d', 'BTC/USD', 'sell', 67646.67, 0.11, 0.0, 22),
      ord('37bf37bf-048c-4d15-8ae2-7bf37bf348c0', 'ETH/USD', 'sell', 1952.94, 1.87, 0.0, 8),
      ord('38d27c16-05af-4d27-8af4-7c16b05a49e3', 'ETH/USD', 'buy', 1797.00, 1.5, 0.75, 18),
      ord('ad0369cf-7ad0-447a-8147-e147ad03be14', 'LINK/USD', 'buy', 7.80, 348, 87.0, 11),
      ord('ae26ae26-7bf3-448c-8159-e26ae26abf37', 'LINK/USD', 'sell', 8.89, 313, 0.0, 33),
      ord('ef012345-bcde-489a-8567-23456789f012', 'XRP/USD', 'buy', 1.01, 1970, 493.0, 19),
      ord('e02468ac-bdf1-48ac-8579-2468ace0f135', 'XRP/USD', 'sell', 1.20, 1480, 0.0, 29),
      ord('a18f6d4b-7e5c-44b2-818f-e5c3a18fb290', 'POL/USD', 'sell', 0.08599, 49400, 0.0, 27),
      ord('a2a2a2a2-7f7f-44c4-8191-e6e6e6e6b3b3', 'POL/USD', 'buy', 0.06558, 59300, 0.0, 55),
      ord('d71b5f93-a4e8-471b-84e8-1b5f93d7e82c', 'DOGE/USD', 'buy', 0.06312, 45600, 11400.0, 16),
      ord('d83e94fa-a50b-472d-84fa-1c72d83ee94f', 'DOGE/USD', 'sell', 0.07890, 34200, 0.0, 36),
      ord('99999999-6666-4333-8000-ddddddddaaaa', 'LTC/USD', 'sell', 48.37, 47.5, 0.0, 23),
      ord('4e82c60a-1b5f-4e82-8b5f-82c60a4e5f93', 'UNI/USD', 'buy', 3.68, 588, 0.0, 4),
      ord('27c16b05-f49e-4c16-89e3-6b05af4938d2', 'NEAR/USD', 'sell', 1.95, 1060, 0.0, 41),
      ord('dcba9876-a987-4765-8432-10fedcbaedcb', 'OP/USD', 'buy', 0.08092, 13400, 0.0, 13),
      ord('7531fdb9-420e-41fd-8eca-b97531fd8642', 'GRT/USD', 'buy', 0.01352, 146000, 0.0, 49),
      ord('369cf258-0369-4d03-8ad0-7ad0369c47ad', 'ETH/USDT', 'buy', 1810.00, 2.25, 0.0, 10),
      ord('b73fb73f-840c-451d-82ea-fb73fb73c840', 'BTC/USDT', 'sell', 67011.49, 0.053, 0.0, 58),
    ],
    [BINANCE]: [
      ord('21718423', 'BTC/USDT', 'buy', 61930.05, 0.053, 0.0, 2),
      ord('21823152', 'BTC/USDT', 'sell', 67329.08, 0.095, 0.0, 17),
      ord('21991233', 'ETH/USDT', 'buy', 1800.72, 1.87, 0.75, 6),
      ord('22095962', 'ETH/USDT', 'sell', 1949.23, 2.25, 0.0, 25),
      ord('22303638', 'SOL/USDT', 'sell', 79.27, 41.4, 0.0, 3),
      ord('22408367', 'SOL/USDT', 'buy', 69.73, 31.1, 0.0, 21),
      ord('22315121', 'ARB/USDT', 'buy', 0.07554, 20500, 6150.0, 12),
      ord('22419850', 'ARB/USDT', 'sell', 0.09534, 16400, 0.0, 39),
      ord('22619607', 'INJ/USDT', 'sell', 5.46, 166, 0.0, 8),
      ord('22724336', 'INJ/USDT', 'buy', 4.66, 138, 0.0, 45),
      ord('22955769', 'SUI/USDT', 'buy', 0.64280, 2580, 0.0, 15),
      ord('23060498', 'SUI/USDT', 'sell', 0.78720, 2150, 0.0, 30),
      ord('23014766', 'TIA/USDT', 'sell', 0.37929, 3470, 0.0, 9),
      ord('23127414', 'FET/USDT', 'buy', 0.13075, 6180, 3090.0, 20),
      ord('23232143', 'FET/USDT', 'sell', 0.17412, 5410, 0.0, 51),
      ord('23194330', 'BCH/USDT', 'buy', 204.51, 4.02, 0.0, 34),
      ord('23980093', 'ALGO/USDT', 'buy', 0.08241, 10200, 0.0, 43),
      ord('25328105', 'RENDER/USDT', 'sell', 1.56, 1220, 0.0, 7),
      ord('23769844', 'SOL/BTC', 'buy', 0.0011209, 24.9, 0.0, 60),
    ],
    [ROBINHOOD]: [
      ord('b5f93d71-82c6-45f9-82c6-f93d71b5c60a', 'BTC/USD', 'buy', 62247.64, 0.042, 0.0, 4),
      ord('b61c72d8-83e9-450b-82d8-fa50b61cc72d', 'BTC/USD', 'sell', 66693.90, 0.063, 0.0, 28),
      ord('37bf37bf-048c-4d15-8ae2-7bf37bf348c0', 'ETH/USD', 'buy', 1810.00, 1.12, 0.0, 10),
      ord('38d27c16-05af-4d27-8af4-7c16b05a49e3', 'ETH/USD', 'sell', 1945.52, 1.5, 0.0, 32),
      ord('d159d159-ae26-47bf-848c-159d159de26a', 'DOGE/USD', 'buy', 0.06312, 57000, 22800.0, 5),
      ord('d27c16b0-af49-47c1-849e-16b05af4e38d', 'DOGE/USD', 'sell', 0.07995, 45600, 0.0, 24),
      ord('2fc9630d-fc96-4c96-8963-630da74130da', 'SHIB/USD', 'buy', 0.00000439, 50000000, 0.0, 18),
      ord('94fa50b6-61c7-43e9-80b6-d83e94faa50b', 'LTC/USD', 'sell', 48.15, 11.4, 0.0, 12),
      ord('49e38d27-16b0-4e38-8b05-8d27c16b5af4', 'ETC/USD', 'buy', 6.20, 80.1, 0.0, 37),
      ord('3e94fa50-0b61-4d83-8a50-72d83e944fa5', 'XLM/USD', 'buy', 0.15730, 3330, 833.0, 21),
      ord('a3c5e709-7092-44d6-81a3-e7092b4db4d6', 'SOL/USD', 'sell', 78.91, 18.6, 0.0, 6),
      ord('0c840c84-d951-4a62-873f-40c840c81d95', 'AVAX/USD', 'buy', 6.20, 86.9, 0.0, 40),
      ord('71b5f93d-4e82-41b5-8e82-b5f93d7182c6', 'HBAR/USD', 'sell', 0.08201, 15100, 0.0, 46),
      ord('a62ea62e-73fb-440c-81d9-ea62ea62b73f', 'IMX/USD', 'buy', 0.09936, 9260, 0.0, 54),
      ord('db97531f-a864-4753-8420-1fdb9753eca8', 'DOGE/USD', 'buy', 0.05961, 91300, 0.0, 66),
    ],
  };

  function openOrders(connId: number): any[] {
    // Clone so callers that tag/mutate the array don't corrupt the source.
    return (ORDERS[connId] || []).map((o) => ({ ...o }));
  }

  // ── Transfer history ──────────────────────────────────────────────────────

  /** One transfer row, shaped exactly like the backend's serialised column set. */
  function xfer(connId: number, exchange: string, label: string, kind: 'deposit' | 'withdrawal',
                asset: string, amount: string, daysAgo: number, opts: {
                  fee?: string; status?: string; txid?: string | null;
                  network?: string; internal?: number | null;
                } = {}): any {
    const id = `${connId}-${kind}-${asset}-${daysAgo}`;
    return {
      id: Math.abs(hashId(id)),
      exchange_connection_id: connId,
      exchange_name: exchange,
      exchange_label: label,
      kind,
      external_id: id,
      txid: opts.txid === undefined ? `0x${hashHex(id)}` : opts.txid,
      network: opts.network || null,
      asset,
      amount,
      amount_num: Number(amount),
      fee_amount: opts.fee || null,
      fee_currency: opts.fee ? asset : null,
      status: opts.status || 'ok',
      address: null,
      tag: null,
      occurred_at: Math.floor((Date.now() - daysAgo * DAY) / 1000),
      usd_value: null,
      is_internal: opts.internal === undefined ? null : opts.internal,
    };
  }

  function hashId(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }

  function hashHex(s: string): string {
    return Math.abs(hashId(s)).toString(16).padStart(8, '0').repeat(5).slice(0, 40);
  }

  /** Assets and sizes deliberately track HOLDINGS/PRICE so the demo reads as one
   *  coherent account rather than four unrelated datasets. */
  const TRANSFERS: Record<number, any[]> = {
    [KRAKEN]: [
      xfer(KRAKEN, 'kraken', 'Main', 'deposit', 'BTC', '0.15', 210, { network: 'Bitcoin' }),
      xfer(KRAKEN, 'kraken', 'Main', 'deposit', 'USDT', '12000', 180, { network: 'Ethereum' }),
      xfer(KRAKEN, 'kraken', 'Main', 'withdrawal', 'BTC', '0.042', 96, { fee: '0.00015', network: 'Bitcoin' }),
      xfer(KRAKEN, 'kraken', 'Main', 'deposit', 'ETH', '3.5', 74, { network: 'Ethereum' }),
      xfer(KRAKEN, 'kraken', 'Main', 'withdrawal', 'XLM', '4200', 41, { fee: '0.00002', network: 'Stellar' }),
      xfer(KRAKEN, 'kraken', 'Main', 'deposit', 'SOL', '48.2', 27, { network: 'Solana' }),
      xfer(KRAKEN, 'kraken', 'Main', 'withdrawal', 'USDT', '3500', 12, { fee: '2.5', network: 'Tron' }),
      // Still settling — exercises the pending badge and the unsettled rewind.
      xfer(KRAKEN, 'kraken', 'Main', 'withdrawal', 'ETH', '1.2', 0.3, { fee: '0.0011', status: 'pending', network: 'Ethereum' }),
    ],
    [COINBASE]: [
      xfer(COINBASE, 'coinbase', 'Coinbase', 'deposit', 'USD', '5000', 150, { txid: null }),
      xfer(COINBASE, 'coinbase', 'Coinbase', 'deposit', 'ETH', '2.1', 118, { network: 'ethereum' }),
      // Coinbase <-> Advanced moves come back tagged internal for free.
      xfer(COINBASE, 'coinbase', 'Coinbase', 'withdrawal', 'USDC', '2500', 63, { txid: null, internal: 1 }),
      xfer(COINBASE, 'coinbase', 'Coinbase', 'deposit', 'USDC', '2500', 63, { txid: null, internal: 1 }),
      xfer(COINBASE, 'coinbase', 'Coinbase', 'withdrawal', 'BTC', '0.028', 22, { fee: '0.0001', network: 'bitcoin' }),
      xfer(COINBASE, 'coinbase', 'Coinbase', 'deposit', 'LINK', '310', 9, { network: 'ethereum' }),
    ],
    [BINANCE]: [
      xfer(BINANCE, 'binance', 'Binance', 'deposit', 'USDT', '8000', 165, { network: 'BSC' }),
      xfer(BINANCE, 'binance', 'Binance', 'deposit', 'DOGE', '91300', 88, { network: 'Dogecoin' }),
      xfer(BINANCE, 'binance', 'Binance', 'withdrawal', 'ADA', '15400', 52, { fee: '1.0', network: 'Cardano' }),
      xfer(BINANCE, 'binance', 'Binance', 'withdrawal', 'AVAX', '86.9', 31, { fee: '0.01', network: 'AVAX C-Chain' }),
      xfer(BINANCE, 'binance', 'Binance', 'deposit', 'ATOM', '540', 14, { network: 'Cosmos' }),
      xfer(BINANCE, 'binance', 'Binance', 'withdrawal', 'DOT', '1200', 5, { fee: '0.1', status: 'failed', network: 'Polkadot' }),
    ],
    // Robinhood has no transfer API — its rows stay empty on purpose so the
    // "not supported" notice has something to be true about.
    [ROBINHOOD]: [],
  };

  function transfers(connId: number | 'all' | null | undefined,
                     filters: any = {}): any {
    let rows = connId === undefined || connId === null || connId === 'all'
      ? Object.keys(TRANSFERS).flatMap((k) => TRANSFERS[Number(k)])
      : (TRANSFERS[Number(connId)] || []).slice();

    if (filters.kind) rows = rows.filter((r) => r.kind === filters.kind);
    if (filters.asset) rows = rows.filter((r) => r.asset === filters.asset);
    rows = rows.slice().sort((a, b) => b.occurred_at - a.occurred_at);

    const total = rows.length;
    const offset = Number(filters.offset || 0);
    const limit = Number(filters.limit || 100);
    return {
      items: rows.slice(offset, offset + limit).map((r) => ({ ...r })),
      total,
      limit,
      offset,
      sync: transferStatus(),
    };
  }

  function transferStatus(): any {
    const done = { state: 'idle', progress_pct: 100, backfill_complete: true,
                   last_sync_ok_at: Math.floor((Date.now() - 4 * MIN) / 1000),
                   age_seconds: 240, last_error: null };
    const none = { state: 'unsupported', progress_pct: 0 };
    return {
      any_pending: false,
      connections: [
        { connection_id: KRAKEN, exchange: 'kraken', label: 'Main', supported: true,
          kinds: { deposit: { ...done }, withdrawal: { ...done } } },
        { connection_id: COINBASE, exchange: 'coinbase', label: 'Coinbase', supported: true,
          kinds: { deposit: { ...done }, withdrawal: { ...done } } },
        { connection_id: BINANCE, exchange: 'binance', label: 'Binance', supported: true,
          kinds: { deposit: { ...done }, withdrawal: { ...done } } },
        { connection_id: ROBINHOOD, exchange: 'robinhood', label: 'Robinhood', supported: false,
          kinds: { deposit: { ...none }, withdrawal: { ...none } } },
      ],
    };
  }

  function transferAssets(): string[] {
    const seen = new Set<string>();
    Object.keys(TRANSFERS).forEach((k) => TRANSFERS[Number(k)].forEach((r) => seen.add(r.asset)));
    return Array.from(seen).sort();
  }

  /** Drop an order from the demo book so cancelling it looks like it worked. */
  function cancelOrder(connId: number, orderId: string): void {
    const book = ORDERS[connId];
    if (!book) return;
    const idx = book.findIndex((o) => o.id === orderId);
    if (idx >= 0) book.splice(idx, 1);
  }

  // ── Limit-order pair metadata ─────────────────────────────────────────────

  /** Quote currencies per connection. Enough variety to exercise the
   *  round-robin ladder, and Robinhood is USD-only so the single-pair path
   *  gets covered too. */
  const QUOTES: Record<number, string[]> = {
    [KRAKEN]: ['USD', 'USDC', 'USDT'],
    [COINBASE]: ['USD', 'USDC', 'USDT'],
    [BINANCE]: ['USDT', 'USDC'],
    [ROBINHOOD]: ['USD'],
  };

  /** Tick sizes scaled off the reference price, which is what real exchanges do
   *  in spirit: cheap coins are quoted in more decimals. SHIB at 2.48e-05 lands
   *  on a 1e-8 price tick and a whole-unit amount tick; BTC gets 0.01 / 1e-8. */
  function priceTickFor(price: number): number {
    if (price >= 100) return 0.01;
    if (price >= 1) return 0.0001;
    if (price >= 0.01) return 0.00001;
    return 1e-8;
  }

  function amountTickFor(price: number): number {
    if (price >= 1000) return 1e-8;
    if (price >= 1) return 0.001;
    if (price >= 0.01) return 0.1;
    return 1;
  }

  function tickDecimals(tick: number): number {
    if (Number.isInteger(tick)) return 0;
    const frac = tick.toFixed(18).replace(/0+$/, '').split('.')[1] || '';
    return frac.length;
  }

  function limitPairs(connId: number, asset: string): any {
    const quotes = QUOTES[connId] || ['USD'];
    const held = HOLDINGS[connId] || {};
    const base = (asset || '').toUpperCase();
    const price = PRICE[base];
    const priceTick = priceTickFor(price || 1);
    const amountTick = amountTickFor(price || 1);

    const list = price
      ? quotes
          .filter((quote) => quote !== base)
          .map((quote) => ({
            symbol: `${base}/${quote}`,
            base,
            quote,
            price_tick: priceTick,
            price_decimals: tickDecimals(priceTick),
            amount_tick: amountTick,
            amount_decimals: tickDecimals(amountTick),
            min_amount: amountTick * 10,
            max_amount: null,
            min_cost: 5,
            max_cost: null,
            stable_quote: true,
            price,
            available_base: held[base] || 0,
            available_quote: held[quote] || 0,
          }))
      : [];

    return {
      asset: base,
      side: null,
      exchange: EXCHANGE_OF[connId] || 'kraken',
      order_pacing_ms: connId === ROBINHOOD ? 600 : connId === KRAKEN ? 1000 : 250,
      supports_post_only: connId !== ROBINHOOD,
      pairs: list,
    };
  }

  /** Demo placement. Adds a real-looking row to the fake book so the order shows
   *  up in the table once the batch finishes, and rejects every 4th leg so the
   *  progress table's failure path is reachable without a live exchange.
   *  Deterministic on purpose — the same reason the OHLCV generator is seeded:
   *  a screenshot has to be reproducible. Balances are NOT decremented, which
   *  matches the rest of demo mode (saveAllocations is a no-op too). */
  let placeCount = 0;

  function createOrder(connId: number, order: any): any {
    placeCount++;
    if (placeCount % 4 === 0) {
      throw new Error(
        `${order.symbol} order rejected: size is below the exchange minimum.`);
    }
    const id = `DEMO-${String(placeCount).padStart(4, '0')}`;
    const book = ORDERS[connId] || (ORDERS[connId] = []);
    book.unshift({
      id,
      pair: order.symbol,
      type: 'limit',
      side: order.side,
      price: String(order.price),
      volume: String(order.amount),
      filled: '0.0',
      status: 'open',
      opentm: Date.now(),
    });
    return {
      id,
      symbol: order.symbol,
      side: order.side,
      type: 'limit',
      status: 'open',
      amount: order.amount,
      price: order.price,
      filled: 0,
      cost: order.amount * order.price,
      sent: { amount: order.amount, price: order.price },
    };
  }

  // ── Withdrawal addresses (Kraken supports them, Coinbase does not) ─────────

  const ADDRESSES: Record<number, any[]> = {
    [KRAKEN]: [
      { nickname_key: 'cold_storage_btc', asset: 'BTC', method: 'Bitcoin', address: 'bc1q9x8k2v7m4p3qz6r0t5n8w1y4u7s2d5f8g1h3j6' },
      { nickname_key: 'eth_ledger', asset: 'ETH', method: 'ERC20', address: '0x7a2F4c9B1e6D8a3C5f0B2e9A4d7C1f8E3b6D2a9C' },
      { nickname_key: 'sol_phantom', asset: 'SOL', method: 'Solana', address: '7vfBGpjZTEZEsKNi1ZdYYBPGq1uFzWvLuV6xRP13tSo9' },
      { nickname_key: 'atom_keplr', asset: 'ATOM', method: 'Cosmos', address: 'cosmos1x7v9k2m4p8q3z6r0t5n8w1y4u7s2d5f8g1h3j6' },
    ],
    [COINBASE]: [],
    [BINANCE]: [],
    [ROBINHOOD]: [],
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

  /** "When a coin grows past a share of the portfolio, trim it back." */
  function allocationRule(id: number, ex: number, asset: string, max: number, target: number,
                          to: string, active: boolean, trigCount: number, lastAgoMs: number,
                          dryRun = false): any {
    return {
      id, rule_name: `Balance ${asset} → ${to}`, is_active: active,
      trigger_type: 'allocation_threshold',
      trigger_asset: asset,
      trigger_allocation_percent: String(max),
      rebalance_target_percent: String(target),
      min_trade_usd: '25', dry_run: dryRun,
      cooldown_minutes: 1440,
      action_type: 'convert_crypto', action_asset: asset, convert_to_asset: to,
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
      // ── Kraken (convert or withdraw) ──
      priceRule(5001, 'Take profit: SOL to USDC', KRAKEN, 'SOL', '80', 'USDC', true, 'all', '', 3, null, 2 * HOUR),
      priceRule(5002, 'Take profit: BTC to USDC', KRAKEN, 'BTC', '68000', 'USDC', true, 'percent', '50', 1, 5, 20 * HOUR),
      priceRule(5003, 'Take profit: AAVE to USDC', KRAKEN, 'AAVE', '105', 'USDC', false, 'fixed', '4', 0, null, 0),
      balanceRule(5004, 'Stake-out: DOT to ETH', KRAKEN, 'DOT', '2600', 'ETH', true, 4, 120 * HOUR),
      orderRule(5005, 'Cold-store the BTC buy', KRAKEN, 'O7Q9SB-XGZJ3-BTC00', 'BTC', { addrKey: 'cold_storage_btc' }, true, 1, 84 * HOUR),
      orderRule(5006, 'Convert LINK fills to ETH', KRAKEN, 'OP8RAT-FYH2K-LIN08', 'LINK', { to: 'ETH' }, true, 2, 52 * HOUR),
      // ── Coinbase Advanced (convert only) ──
      priceRule(5007, 'Take profit: BTC to USDT', COINBASE, 'BTC', '68000', 'USDT', true, 'percent', '50', 1, 5, 20 * HOUR),
      priceRule(5008, 'Take profit: ETH to USDT', COINBASE, 'ETH', '1920', 'USDT', true, 'all', '', 0, null, 0),
      balanceRule(5009, 'Cash out DOGE to USDT', COINBASE, 'DOGE', '68000', 'USDT', true, 5, 12 * HOUR),
      balanceRule(5010, 'Cash out XRP to USDT', COINBASE, 'XRP', '2450', 'USDT', false, 0, 0),
      orderRule(5011, 'Convert LINK fills to ETH', COINBASE, 'ad0369cf-7ad0-447a-8147-e147ad03be14', 'LINK', { to: 'ETH' }, true, 3, 2 * HOUR),
      // ── Binance ──
      priceRule(5012, 'Take profit: SOL to USDT', BINANCE, 'SOL', '82', 'USDT', true, 'percent', '40', 2, null, 5 * HOUR),
      priceRule(5013, 'Take profit: INJ to USDT', BINANCE, 'INJ', '5.80', 'USDT', true, 'all', '', 1, 3, 18 * HOUR),
      balanceRule(5014, 'Sweep USDT into BTC', BINANCE, 'USDT', '4000', 'BTC', true, 1, 96 * HOUR),
      orderRule(5015, 'Convert TIA fills to BTC', BINANCE, '23014766', 'TIA', { to: 'BTC' }, true, 0, 0),
      // ── Robinhood ──
      priceRule(5016, 'Take profit: DOGE to USD', ROBINHOOD, 'DOGE', '0.083', 'USD', true, 'percent', '50', 2, null, 8 * HOUR),
      priceRule(5017, 'Take profit: SHIB to USD', ROBINHOOD, 'SHIB', '0.000006', 'USD', true, 'all', '', 1, null, 34 * HOUR),
      balanceRule(5018, 'Rotate XLM into BTC', ROBINHOOD, 'XLM', '5300', 'BTC', true, 3, 42 * HOUR),
      orderRule(5019, 'Convert LTC fills to USD', ROBINHOOD, '94fa50b6-61c7-43e9-80b6-d83e94faa50b', 'LTC', { to: 'USD' }, true, 1, 38 * HOUR),
      // ── Balancer caps (edited on the Balancer page, listed here like any rule) ──
      allocationRule(6001, KRAKEN, 'BTC', 30, 25, 'USDC', true, 2, 72 * HOUR, false),
      allocationRule(6002, KRAKEN, 'ETH', 22, 18, 'USDC', true, 1, 130 * HOUR, false),
      allocationRule(6003, KRAKEN, 'SOL', 12, 9, 'USDC', true, 0, 0, false),
      allocationRule(6004, COINBASE, 'BTC', 28, 24, 'USDT', true, 1, 96 * HOUR, false),
      allocationRule(6005, COINBASE, 'LINK', 18, 14, 'USDT', true, 1, 100 * HOUR, false),
      allocationRule(6006, BINANCE, 'BTC', 26, 22, 'USDT', true, 0, 0, false),
      allocationRule(6007, BINANCE, 'SOL', 15, 11, 'USDT', true, 2, 46 * HOUR, true),
      allocationRule(6008, ROBINHOOD, 'BTC', 32, 27, 'USD', true, 0, 0, false),
      allocationRule(6009, ROBINHOOD, 'DOGE', 12, 9, 'USD', true, 1, 54 * HOUR, false),
    ];
  }

  // ── Execution history (rule_id maps each log back to a rule above) ─────────

  function logs(): any[] {
    return [
      { rule_id: 5001, created_at: ago(35 * MIN), trigger_event: 'Price SOL/USD reached 80.55 >= target 80 (2x 1m candles since last check; now 79.90)', action_executed: 'Convert all (166 SOL) SOL -> USDC', action_result: 'Sold 166 SOL @ 80.15 USD -> 13304.9 USDC (closed)', status: 'success' },
      { rule_id: 6001, created_at: ago(52 * MIN), trigger_event: 'BTC = 41.90% of portfolio (cap 30%, total $99,518.00)', action_executed: 'Convert 0.1651 BTC -> USDC (trim 41.90% down to 25%, ~$10,487.00)', action_result: 'Sold 0.1651 BTC @ 63500 USD -> 10483.9 USDC (closed)', status: 'success' },
      { rule_id: 6007, created_at: ago(1 * HOUR), trigger_event: 'SOL = 13.60% of portfolio (cap 15%)', action_executed: 'Skipped', action_result: 'SOL is under its 15% cap, so nothing was sold.', status: 'skipped' },
      { rule_id: 5011, created_at: ago(2 * HOUR + 25 * MIN), trigger_event: 'Order c1f4a2b8... filled', action_executed: 'Convert 348 LINK -> ETH', action_result: 'Filled: received 1.53 ETH', status: 'success' },
      { rule_id: 5002, created_at: ago(4 * HOUR), trigger_event: 'Cooldown active', action_executed: 'Skipped', action_result: 'Waiting out the 24h cooldown since the last run before checking again.', status: 'skipped' },
      { rule_id: 5016, created_at: ago(8 * HOUR), trigger_event: 'Price DOGE/USD reached 0.08341 >= target 0.083 (1x 1m candles since last check; now 0.08152)', action_executed: 'Convert 50% (68500 DOGE) DOGE -> USD', action_result: 'Sold 68500 DOGE @ 0.08315 USD -> 5695.8 USD (closed)', status: 'success' },
      { rule_id: 5009, created_at: ago(12 * HOUR), trigger_event: 'Balance DOGE = 68400 >= threshold 68000', action_executed: 'Convert 68400 DOGE -> USDT', action_result: 'Filled: received 4797 USDT', status: 'success' },
      { rule_id: 5008, created_at: ago(15 * HOUR), trigger_event: 'Price ETH/USD = 1856.41, peak 1873.70 (target 1920)', action_executed: 'Skipped', action_result: 'Price has not reached the target since the last check, so this rule did not run. Needs ETH/USD at 1920 or higher - highest seen was 1873.70.', status: 'skipped' },
      { rule_id: 5013, created_at: ago(18 * HOUR), trigger_event: 'Price INJ/USDT reached 5.87 >= target 5.80 (4x 1m candles since last check; now 5.62)', action_executed: 'Convert all (331 INJ) INJ -> USDT', action_result: 'Sold 331 INJ @ 5.82 USDT -> 1926.4 USDT (closed)', status: 'success' },
      { rule_id: 6009, created_at: ago(20 * HOUR), trigger_event: 'DOGE = 27.50% of portfolio (cap 12%, total $34,879.00)', action_executed: 'Convert 91700 DOGE -> USD (trim 27.50% down to 9%, ~$6,432.00)', action_result: 'Sold 91700 DOGE @ 0.07015 USD -> 6432.8 USD (closed)', status: 'success' },
      { rule_id: 5007, created_at: ago(20 * HOUR + 10 * MIN), trigger_event: 'Price BTC/USDT reached 68170.00 >= target 68000 (2x 1m candles since last check; now 67660.00)', action_executed: 'Convert 50% (0.132 BTC) BTC -> USDT', action_result: 'Sold 0.132 BTC @ 68050 USDT -> 8982.6 USDT (closed)', status: 'success' },
      { rule_id: 5005, created_at: ago(22 * HOUR), trigger_event: 'Order OQ4F7K... filled', action_executed: 'Withdraw 0.16 BTC to cold_storage_btc (filled amount)', action_result: 'Withdrew 0.16 BTC to cold_storage_btc (success) [tx 9f2c...a71]', status: 'success' },
      { rule_id: 5015, created_at: ago(26 * HOUR), trigger_event: 'Order 62841057 filled', action_executed: 'Convert 3470 TIA -> BTC', action_result: 'Filled: received 0.0185 BTC', status: 'success' },
      { rule_id: 6003, created_at: ago(30 * HOUR), trigger_event: 'SOL = 12.20% of portfolio (cap 12%, total $99,518.00)', action_executed: 'Convert 4.35 SOL -> USDC (trim 12.20% down to 9%, ~$319.00)', action_result: 'Sold 4.35 SOL @ 73.30 USD -> 318.9 USDC (closed)', status: 'success' },
      { rule_id: 5017, created_at: ago(34 * HOUR), trigger_event: 'Price SHIB/USD reached 0.00000605 >= target 0.000006 (2x 1m candles since last check; now 0.00000501)', action_executed: 'Convert all (124000000 SHIB) SHIB -> USD', action_result: 'Sold 124000000 SHIB @ 0.000006 USD -> 744 USD (closed)', status: 'success' },
      { rule_id: 5019, created_at: ago(38 * HOUR), trigger_event: 'Order 3d7e91ab... filled', action_executed: 'Convert 11.4 LTC -> USD', action_result: 'Filled: received 503.5 USD', status: 'success' },
      { rule_id: 5018, created_at: ago(42 * HOUR), trigger_event: 'Balance XLM = 5330 >= threshold 5300', action_executed: 'Convert 5330 XLM -> BTC', action_result: 'Filled: received 0.0143 BTC', status: 'success' },
      { rule_id: 5012, created_at: ago(46 * HOUR), trigger_event: 'Price SOL/USDT reached 82.70 >= target 82 (1x 1m candles since last check; now 81.20)', action_executed: 'Convert 40% (37.3 SOL) SOL -> USDT', action_result: 'Sold 37.3 SOL @ 82.35 USDT -> 3071.7 USDT (closed)', status: 'success' },
      { rule_id: 5011, created_at: ago(52 * HOUR), trigger_event: 'Order OY7M2K... filled', action_executed: 'Convert 261 LINK -> ETH', action_result: 'Filled: received 1.15 ETH', status: 'success' },
      { rule_id: 6005, created_at: ago(72 * HOUR), trigger_event: 'LINK = 8.60% of portfolio (cap 18%)', action_executed: 'Skipped', action_result: 'LINK is under its 18% cap, so nothing was sold.', status: 'skipped' },
      { rule_id: 6002, created_at: ago(90 * HOUR), trigger_event: 'ETH = 22.40% of portfolio (cap 22%, total $97,900.00)', action_executed: 'Convert 2.32 ETH -> USDC (trim 22.40% down to 18%, ~$4,314.00)', action_result: 'Sold 2.32 ETH @ 1850 USD -> 4292 USDC (closed)', status: 'success' },
      { rule_id: 5014, created_at: ago(96 * HOUR), trigger_event: 'Balance USDT = 4000 >= threshold 4000', action_executed: 'Convert 4000 USDT -> BTC', action_result: 'Filled: received 0.063 BTC', status: 'success' },
      { rule_id: 6004, created_at: ago(96 * HOUR + 15 * MIN), trigger_event: 'BTC = 25.50% of portfolio (cap 28%)', action_executed: 'Skipped', action_result: 'BTC is under its 28% cap, so nothing was sold.', status: 'skipped' },
      { rule_id: 5004, created_at: ago(120 * HOUR), trigger_event: 'Balance DOT = 2630 >= threshold 2600', action_executed: 'Convert 2630 DOT -> ETH', action_result: 'Filled: received 1.17 ETH', status: 'success' },
      { rule_id: 5010, created_at: ago(128 * HOUR), trigger_event: 'Order filled but conversion rejected', action_executed: 'Convert 2470 XRP -> USDT', action_result: 'Failed: amount below exchange minimum', status: 'error' },
    ];
  }

  function withdrawalMinimums(): Record<string, number> {
    // Superset covering every asset that appears anywhere in the demo.
    return {
      BTC: 0.0001, ETH: 0.0001, SOL: 0.01, ADA: 1, LINK: 0.01, XRP: 0.02,
      DOGE: 1, AVAX: 0.01, DOT: 0.1, LTC: 0.001, POL: 0.1, ATOM: 0.01,
      UNI: 0.01, USDC: 0.01, USDT: 0.01, XLM: 0.1, FIL: 0.1, AAVE: 0.01,
      NEAR: 0.1, OP: 0.1, GRT: 1, ARB: 0.1, INJ: 0.01, SUI: 0.1, TIA: 0.1,
      FET: 1, BCH: 0.001, ALGO: 1, RENDER: 0.1, SHIB: 100000, ETC: 0.01,
      HBAR: 1, IMX: 0.1, PEPE: 100000, MKR: 0.001, DAI: 0.1,
    };
  }

  // ── Watchlist (mutable for the session so add/remove feels real) ───────────

  let watchSymbols = ['BTC/USD', 'ETH/USD', 'SOL/USD', 'LINK/USD', 'AVAX/USD',
                      'INJ/USD', 'TIA/USD', 'RENDER/USD', 'DOGE/USD', 'XRP/USD',
                      'SUI/USD', 'FET/USD'];

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
    const bases = ['BTC', 'ETH', 'SOL', 'ADA', 'LINK', 'XRP', 'DOGE', 'AVAX', 'DOT', 'LTC', 'POL', 'ATOM', 'UNI'];
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
      email_notifications_enabled: false,
      notify_email: null,
      smtp_password_set: false,
      smtp_host: null,
      smtp_port: null,
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
    tradableAssets,
    portfolio,
    holdings,
    assetDetail,
    allocations,
    openOrders,
    transfers,
    transferStatus,
    transferAssets,
    cancelOrder,
    limitPairs,
    createOrder,
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
      // Cancelling is the one write the demo honours — it only removes a row
      // from the fake order book, and a no-op would leave the order on screen.
      [ExchangeController, 'cancelOrder', async (id: number, orderId: string) => {
        DemoData.cancelOrder(id, orderId);
        return { id: orderId, status: 'canceled' };
      }],
      [ExchangeController, 'getPairs', async (id: number, asset: string) => DemoData.limitPairs(id, asset)],
      [TransferController, 'getTransfers', async (filters: any = {}) =>
        DemoData.transfers(filters.connId, filters)],
      [TransferController, 'getStatus', async () => DemoData.transferStatus()],
      [TransferController, 'getAssets', async () => DemoData.transferAssets()],
      // Nothing to sync against — report an instantly-complete pass so the
      // page's backfill loop terminates on its first round.
      [TransferController, 'sync', async () => ({
        complete: true, new_rows: 0, already_running: false, sync: DemoData.transferStatus(),
      })],
      // Placement is honoured for the same reason as cancelling: it only writes
      // to the fake order book, and a no-op would make the ladder look broken.
      [ExchangeController, 'createOrder', async (id: number, order: any) => DemoData.createOrder(id, order)],
      [ExchangeController, 'getWithdrawalAddresses', async (id: number) => DemoData.withdrawalAddresses(id)],
      [ExchangeController, 'getBalance', async (id: number) => DemoData.balance(id)],
      [ExchangeController, 'getPortfolio', async (id: number) => DemoData.portfolio(id)],
      [ExchangeController, 'getTradableAssets', async (id: number) => DemoData.tradableAssets(id)],

      [AutomationController, 'getRules', async () => DemoData.rules()],
      [AutomationController, 'getAllocations', async (id: number) => DemoData.allocations(id)],
      // Demo mode is read-only: accept the save so the page behaves, change nothing.
      [AutomationController, 'saveAllocations', async () => ({})],
      [AutomationController, 'getLogs', async (limit?: number) => DemoData.logs().slice(0, limit ?? 100)],
      [AutomationController, 'getWithdrawalMinimums', async () => DemoData.withdrawalMinimums()],
      [AutomationController, 'getWorkerStatus', async () => ({
        state: 'healthy', healthy: true, running: true, poll_interval: 60,
        started_at: Date.now() / 1000 - 3600,
        last_cycle_completed_at: Date.now() / 1000 - 5,
        age_seconds: 5, cycle_count: 60, last_error: null,
      })],

      [UserController, 'getProfile', async () => DemoData.profile()],

      [WatchlistData, 'getWatchlist', async () => DemoData.wrap(DemoData.watchlist())],
      [WatchlistData, 'addToWatchlist', async (_t: string, s: string) => { DemoData.addWatch(s); return DemoData.wrap({}); }],
      [WatchlistData, 'removeFromWatchlist', async (_t: string, s: string) => { DemoData.removeWatch(s); return DemoData.wrap({}); }],
      [WatchlistData, 'updateOrder', async () => DemoData.wrap({})],

      [MarketData, 'getPairs', async () => DemoData.wrap(DemoData.pairs())],
      [MarketData, 'getOHLCV', async (_t: string, sym: string, range: string) => DemoData.wrap(DemoData.ohlcv(sym, range))],
      [MarketData, 'getTicker', async (_t: string, sym: string) => DemoData.wrap(DemoData.ticker(sym))],
      [MarketData, 'getHoldings', async (_t: string, connId: number | 'all') => DemoData.wrap(DemoData.holdings(connId))],
      [MarketData, 'getAssetDetail', async (_t: string, sym: string) => DemoData.wrap(DemoData.assetDetail(sym))],
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
