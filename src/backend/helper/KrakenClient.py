import time
import hashlib
import hmac
import base64
import urllib.parse
import requests


KRAKEN_API_URL = 'https://api.kraken.com'

# Minimum withdrawal amounts enforced by Kraken (in asset units)
# Source: https://support.kraken.com/articles/360000767986-cryptocurrency-withdrawal-fees-and-minimums
# Last updated: March 12, 2026
MINIMUM_WITHDRAWALS = {
    # Major cryptocurrencies
    'XBT': 0.00022,         # Bitcoin
    'ETH': 0.00017,         # Ethereum
    'SOL': 0.011,           # Solana
    'ADA': 5,               # Cardano
    'DOT': 1,               # Polkadot
    'MATIC': 7,             # Polygon (also listed as POL)
    'POL': 7,               # Polygon (new ticker)
    'AVAX': 0.50,           # Avalanche
    'ATOM': 1.00,           # Cosmos
    'LINK': 0.045,          # Chainlink
    
    # Altcoins
    'XRP': 12,              # Ripple
    'XLM': 25,              # Stellar (Lumen)
    'LTC': 0.0100,          # Litecoin
    'BCH': 0.00060,         # Bitcoin Cash
    'ETC': 0.014,           # Ethereum Classic
    'DOGE': 50,             # Dogecoin
    'SHIB': 104441,         # Shiba Inu
    'TRX': 20,              # Tron
    'ALGO': 1.00,           # Algorand
    'FIL': 0.100,           # Filecoin
    'LUNA2': 0.50,          # Terra 2.0
    'LUNA': 50000,          # Terra Classic
    
    # Stablecoins (Ethereum network - minimums vary by network)
    'USDT': 0.64,           # Tether (Ethereum)
    'USDC': 0.65,           # USD Coin (Ethereum)
    'DAI': 0.53,            # Dai (Ethereum)
    'BUSD': 0.65,           # Binance USD (estimated, not in current list)
    
    # DeFi tokens
    'UNI': 0.17,            # Uniswap
    'AAVE': 0.0065,         # Aave
    'CRV': 2,               # Curve DAO Token
    'SNX': 4,               # Synthetix
    'COMP': 0.036,          # Compound
    'SUSHI': 3,             # Sushi
    'YFI': 0.00024,         # Yearn Finance
    'MKR': 0.001,           # Maker (estimated, not in current list)
    '1INCH': 4,             # 1inch
    'BAL': 5,               # Balancer
    'LDO': 1,               # LIDO DAO
    
    # Gaming & Metaverse
    'APE': 6,               # ApeCoin
    'SAND': 5,              # Sandbox
    'MANA': 7,              # Decentraland
    'GALA': 216,            # Gala Games
    'AXS': 0.53,            # Axie Infinity Shards
    'ENJ': 8,               # Enjin
    
    # Other popular tokens
    'GRT': 23,              # The Graph
    'FET': 6,               # Fetch.ai
    'RNDR': 0.42,           # Render (listed as RENDER)
}


def get_minimum_withdrawal(asset: str) -> float:
    return MINIMUM_WITHDRAWALS.get(asset, 0)


def _get_kraken_signature(urlpath: str, data: dict, secret: str) -> str:
    postdata = urllib.parse.urlencode(data)
    encoded = (str(data['nonce']) + postdata).encode()
    message = urlpath.encode() + hashlib.sha256(encoded).digest()
    mac = hmac.new(base64.b64decode(secret), message, hashlib.sha512)
    return base64.b64encode(mac.digest()).decode()


def get_open_orders(api_key: str, private_key: str) -> dict:
    urlpath = '/0/private/OpenOrders'
    nonce = str(int(time.time() * 1_000_000))
    data = {'nonce': nonce}

    signature = _get_kraken_signature(urlpath, data, private_key)

    headers = {
        'API-Key': api_key,
        'API-Sign': signature,
    }

    response = requests.post(
        KRAKEN_API_URL + urlpath,
        headers=headers,
        data=data,
        timeout=15
    )
    response.raise_for_status()
    return response.json()


