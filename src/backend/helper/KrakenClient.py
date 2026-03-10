import time
import hashlib
import hmac
import base64
import urllib.parse
import requests


KRAKEN_API_URL = 'https://api.kraken.com'


def _get_kraken_signature(urlpath: str, data: dict, secret: str) -> str:
    postdata = urllib.parse.urlencode(data)
    encoded = (str(data['nonce']) + postdata).encode()
    message = urlpath.encode() + hashlib.sha256(encoded).digest()
    mac = hmac.new(base64.b64decode(secret), message, hashlib.sha512)
    return base64.b64encode(mac.digest()).decode()


def get_open_orders(api_key: str, private_key: str) -> dict:
    urlpath = '/0/private/OpenOrders'
    nonce = str(int(time.time() * 1000))
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


def get_withdrawal_addresses(api_key: str, private_key: str) -> dict:
    """
    Get whitelisted withdrawal addresses for common assets.
    Note: Kraken's API requires querying per asset, so we check common ones.
    """
    # Common assets to check for withdrawal methods
    common_assets = ['XBT', 'ETH', 'USDT', 'USDC', 'SOL', 'ADA', 'DOT', 'MATIC', 'XRP', 'LTC']
    
    all_addresses = []
    
    for asset in common_assets:
        try:
            urlpath = '/0/private/WithdrawMethods'
            nonce = str(int(time.time() * 1000))
            data = {
                'nonce': nonce,
                'asset': asset
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
            
            if response.status_code == 200:
                result = response.json()
                if result.get('error') and len(result['error']) > 0:
                    # Skip assets with errors (like no withdrawal methods configured)
                    continue
                    
                methods = result.get('result', [])
                for method in methods:
                    all_addresses.append({
                        'asset': asset,
                        'method': method.get('method', ''),
                        'address': method.get('address', method.get('method', '')),
                        'limit': method.get('limit', '0'),
                        'fee': method.get('fee', '0'),
                    })
        except:
            # Skip assets that fail
            continue
    
    return {'error': [], 'result': all_addresses}


def get_closed_orders(api_key: str, private_key: str) -> dict:
    """Get recently closed orders from Kraken."""
    urlpath = '/0/private/ClosedOrders'
    nonce = str(int(time.time() * 1000))
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
    """
    Withdraw funds to a whitelisted address.
    
    Args:
        api_key: Kraken API key
        private_key: Kraken private key
        asset: The asset to withdraw (e.g. 'XBT', 'ETH')
        key: The withdrawal key name (whitelisted address label in Kraken)
        amount: Amount to withdraw
    """
    urlpath = '/0/private/Withdraw'
    nonce = str(int(time.time() * 1000))
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
