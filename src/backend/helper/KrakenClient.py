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
