"""Registry of supported exchanges and convenience helpers.

Provides metadata about each exchange the app officially supports and a
helper that loads a user's exchange connection from the DB and returns a
ready-to-use ``ccxt.Exchange`` instance.
"""

import time

from helper.Security import decrypt_api_key
from helper.Helper import execute_query_one
from helper.ExchangeClient import create_exchange


# ---------------------------------------------------------------------------
# Supported exchanges
# ---------------------------------------------------------------------------


def _days_ago(days: int) -> int:
    """A history epoch for exchanges that only keep a recent window of fills.

    Computed at startup; the sync only uses it for a connection's first pass.
    """
    return int(time.time()) - days * 86400


SUPPORTED_EXCHANGES: dict[str, dict] = {
    'kraken': {
        'name': 'Kraken',
        'ccxt_id': 'kraken',
        'requires_passphrase': False,
        'has_withdrawal_addresses': True,
        'supports_withdraw': True,
        # Portfolio balancer: needs USD-priceable balances plus market orders.
        'supports_rebalance': True,
        # Kraken's private call-rate counter is the real constraint here, and
        # 1s between orders is what it sustains. See ORDER_PACING notes below.
        'order_pacing_ms': 1000,
        'supports_transfer_history': True,
        'transfer_history': {
            'source': 'transactions',
            'window_seconds': 365 * 86400,
            # DepositStatus/WithdrawStatus return ~500 rows without a cursor;
            # treat anything at or above this as an overflowed window.
            'page_cap': 450,
            'history_epoch': 1420070400,   # 2015-01-01
            # Funding endpoints cost 2-3 units of Kraken's call-rate counter,
            # so they need more room than the 1000ms used for order entry.
            'page_pacing_ms': 1200,
        },
        # TradesHistory returns every pair at once but only 50 rows a call,
        # newest first, so each time window is paged with `ofs` until a short
        # page comes back. ccxt maps `until` to the endpoint's `end`.
        'supports_trade_history': True,
        'trade_history': {
            'strategy': 'window',
            'paging': 'ofs',
            'window_seconds': 90 * 86400,
            'page_cap': 50,
            'history_epoch': 1420070400,   # 2015-01-01
            # TradesHistory costs 2 units of the call-rate counter.
            'page_pacing_ms': 2000,
        },
        'has_sandbox': False,
        'website': 'https://www.kraken.com',
        'api_key_url': 'https://www.kraken.com/u/security/api',
        'guide_url': 'https://support.kraken.com/articles/360000919966-how-to-create-an-api-key',
    },
    'coinbase': {
        'name': 'Coinbase Advanced',
        # CCXT serves the Coinbase Advanced Trade API through the 'coinbase'
        # class; 'coinbaseadvanced' is not a registered ccxt id (getattr would
        # return None and every Coinbase connection would fail to build).
        'ccxt_id': 'coinbase',
        'requires_passphrase': False,
        'has_withdrawal_addresses': False,
        'supports_withdraw': False,
        'supports_rebalance': True,
        'order_pacing_ms': 250,
        'supports_transfer_history': True,
        # Coinbase is the odd one out. ``fetch_deposits``/``fetch_withdrawals``
        # hit the v2 fiat rails and explicitly do NOT return crypto ("Won't
        # return crypto deposits ... Use fetchLedger for those" — ccxt's own
        # docstring), so the ledger is the only route to a crypto transfer.
        # Every Coinbase entry point also runs through
        # ``prepare_account_request_with_currency_code``, which demands either a
        # currency code or an account_id, so there is no "all transfers" call:
        # the sync resolves account ids once and walks them.
        'transfer_history': {
            'source': 'ledger',
            'window_seconds': None,        # cursor-paged, no server-side time filter
            'page_cap': 100,               # v2 transactions hard max
            'history_epoch': 1370044800,   # 2013-06-01
            'page_pacing_ms': 350,
        },
        # Advanced Trade's historical fills endpoint takes no symbol and
        # accepts start/end times, so it walks time windows like Kraken, with
        # ccxt following the response cursor inside each window. page_cap is
        # ccxt's per-call size (250) times paginationCalls: a window returning
        # that many was probably truncated and is halved.
        'supports_trade_history': True,
        'trade_history': {
            'strategy': 'window',
            'paging': 'paginate',
            'pagination_calls': 20,
            'window_seconds': 30 * 86400,
            'page_cap': 5000,
            'history_epoch': 1370044800,   # 2013-06-01
            'page_pacing_ms': 350,
        },
        'has_sandbox': False,
        'website': 'https://www.coinbase.com',
        'api_key_url': 'https://www.coinbase.com/settings/api',
        'guide_url': 'https://docs.cdp.coinbase.com/exchange/introduction/rest-quickstart',
    },
    'binance': {
        'name': 'Binance',
        'ccxt_id': 'binance',
        'requires_passphrase': False,
        'has_withdrawal_addresses': False,
        'supports_withdraw': False,
        'supports_rebalance': True,
        'order_pacing_ms': 250,
        'supports_transfer_history': True,
        # No ledger fallback here: binance.fetch_ledger raises NotSupported for
        # spot wallets even though has['fetchLedger'] is True, so the deposit /
        # withdrawal endpoints are the only option. ccxt itself clamps
        # ``endTime = since + 90d``, hence the 89-day window.
        'transfer_history': {
            'source': 'transactions',
            'window_seconds': 89 * 86400,
            'page_cap': 1000,
            'history_epoch': 1498867200,   # 2017-07-01, Binance launch
            'page_pacing_ms': 500,
        },
        # myTrades demands a symbol, and a startTime/endTime pair may span at
        # most 24 hours, so the sync walks each candidate symbol by fromId
        # (trade id) instead of by time. See TradeSync._candidate_symbols.
        'supports_trade_history': True,
        'trade_history': {
            'strategy': 'per_symbol',
            'page_cap': 1000,
            'history_epoch': 1498867200,   # 2017-07-01
            'page_pacing_ms': 300,
        },
        'has_sandbox': False,
        'website': 'https://www.binance.com',
        'api_key_url': 'https://www.binance.com/en/my/settings/api-management',
        'guide_url': 'https://www.binance.com/en/support/faq/how-to-create-api-keys-on-binance-360002502072',
    },
    'gemini': {
        'name': 'Gemini (Beta)',
        'ccxt_id': 'gemini',
        'requires_passphrase': False,
        # Gemini can withdraw to approved addresses (Fund Manager role), but
        # the auto-withdraw flow is built around Kraken's address book, so it
        # stays convert-only for now.
        'has_withdrawal_addresses': False,
        'supports_withdraw': False,
        # The API has no market orders. convert() places an immediate-or-cancel
        # limit order priced through the book instead (see _ioc_convert).
        'supports_rebalance': True,
        # Private API allows 600 requests/minute, but order entry is advised
        # at no more than 5/s, so 250ms leaves headroom.
        'order_pacing_ms': 250,
        'supports_transfer_history': True,
        # /v1/transfers returns deposits AND withdrawals together, at most 50
        # a call, with no end-time parameter. It is walked forward by
        # timestamp: each page's newest row + 1ms is the next page's start.
        'transfer_history': {
            'source': 'combined',
            'window_seconds': None,
            'page_cap': 50,
            'history_epoch': 1443657600,   # 2015-10-01, Gemini launch
            'page_pacing_ms': 500,
        },
        # /v1/mytrades needs a symbol, so like Binance each candidate market
        # is walked on its own, but paged by timestamp (Gemini's documented
        # scheme: start at 0, then newest timestamp + 1) instead of trade id.
        'supports_trade_history': True,
        'trade_history': {
            'strategy': 'per_symbol',
            'paging': 'timestamp',
            'quotes': ('USD', 'GUSD', 'USDC', 'USDT', 'BTC', 'ETH', 'EUR', 'GBP', 'SGD'),
            'page_cap': 500,
            'history_epoch': 1443657600,   # 2015-10-01
            'page_pacing_ms': 300,
        },
        'has_sandbox': True,
        'website': 'https://www.gemini.com',
        'api_key_url': 'https://exchange.gemini.com/settings/api',
        # The key needs the Trader role (Gemini's default): balances, orders
        # and trade history. Auditor keys are read-only and can't trade.
        'guide_url': 'https://developer.gemini.com/roles',
    },
    'robinhood': {
        'name': 'Robinhood',
        'ccxt_id': None,  # Direct API via RobinhoodAdapter — not CCXT-based
        'requires_passphrase': False,
        'has_withdrawal_addresses': False,  # no withdrawal API
        'supports_withdraw': False,         # market-order (convert) only
        # Rebalancing works, but Robinhood has no bulk-ticker endpoint, so
        # pricing the portfolio costs one request per held asset per cycle.
        'supports_rebalance': True,
        # 100 requests/minute sustained (~1.67 tokens/s refill), and each
        # placement costs a signed request or two, so 600ms is the sustainable
        # floor rather than a guess.
        'order_pacing_ms': 600,
        # No funding-history API at all, and the adapter doesn't duck-type
        # fetch_deposits/fetch_withdrawals/fetch_ledger — calling one raises a
        # bare AttributeError rather than anything ccxt-shaped.
        'supports_transfer_history': False,
        'transfer_history': None,
        # No fills endpoint; each filled order becomes one synthetic trade at
        # its average price. The adapter already pages through every result.
        'supports_trade_history': True,
        'trade_history': {
            'strategy': 'orders',
            'page_cap': 0,
            'history_epoch': 1514764800,   # 2018-01-01
            'page_pacing_ms': 0,
        },
        # Robinhood issues no secret: the user generates an Ed25519 keypair,
        # registers the public half, and pastes the private half here. The
        # Profile page offers a key generator when this is set.
        'needs_generated_keypair': True,
        'has_sandbox': False,
        'website': 'https://robinhood.com',
        'api_key_url': 'https://robinhood.com/account/crypto',
        'guide_url': 'https://docs.robinhood.com/crypto/trading/',
    },
    'okx': {
        'name': 'OKX (Beta)',
        'ccxt_id': 'okx',
        # OKX API keys come with a passphrase chosen when the key is created.
        'requires_passphrase': True,
        'has_withdrawal_addresses': False,
        'supports_withdraw': False,
        'supports_rebalance': True,
        # Order placement allows 60 requests / 2s per instrument.
        'order_pacing_ms': 250,
        'supports_transfer_history': True,
        # Deposit and withdrawal history take begin/end timestamps and return
        # at most 100 rows a call; a full window is bisected by the sync.
        'transfer_history': {
            'source': 'transactions',
            'window_seconds': 90 * 86400,
            'page_cap': 100,
            'history_epoch': 1483228800,   # 2017-01-01, OKX launch
            'page_pacing_ms': 400,
        },
        # fills-history takes no symbol (instType SPOT), honours begin/end, and
        # ccxt pages it dynamically. OKX only keeps the last three months there,
        # so the walk starts there rather than at the launch date.
        'supports_trade_history': True,
        'trade_history': {
            'strategy': 'window',
            'paging': 'paginate',
            'pagination_calls': 20,
            'window_seconds': 30 * 86400,
            'page_cap': 2000,              # 100 a call x 20 calls
            'history_epoch': _days_ago(90),
            'page_pacing_ms': 350,
        },
        # Demo trading: separate demo-account API keys, same endpoints.
        'has_sandbox': True,
        'website': 'https://www.okx.com',
        'api_key_url': 'https://www.okx.com/account/my-api',
        'guide_url': 'https://www.okx.com/help/how-can-i-do-an-api-trading',
    },
    'kucoin': {
        'name': 'KuCoin (Beta)',
        'ccxt_id': 'kucoin',
        # KuCoin API keys come with a passphrase chosen when the key is created.
        'requires_passphrase': True,
        'has_withdrawal_addresses': False,
        'supports_withdraw': False,
        'supports_rebalance': True,
        # Spot order entry is weight-limited per 30s window; 300ms is well
        # inside it for a ladder.
        'order_pacing_ms': 300,
        # Not yet: KuCoin's "high-frequency" accounts (most accounts now) only
        # return fills one market at a time, a week per query, and deposit /
        # withdrawal history has its own short ranges. Until that's built and
        # tested against a real account, the Taxes and Transfers pages say so
        # rather than show a partial history.
        'supports_transfer_history': False,
        'transfer_history': None,
        'supports_trade_history': False,
        'trade_history': None,
        # KuCoin retired its public sandbox.
        'has_sandbox': False,
        'website': 'https://www.kucoin.com',
        'api_key_url': 'https://www.kucoin.com/account/api',
        'guide_url': 'https://www.kucoin.com/support/360015102174',
    },
    'cryptocom': {
        # The Crypto.com Exchange (exchange.crypto.com), which is where API keys
        # come from. Coins held in the Crypto.com App have no API.
        'name': 'Crypto.com Exchange (Beta)',
        'ccxt_id': 'cryptocom',
        'requires_passphrase': False,
        'ccxt_options': {'defaultType': 'spot'},
        'has_withdrawal_addresses': False,
        'supports_withdraw': False,
        'supports_rebalance': True,
        # Order entry: 15 requests / 100ms on create-order; 250ms is generous.
        'order_pacing_ms': 250,
        'supports_transfer_history': True,
        # Deposit / withdrawal history take start/end timestamps.
        'transfer_history': {
            'source': 'transactions',
            'window_seconds': 30 * 86400,
            'page_cap': 100,
            'history_epoch': 1572566400,   # 2019-11-01, Exchange launch
            'page_pacing_ms': 400,
        },
        # get-trades takes no symbol, but a start/end pair may span at most a
        # day, so the walk is a day at a time (ccxt pages inside each day).
        # Cyrus reads the last six months; older purchases are added by hand.
        'supports_trade_history': True,
        'trade_history': {
            'strategy': 'window',
            'paging': 'paginate',
            'pagination_calls': 10,
            'window_seconds': 86400,
            'page_cap': 1000,              # 100 a call x 10 calls
            'history_epoch': _days_ago(180),
            'page_pacing_ms': 300,
        },
        'has_sandbox': False,
        'website': 'https://crypto.com/exchange',
        'api_key_url': 'https://crypto.com/exchange/user/settings/api-management',
        'guide_url': 'https://exchange-docs.crypto.com/exchange/v1/rest-ws/index.html',
    },
    'gate': {
        'name': 'Gate.io (Beta)',
        'ccxt_id': 'gate',
        'requires_passphrase': False,
        # Spot only, and only spot markets loaded (the full list, futures and
        # options included, takes ~15s to load).
        'ccxt_options': {'defaultType': 'spot', 'fetchMarkets': {'types': ['spot']}},
        'has_withdrawal_addresses': False,
        'supports_withdraw': False,
        'supports_rebalance': True,
        # Spot order entry: 10 requests/s per pair.
        'order_pacing_ms': 250,
        'supports_transfer_history': True,
        # Deposits / withdrawals: from/to may span at most 30 days.
        'transfer_history': {
            'source': 'transactions',
            'window_seconds': 30 * 86400,
            'page_cap': 100,
            'history_epoch': 1514764800,   # 2018-01-01
            'page_pacing_ms': 400,
        },
        # Spot my_trades: no symbol needed, from/to may span at most 30 days.
        'supports_trade_history': True,
        'trade_history': {
            'strategy': 'window',
            'paging': 'paginate',
            'pagination_calls': 10,
            'window_seconds': 30 * 86400,
            'page_cap': 1000,              # 100 a call x 10 calls
            'history_epoch': 1514764800,   # 2018-01-01
            'page_pacing_ms': 300,
        },
        'has_sandbox': False,
        'website': 'https://www.gate.io',
        'api_key_url': 'https://www.gate.io/myaccount/api_key_manage',
        'guide_url': 'https://www.gate.io/docs/developers/apiv4/',
    },
}

