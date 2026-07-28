"""CoinGecko client for asset fundamentals (market cap, supply, all-time highs).

Exchanges don't publish this: CCXT can tell you what BTC trades at on Kraken,
but not how many exist, what the whole market is worth, or what it peaked at in
2021. That data has to come from a market-data provider, so the Holdings page
reads it from CoinGecko's free public API — no key, no account.

Only asset symbols leave the machine (``bitcoin``, ``solana``, …). Balances,
amounts and account identifiers are never sent. Every call is best-effort: when
the network is down or the provider rate-limits us, callers fall back to the
exchange-derived numbers and the page says so rather than showing blanks.
"""

import json
import urllib.parse
import urllib.request


API_BASE = 'https://api.coingecko.com/api/v3'
TIMEOUT = 10
USER_AGENT = 'Cyrus/1.0 (+local desktop app)'

# Fiat and fiat-equivalents the exchange reports as balances. They have no coin
# page, so they're shown as cash rather than looked up.
FIAT_CODES = {'USD', 'ZUSD', 'EUR', 'ZEUR', 'GBP', 'ZGBP', 'CAD', 'AUD', 'JPY', 'CHF'}

# Symbol → CoinGecko id for everything the app already knows about. A curated map
# avoids a lookup per asset, and — more importantly — avoids picking the wrong
# coin when a ticker is reused (there are a dozen "SOL"s in their index).
SYMBOL_TO_ID: dict[str, str] = {
    'BTC': 'bitcoin',           'XBT': 'bitcoin',          'ETH': 'ethereum',
    'SOL': 'solana',            'ADA': 'cardano',          'DOT': 'polkadot',
    'MATIC': 'matic-network',   'POL': 'polygon-ecosystem-token',
    'AVAX': 'avalanche-2',      'ATOM': 'cosmos',          'LINK': 'chainlink',
    'XRP': 'ripple',            'XLM': 'stellar',          'LTC': 'litecoin',
    'BCH': 'bitcoin-cash',      'ETC': 'ethereum-classic', 'DOGE': 'dogecoin',
    'SHIB': 'shiba-inu',        'TRX': 'tron',             'ALGO': 'algorand',
    'FIL': 'filecoin',          'LUNA2': 'terra-luna-2',   'LUNA': 'terra-luna',
    'USDT': 'tether',           'USDC': 'usd-coin',        'DAI': 'dai',
    'PYUSD': 'paypal-usd',      'TUSD': 'true-usd',        'BUSD': 'binance-usd',
    'UNI': 'uniswap',           'AAVE': 'aave',            'CRV': 'curve-dao-token',
    'SNX': 'havven',            'COMP': 'compound-governance-token',
    'SUSHI': 'sushi',           'YFI': 'yearn-finance',    '1INCH': '1inch',
    'BAL': 'balancer',          'LDO': 'lido-dao',         'APE': 'apecoin',
    'SAND': 'the-sandbox',      'MANA': 'decentraland',    'GALA': 'gala',
    'AXS': 'axie-infinity',     'ENJ': 'enjincoin',        'GRT': 'the-graph',
    'FET': 'fetch-ai',          'RENDER': 'render-token',  'BNB': 'binancecoin',
    'NEAR': 'near',             'APT': 'aptos',            'ARB': 'arbitrum',
    'OP': 'optimism',           'INJ': 'injective-protocol', 'SUI': 'sui',
    'TIA': 'celestia',          'SEI': 'sei-network',      'STX': 'blockstack',
    'IMX': 'immutable-x',       'HBAR': 'hedera-hashgraph', 'VET': 'vechain',
    'ICP': 'internet-computer', 'MKR': 'maker',            'RUNE': 'thorchain',
    'KSM': 'kusama',            'XTZ': 'tezos',            'EOS': 'eos',
    'THETA': 'theta-token',     'CHZ': 'chiliz',           'FLOW': 'flow',
    'ZEC': 'zcash',             'DASH': 'dash',            'KAVA': 'kava',
    'ROSE': 'oasis-network',    'CAKE': 'pancakeswap-token', 'PEPE': 'pepe',
    'BONK': 'bonk',             'WIF': 'dogwifcoin',       'JUP': 'jupiter-exchange-solana',
    'PYTH': 'pyth-network',     'WLD': 'worldcoin-wld',    'ENS': 'ethereum-name-service',
    'BLUR': 'blur',             'KAS': 'kaspa',            'TON': 'the-open-network',
    'TAO': 'bittensor',         'ONDO': 'ondo-finance',    'JTO': 'jito-governance-token',
}


class CoinGeckoError(Exception):
    """Any failure talking to CoinGecko — always caught by callers."""


