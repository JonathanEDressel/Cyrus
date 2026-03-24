"""Registry of supported exchanges and convenience helpers.

Provides metadata about each exchange the app officially supports and a
helper that loads a user's exchange connection from the DB and returns a
ready-to-use ``ccxt.Exchange`` instance.
"""

from helper.Security import decrypt_api_key
from helper.Helper import execute_query_one
from helper.ExchangeClient import create_exchange


# ---------------------------------------------------------------------------
# Supported exchanges
# ---------------------------------------------------------------------------

SUPPORTED_EXCHANGES: dict[str, dict] = {
    'kraken': {
        'name': 'Kraken',
        'ccxt_id': 'kraken',
        'requires_passphrase': False,
        'has_withdrawal_addresses': True,
        'has_sandbox': False,
        'website': 'https://www.kraken.com',
        'api_key_url': 'https://www.kraken.com/u/security/api',
    },
    'coinbase': {
        'name': 'Coinbase Advanced (Beta)',
        'ccxt_id': 'coinbaseadvanced',
        'requires_passphrase': False,
        'has_withdrawal_addresses': False,
        'has_sandbox': False,
        'website': 'https://www.coinbase.com',
        'api_key_url': 'https://www.coinbase.com/settings/api',
    },
    # 'binance': {
    #     'name': 'Binance',
    #     'ccxt_id': 'binance',
    #     'requires_passphrase': False,
    #     'has_withdrawal_addresses': False,
    #     'website': 'https://www.binance.com',
    #     'api_key_url': 'https://www.binance.com/en/my/settings/api-management',
    # },
}

# Minimum withdrawal amounts per exchange per asset (with a 10% safety cushion).
# Not all of these are available through CCXT, so we maintain them manually.
WITHDRAWAL_MINIMUMS: dict[str, dict[str, float]] = {
    'kraken': {
        'XBT': 0.00022,    'ETH': 0.00022,    'SOL': 0.011,
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
}

MINIMUM_WITHDRAWAL_CUSHION = 1.10


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
            'has_sandbox': meta.get('has_sandbox', False),
            'website': meta.get('website', ''),
            'api_key_url': meta.get('api_key_url', ''),
        }
        for key, meta in SUPPORTED_EXCHANGES.items()
    ]


def get_minimum_withdrawal(exchange_name: str, asset: str) -> float:
    """Return the minimum withdrawal for *asset* on *exchange_name* with cushion."""
    minimums = WITHDRAWAL_MINIMUMS.get(exchange_name, {})
    base = minimums.get(asset, 0)
    return base * MINIMUM_WITHDRAWAL_CUSHION if base > 0 else 0


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

    ccxt_id = SUPPORTED_EXCHANGES[exchange_name]['ccxt_id']
    api_key = decrypt_api_key(row['api_key_encrypted'])
    private_key = decrypt_api_key(row['private_key_encrypted'])
    passphrase = decrypt_api_key(row['passphrase_encrypted']) if row.get('passphrase_encrypted') else None
    sandbox = bool(row.get('is_sandbox', False))
    return create_exchange(ccxt_id, api_key, private_key, passphrase, sandbox)


def get_connection_row(user_id: int, connection_id: int) -> dict | None:
    """Return the raw exchange_connections row (or None)."""
    return execute_query_one(
        'SELECT * FROM exchange_connections WHERE id = ? AND user_id = ?',
        (connection_id, user_id),
    )