# Minimum withdrawal amounts per exchange per asset (with a 10% safety cushion).
# Not all of these are available through CCXT, so we maintain them manually.
WITHDRAWAL_MINIMUMS: dict[str, dict[str, float]] = {
    'kraken': {
        # CCXT normalizes Kraken's XXBT to the unified code 'BTC' (balances and
        # rules use 'BTC'), so this key must be 'BTC' or the minimum-withdrawal
        # guard never matches for Bitcoin.
        'BTC': 0.00022,    'ETH': 0.00022,    'SOL': 0.011,
        'ADA': 5,           'DOT': 1,           'POL': 7,
        'AVAX': 0.50,       'ATOM': 1.00,       'LINK': 0.060,
        'XRP': 12,          'XLM': 25,          'LTC': 0.0100,
        'BCH': 0.00060,     'ETC': 0.014,       'DOGE': 50,
        'SHIB': 135799,     'TRX': 20,          'ALGO': 1.00,
        'FIL': 0.100,       'LUNA2': 0.50,      'LUNA': 50000,
        'USDT': 0.86,       'USDC': 0.87,       'DAI': 0.72,
        'UNI': 0.23,        'AAVE': 0.0086,     'CRV': 2,
        'SNX': 6,           'COMP': 0.050,      'SUSHI': 4,
        'YFI': 0.00032,     '1INCH': 6,         'BAL': 6,
        'LDO': 2,           'APE': 8,           'SAND': 6,
        'MANA': 9,          'GALA': 295,        'AXS': 0.70,
        'ENJ': 8,           'GRT': 29,          'FET': 6,
        'RENDER': 0.38,
    },
    'coinbase': {
        'BTC': 0.0001,     'ETH': 0.0001,     'SOL': 0.010,
        'ADA': 1.0,        'XRP': 0.02,       'LTC': 0.001,
        'DOGE': 1.0,       'SHIB': 100000,    'AVAX': 0.01,
        'MATIC': 0.1,      'LINK': 0.01,      'UNI': 0.01,
        'USDC': 0.01,      'USDT': 0.01,      'DAI': 0.1,
        'DOT': 0.1,        'ATOM': 0.01,      'ALGO': 0.1,
    },
    'binance': {
        'BTC': 0.00050,    'ETH': 0.0010,     'BNB': 0.010,
        'SOL': 0.010,      'XRP': 0.10,       'ADA': 2.0,
        'DOGE': 10.0,      'AVAX': 0.010,     'DOT': 0.10,
        'MATIC': 0.10,     'LINK': 0.010,     'ATOM': 0.010,
        'LTC': 0.0010,     'UNI': 0.010,      'SHIB': 100000,
        'TRX': 1.0,        'ALGO': 1.0,       'USDT': 1.0,
        'USDC': 1.0,       'DAI': 10.0,
    },
}