def _get(path: str, params: dict) -> object:
    """GET a CoinGecko endpoint and return the decoded JSON."""
    url = f"{API_BASE}{path}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, headers={
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
    })
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            if response.status != 200:
                raise CoinGeckoError(f"CoinGecko returned HTTP {response.status}")
            return json.loads(response.read().decode('utf-8'))
    except CoinGeckoError:
        raise
    except Exception as e:
        raise CoinGeckoError(str(e)) from e


def is_fiat(symbol: str) -> bool:
    return (symbol or '').upper() in FIAT_CODES


def lookup_coin_id(symbol: str) -> str | None:
    """Resolve a ticker to a CoinGecko id, searching only when it's unknown.

    The search picks the best-ranked coin whose symbol matches exactly, so a
    scam token sharing a ticker with a real one doesn't win.
    """
    symbol = (symbol or '').upper()
    if not symbol or is_fiat(symbol):
        return None
    if symbol in SYMBOL_TO_ID:
        return SYMBOL_TO_ID[symbol]

    data = _get('/search', {'query': symbol})
    coins = data.get('coins', []) if isinstance(data, dict) else []
    exact = [c for c in coins if str(c.get('symbol', '')).upper() == symbol]
    if not exact:
        return None
    exact.sort(key=lambda c: c.get('market_cap_rank') or 10 ** 9)
    return exact[0].get('id')


def fetch_markets(coin_ids: list[str]) -> dict[str, dict]:
    """Fetch fundamentals for several coins in one request, keyed by coin id."""
    ids = [c for c in dict.fromkeys(coin_ids) if c]
    if not ids:
        return {}

    rows = _get('/coins/markets', {
        'vs_currency': 'usd',
        'ids': ','.join(ids),
        'order': 'market_cap_desc',
        'per_page': min(len(ids), 250),
        'page': 1,
        'sparkline': 'true',
        'price_change_percentage': '1h,24h,7d,30d',
    })
    if not isinstance(rows, list):
        raise CoinGeckoError("Unexpected response shape from CoinGecko")

    out: dict[str, dict] = {}
    for row in rows:
        if isinstance(row, dict) and row.get('id'):
            out[row['id']] = normalize(row)
    return out


def normalize(row: dict) -> dict:
    """Trim a /coins/markets row to what the Holdings page uses.

    The 7-day sparkline is downsampled from hourly (168 points) to ~40, which is
    all a 90px chart can show and keeps the cached payload small.
    """
    spark = (row.get('sparkline_in_7d') or {}).get('price') or []
    if len(spark) > 40:
        stride = len(spark) / 40.0
        spark = [spark[min(int(i * stride), len(spark) - 1)] for i in range(40)]

    circulating = row.get('circulating_supply')
    max_supply = row.get('max_supply')
    total_supply = row.get('total_supply')

    # "How much of the eventual supply already exists" — the closest crypto
    # equivalent of shares outstanding vs. authorised.
    supply_issued_pct = None
    denominator = max_supply or total_supply
    if circulating and denominator:
        try:
            supply_issued_pct = min(100.0, float(circulating) / float(denominator) * 100.0)
        except (TypeError, ValueError, ZeroDivisionError):
            supply_issued_pct = None

    volume = row.get('total_volume')
    market_cap = row.get('market_cap')
    # Daily turnover as a share of market cap: a rough liquidity read.
    volume_to_cap_pct = None
    if volume and market_cap:
        try:
            volume_to_cap_pct = float(volume) / float(market_cap) * 100.0
        except (TypeError, ValueError, ZeroDivisionError):
            volume_to_cap_pct = None

    return {
        'coin_id': row.get('id'),
        'name': row.get('name'),
        'symbol': str(row.get('symbol', '')).upper(),
        'price': row.get('current_price'),
        'market_cap': market_cap,
        'market_cap_rank': row.get('market_cap_rank'),
        'fully_diluted_valuation': row.get('fully_diluted_valuation'),
        'total_volume': volume,
        'volume_to_cap_pct': volume_to_cap_pct,
        'high_24h': row.get('high_24h'),
        'low_24h': row.get('low_24h'),
        'change_1h_pct': row.get('price_change_percentage_1h_in_currency'),
        'change_24h_pct': row.get('price_change_percentage_24h_in_currency'),
        'change_7d_pct': row.get('price_change_percentage_7d_in_currency'),
        'change_30d_pct': row.get('price_change_percentage_30d_in_currency'),
        'circulating_supply': circulating,
        'total_supply': total_supply,
        'max_supply': max_supply,
        'supply_issued_pct': supply_issued_pct,
        'ath': row.get('ath'),
        'ath_date': row.get('ath_date'),
        'ath_change_pct': row.get('ath_change_percentage'),
        'atl': row.get('atl'),
        'atl_date': row.get('atl_date'),
        'atl_change_pct': row.get('atl_change_percentage'),
        'sparkline_7d': spark,
    }
