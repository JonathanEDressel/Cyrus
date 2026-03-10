from flask import Blueprint, request, make_response
from controllers.UserDbContext import UserDbContext
from helper.Security import token_required, decrypt_api_key
from helper.ErrorHandler import handle_error, bad_request, not_found
from helper.Helper import success_response
from helper.KrakenClient import get_open_orders, get_withdrawal_addresses
from functools import wraps
from time import time
from collections import defaultdict
from threading import Lock

kraken_bp = Blueprint('kraken', __name__)


class KrakenRateLimiter:
    def __init__(self, max_calls=10, window_seconds=60):
        self.max_calls = max_calls
        self.window_seconds = window_seconds
        self.call_history = defaultdict(list)  # user_id -> [timestamps]
        self.lock = Lock()
    
    def is_allowed(self, user_id):
        with self.lock:
            current_time = time()
            user_calls = self.call_history[user_id]
            
            cutoff_time = current_time - self.window_seconds
            user_calls[:] = [t for t in user_calls if t > cutoff_time]
            
            if len(user_calls) >= self.max_calls:
                return False
            
            user_calls.append(current_time)
            return True
    
    def get_remaining_calls(self, user_id):
        with self.lock:
            current_time = time()
            user_calls = self.call_history[user_id]
            
            cutoff_time = current_time - self.window_seconds
            user_calls[:] = [t for t in user_calls if t > cutoff_time]
            
            return max(0, self.max_calls - len(user_calls))
    
    def get_reset_time(self, user_id):
        with self.lock:
            current_time = time()
            user_calls = self.call_history[user_id]
            
            if not user_calls:
                return 0
            
            oldest_call = min(user_calls)
            reset_time = oldest_call + self.window_seconds - current_time
            return max(0, int(reset_time))


rate_limiter = KrakenRateLimiter(max_calls=10, window_seconds=60)

def rate_limit_kraken(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        user_id = request.user_id
        
        if not rate_limiter.is_allowed(user_id):
            reset_time = rate_limiter.get_reset_time(user_id)
            response = make_response(bad_request(
                f"Rate limit exceeded. Kraken API allows 10 calls per minute. "
                f"Please wait {reset_time} seconds before trying again."
            ), 429)
            response.headers['X-RateLimit-Limit'] = str(rate_limiter.max_calls)
            response.headers['X-RateLimit-Remaining'] = '0'
            response.headers['X-RateLimit-Reset'] = str(reset_time)
            return response
        
        result = f(*args, **kwargs)
        
        remaining = rate_limiter.get_remaining_calls(user_id)
        reset_time = rate_limiter.get_reset_time(user_id)
        
        if isinstance(result, tuple):
            response = make_response(result)
        else:
            response = make_response(result)
        
        response.headers['X-RateLimit-Limit'] = str(rate_limiter.max_calls)
        response.headers['X-RateLimit-Remaining'] = str(remaining)
        response.headers['X-RateLimit-Reset'] = str(reset_time)
        
        return response
    return decorated_function


@kraken_bp.route('/open-orders', methods=['GET'])
@token_required
@rate_limit_kraken
def open_orders():
    try:
        user = UserDbContext.get_user_by_id(request.user_id)

        if not user:
            return not_found("User not found")

        if not user.kraken_api_key_encrypted or not user.kraken_private_key_encrypted:
            return bad_request("Kraken API keys not configured. Please add them in your profile.")

        api_key = decrypt_api_key(user.kraken_api_key_encrypted)
        private_key = decrypt_api_key(user.kraken_private_key_encrypted)

        result = get_open_orders(api_key, private_key)

        if result.get('error') and len(result['error']) > 0:
            return bad_request(result['error'][0])

        raw_orders = result.get('result', {}).get('open', {})
        orders = []
        for order_id, order in raw_orders.items():
            descr = order.get('descr', {})
            orders.append({
                'id': order_id,
                'pair': descr.get('pair', ''),
                'type': descr.get('ordertype', ''),
                'side': descr.get('type', ''),
                'price': descr.get('price', '0'),
                'volume': order.get('vol', '0'),
                'filled': order.get('vol_exec', '0'),
                'status': order.get('status', ''),
                'opentm': order.get('opentm', 0),
                'description': descr.get('order', ''),
            })

        return success_response(data=orders)

    except Exception as e:
        return handle_error(e)


@kraken_bp.route('/withdrawal-addresses', methods=['GET'])
@token_required
@rate_limit_kraken
def withdrawal_addresses():
    try:
        user = UserDbContext.get_user_by_id(request.user_id)

        if not user:
            return not_found("User not found")

        if not user.kraken_api_key_encrypted or not user.kraken_private_key_encrypted:
            return bad_request("Kraken API keys not configured. Please add them in your profile.")

        api_key = decrypt_api_key(user.kraken_api_key_encrypted)
        private_key = decrypt_api_key(user.kraken_private_key_encrypted)

        result = get_withdrawal_addresses(api_key, private_key)

        if result.get('error') and len(result['error']) > 0:
            return bad_request(result['error'][0])

        addresses = result.get('result', [])

        return success_response(data=addresses)

    except Exception as e:
        return handle_error(e)


@kraken_bp.route('/rate-limit-status', methods=['GET'])
@token_required
def rate_limit_status():
    try:
        user_id = request.user_id
        remaining = rate_limiter.get_remaining_calls(user_id)
        reset_time = rate_limiter.get_reset_time(user_id)
        
        return success_response(data={
            'max_calls_per_minute': rate_limiter.max_calls,
            'remaining_calls': remaining,
            'reset_in_seconds': reset_time,
            'window_seconds': rate_limiter.window_seconds
        })
    
    except Exception as e:
        return handle_error(e)