MINIMUM_WITHDRAWAL_CUSHION = 1.10

# Fallback pacing for an exchange with no explicit `order_pacing_ms`. Chosen
# pessimistically: too slow only costs the user time, too fast trips a throttle
# part-way through a ladder.
DEFAULT_ORDER_PACING_MS = 1000

# Assets the portfolio balancer offers as a destination for trimmed positions.
# Filtered per position against the exchange's actual market list, so a target
# only appears when there's a tradable pair for it.
REBALANCE_TARGET_CANDIDATES: list[str] = [
    'USD', 'USDC', 'USDT', 'DAI', 'BTC', 'ETH',
]


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------

def get_supported_exchanges() -> list[dict]:
    """Return a list of exchange metadata dicts suitable for the API."""
    return [
        {
            'id': key,
            'name': meta['name'],
            'requires_passphrase': meta['requires_passphrase'],
            'has_withdrawal_addresses': meta['has_withdrawal_addresses'],
            'supports_withdraw': meta.get('supports_withdraw', False),
            'supports_rebalance': meta.get('supports_rebalance', False),
            'supports_transfer_history': meta.get('supports_transfer_history', False),
            'supports_trade_history': meta.get('supports_trade_history', False),
            'order_pacing_ms': meta.get('order_pacing_ms', DEFAULT_ORDER_PACING_MS),
            'needs_generated_keypair': meta.get('needs_generated_keypair', False),
            'has_sandbox': meta.get('has_sandbox', False),
            'website': meta.get('website', ''),
            'api_key_url': meta.get('api_key_url', ''),
            'guide_url': meta.get('guide_url', ''),
        }
        for key, meta in SUPPORTED_EXCHANGES.items()
    ]