def execute_crypto_withdrawal(api_key: str, private_key: str, asset: str, address_nickname: str, amount: str) -> dict:
    urlpath = '/0/private/Withdraw'
    nonce = str(int(time.time() * 1_000_000))
    
    data = {
        'nonce': nonce,
        'asset': asset,
        'key': address_nickname, 
        'amount': amount
    }

    signature = _get_kraken_signature(urlpath, data, private_key)

    headers = {
        'API-Key': api_key,
        'API-Sign': signature,
    }

    try:
        response = requests.post(
            'https://api.kraken.com' + urlpath,  
            headers=headers,
            data=data,
            timeout=15
        )
        
        if response.status_code == 200:
            result = response.json()
            return result
        else:
             return {'error': [f"HTTP Error: {response.status_code}"], 'result': {}}
             
    except Exception as e:
        return {'error': [str(e)], 'result': {}}

def get_withdrawal_addresses(api_key: str, private_key: str) -> dict:
    common_assets = ['XBT', 'ETH', 'USDT', 'USDC', 'SOL', 'ADA', 'DOT', 'MATIC', 'XRP', 'LTC']
    
    urlpath = '/0/private/WithdrawAddresses'
    nonce = str(int(time.time() * 1_000_000))
    
    data = {
        'nonce': nonce
    }

    signature = _get_kraken_signature(urlpath, data, private_key)

    headers = {
        'API-Key': api_key,
        'API-Sign': signature,
    }

    try:
        response = requests.post(
            KRAKEN_API_URL + urlpath, 
            headers=headers,
            data=data,
            timeout=15
        )
        
        if response.status_code == 200:
            result = response.json()
            
            if result.get('error'):
                return result
                
            raw_addresses = result.get('result', [])
            formatted_addresses = []
            for addr in raw_addresses:
                formatted_addresses.append({
                    'nickname_key': addr.get('key', ''),
                    'address': addr.get('address', ''),
                    'asset': addr.get('asset', ''),
                    'method': addr.get('method', ''),
                    'verified': addr.get('verified', False)
                })
                
            return {'error': [], 'result': formatted_addresses}
            
        else:
             return {'error': [f"HTTP Error: {response.status_code}"], 'result': []}
             
    except Exception as e:
        return {'error': [str(e)], 'result': []}


def get_closed_orders(api_key: str, private_key: str) -> dict:
    urlpath = '/0/private/ClosedOrders'
    nonce = str(int(time.time() * 1_000_000))
    data = {'nonce': nonce}

    signature = _get_kraken_signature(urlpath, data, private_key)

    headers = {
        'API-Key': api_key,
        'API-Sign': signature,
    }

    response = requests.post(
        KRAKEN_API_URL + urlpath,
        headers=headers,
        data=data,
        timeout=15
    )
    response.raise_for_status()
    return response.json()


def withdraw_funds(api_key: str, private_key: str, asset: str,
                   key: str, amount: str) -> dict:
    urlpath = '/0/private/Withdraw'
    nonce = str(int(time.time() * 1_000_000))
    data = {
        'nonce': nonce,
        'asset': asset,
        'key': key,
        'amount': amount,
    }

    signature = _get_kraken_signature(urlpath, data, private_key)

    headers = {
        'API-Key': api_key,
        'API-Sign': signature,
    }

    response = requests.post(
        KRAKEN_API_URL + urlpath,
        headers=headers,
        data=data,
        timeout=15
    )
    response.raise_for_status()
    return response.json()


def get_account_balance(api_key: str, private_key: str) -> dict:
    urlpath = '/0/private/Balance'
    nonce = str(int(time.time() * 1_000_000))
    data = {'nonce': nonce}

    signature = _get_kraken_signature(urlpath, data, private_key)

    headers = {
        'API-Key': api_key,
        'API-Sign': signature,
    }

    response = requests.post(
        KRAKEN_API_URL + urlpath,
        headers=headers,
        data=data,
        timeout=15
    )
    response.raise_for_status()
    return response.json()