def get_minimum_withdrawal(exchange_name: str, asset: str) -> float:
    """Return the minimum withdrawal for *asset* on *exchange_name* with cushion."""
    minimums = WITHDRAWAL_MINIMUMS.get(exchange_name, {})
    base = minimums.get(asset, 0)
    return base * MINIMUM_WITHDRAWAL_CUSHION if base > 0 else 0


def supports_rebalance(exchange_name: str) -> bool:
    """True when the balancer can operate on *exchange_name*."""
    return SUPPORTED_EXCHANGES.get(exchange_name, {}).get('supports_rebalance', False)


def supports_transfer_history(exchange_name: str) -> bool:
    """True when deposit/withdrawal history can be read for *exchange_name*.

    Advisory only — it says the exchange has an endpoint worth calling, not
    that this user's API key carries the permission to call it. Kraken needs
    "Query Funds", Binance needs "Enable Reading", and existing Cyrus keys were
    only ever validated against ``fetch_balance``, so a key that trades fine can
    still be rejected here. The sync catches that and records it per connection.
    """
    return SUPPORTED_EXCHANGES.get(exchange_name, {}).get('supports_transfer_history', False)


def get_transfer_history_config(exchange_name: str) -> dict | None:
    """Windowing/pacing metadata for *exchange_name*'s transfer history.

    ``source`` selects the fetch strategy — ``'transactions'`` for the
    deposit/withdrawal endpoints, ``'ledger'`` for Coinbase's per-account walk.
    Returns None when the exchange has no transfer history at all.
    """
    return SUPPORTED_EXCHANGES.get(exchange_name, {}).get('transfer_history')


def supports_trade_history(exchange_name: str) -> bool:
    """True when executed fills can be read for *exchange_name*.

    Advisory in the same way as :func:`supports_transfer_history`: the key may
    still lack the read permission, which the sync records per connection.
    """
    return SUPPORTED_EXCHANGES.get(exchange_name, {}).get('supports_trade_history', False)


def get_trade_history_config(exchange_name: str) -> dict | None:
    """Fetch-strategy/pacing metadata for *exchange_name*'s fill history.

    ``strategy`` is ``'window'`` (one call returns every pair, walked forward
    through time windows, paged by ``paging``), ``'per_symbol'`` (Binance and
    Gemini — one walk per market, by trade id or by timestamp per ``paging``) or
    ``'orders'`` (Robinhood — filled orders stand in for fills).
    """
    return SUPPORTED_EXCHANGES.get(exchange_name, {}).get('trade_history')


def get_order_pacing_ms(exchange_name: str) -> int:
    """Recommended delay between consecutive order placements, in milliseconds.

    Deliberately NOT ccxt's ``rateLimit``. That number is the generic REST weight
    budget — Coinbase reports 34ms and Binance 50ms — but both exchanges throttle
    *order entry* far more tightly than general requests, so pacing a ladder off
    it would trip an order-rate limit rather than the weight limit. It also has
    no answer at all for Robinhood, which isn't a ccxt exchange.

    Callers multiply this by the rung count for a duration estimate and use it as
    the loop delay, so it must be the *sustainable* rate: a ladder that starts
    fast and then eats 429 back-offs is both slower and more alarming than one
    that paces itself from the start.
    """
    meta = SUPPORTED_EXCHANGES.get(exchange_name, {})
    return int(meta.get('order_pacing_ms') or DEFAULT_ORDER_PACING_MS)


def get_all_minimums(exchange_name: str) -> dict[str, float]:
    """Return all minimum withdrawals (with cushion) for an exchange."""
    raw = WITHDRAWAL_MINIMUMS.get(exchange_name, {})
    return {asset: base * MINIMUM_WITHDRAWAL_CUSHION for asset, base in raw.items() if base > 0}


def get_user_exchange(user_id: int, connection_id: int):
    """Load a user's exchange connection from DB and return a ccxt.Exchange.

    Raises ``ValueError`` if the connection doesn't exist or doesn't belong
    to the user.
    """
    row = execute_query_one(
        'SELECT * FROM exchange_connections WHERE id = ? AND user_id = ?',
        (connection_id, user_id),
    )
    if not row:
        raise ValueError('Exchange connection not found')

    exchange_name = row['exchange_name']
    if exchange_name not in SUPPORTED_EXCHANGES:
        raise ValueError(f'Unsupported exchange: {exchange_name}')

    api_key = decrypt_api_key(row['api_key_encrypted'])
    private_key = decrypt_api_key(row['private_key_encrypted'])

    if exchange_name == 'robinhood':
        from helper.robinhood.adapter import RobinhoodAdapter
        return RobinhoodAdapter(api_key=api_key, private_key_b64=private_key)

    meta = SUPPORTED_EXCHANGES[exchange_name]
    passphrase = decrypt_api_key(row['passphrase_encrypted']) if row.get('passphrase_encrypted') else None
    sandbox = bool(row.get('is_sandbox', False))
    return create_exchange(meta['ccxt_id'], api_key, private_key, passphrase, sandbox,
                           options=meta.get('ccxt_options'))


def get_connection_row(user_id: int, connection_id: int) -> dict | None:
    """Return the raw exchange_connections row (or None)."""
    return execute_query_one(
        'SELECT * FROM exchange_connections WHERE id = ? AND user_id = ?',
        (connection_id, user_id),
    )
