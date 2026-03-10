import os
import time
import threading
import traceback
from datetime import datetime

from dotenv import load_dotenv
from flask import Flask

load_dotenv()


def create_worker_app() -> Flask:
    app = Flask(__name__)
    app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'change-this-to-a-random-secret-key')
    app.config['MYSQL_HOST'] = os.getenv('MYSQL_HOST', 'localhost')
    app.config['MYSQL_PORT'] = int(os.getenv('MYSQL_PORT', 3306))
    app.config['MYSQL_USER'] = os.getenv('MYSQL_USER', 'root')
    app.config['MYSQL_PASSWORD'] = os.getenv('MYSQL_PASSWORD', '')
    app.config['MYSQL_DATABASE'] = os.getenv('MYSQL_DATABASE', 'kraking_db')
    return app


class AutomationWorker:
    POLL_INTERVAL = 30
    
    def __init__(self, app: Flask):
        self.app = app
        self._stop_event = threading.Event()
        self._thread = None
    
    def start(self):
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run_loop, daemon=True, name="automation-worker")
        self._thread.start()
        print("[WORKER] Automation worker started")
    
    def stop(self):
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=10)
        print("[WORKER] Automation worker stopped")
    
    def _run_loop(self):
        while not self._stop_event.is_set():
            try:
                with self.app.app_context():
                    self._poll_cycle()
            except Exception as e:
                print(f"[WORKER ERROR] {e}")
                traceback.print_exc()
            
            for _ in range(self.POLL_INTERVAL):
                if self._stop_event.is_set():
                    return
                time.sleep(1)
    
    def _poll_cycle(self):
        from controllers.AutomationDbContext import AutomationDbContext
        from controllers.UserDbContext import UserDbContext
        from helper.Security import decrypt_api_key
        from helper.KrakenClient import get_open_orders, get_closed_orders
        
        user_ids = AutomationDbContext.get_users_with_active_rules()
        
        if not user_ids:
            return
        
        for user_id in user_ids:
            if self._stop_event.is_set():
                return
            
            try:
                self._process_user(user_id, AutomationDbContext, UserDbContext, decrypt_api_key,
                                   get_open_orders, get_closed_orders)
            except Exception as e:
                print(f"[WORKER] Error processing user {user_id}: {e}")
                traceback.print_exc()
            
            time.sleep(2)
    
    def _process_user(self, user_id, AutomationDbContext, UserDbContext, decrypt_api_key,
                      get_open_orders, get_closed_orders):
        user = UserDbContext.get_user_by_id(user_id)
        if not user or not user.kraken_api_key_encrypted or not user.kraken_private_key_encrypted:
            return
        
        api_key = decrypt_api_key(user.kraken_api_key_encrypted)
        private_key = decrypt_api_key(user.kraken_private_key_encrypted)
        
        open_result = get_open_orders(api_key, private_key)
        if open_result.get('error') and len(open_result['error']) > 0:
            print(f"[WORKER] Kraken error for user {user_id}: {open_result['error']}")
            return
        
        current_open = open_result.get('result', {}).get('open', {})
        current_open_ids = set(current_open.keys())
        
        prev_snapshots = AutomationDbContext.get_order_snapshots_by_user(user_id)
        prev_snapshot_ids = {s['order_id'] for s in prev_snapshots}
        
        disappeared_ids = prev_snapshot_ids - current_open_ids
        
        rules = AutomationDbContext.get_active_rules_by_user(user_id)
        
        for order_id in disappeared_ids:
            snapshot = next((s for s in prev_snapshots if s['order_id'] == order_id), None)
            if not snapshot:
                continue
            
            closed_result = get_closed_orders(api_key, private_key)
            closed_orders = closed_result.get('result', {}).get('closed', {})
            
            closed_order = closed_orders.get(order_id)
            if closed_order and closed_order.get('status') == 'closed':
                for rule in rules:
                    if self._rule_matches_order(rule, order_id, snapshot):
                        self._execute_rule(rule, user, api_key, private_key,
                                          order_id, snapshot, AutomationDbContext)
            
            AutomationDbContext.delete_order_snapshot(user_id, order_id)
        
        for oid, order in current_open.items():
            descr = order.get('descr', {})
            AutomationDbContext.upsert_order_snapshot(
                user_id=user_id,
                order_id=oid,
                pair=descr.get('pair', ''),
                side=descr.get('type', ''),
                status=order.get('status', ''),
                volume=order.get('vol', '0'),
                filled=order.get('vol_exec', '0'),
            )
    
    def _rule_matches_order(self, rule, order_id: str, snapshot: dict) -> bool:
        if rule.trigger_type == 'order_filled':
            if rule.trigger_order_id and rule.trigger_order_id == order_id:
                return True
            if rule.trigger_pair and rule.trigger_side:
                return (snapshot.get('pair', '') == rule.trigger_pair and
                        snapshot.get('side', '') == rule.trigger_side)
        return False
    
    def _execute_rule(self, rule, user, api_key: str, private_key: str,
                      order_id: str, snapshot: dict, AutomationDbContext):
        trigger_event = f"Order {order_id} filled ({snapshot.get('pair', '')} {snapshot.get('side', '')})"
        
        try:
            if rule.action_type == 'withdraw_crypto':
                result = self._execute_withdraw(api_key, private_key, rule)
                
                AutomationDbContext.create_log(
                    rule_id=rule.id,
                    user_id=rule.user_id,
                    trigger_event=trigger_event,
                    action_executed=f"Withdraw {rule.action_amount} {rule.action_asset} to {rule.action_address_key}",
                    action_result=str(result),
                    status='success' if not result.get('error') else 'failed',
                )
            
            AutomationDbContext.mark_rule_triggered(rule.id)
            print(f"[WORKER] Rule '{rule.rule_name}' executed for user {rule.user_id}")
            
        except Exception as e:
            AutomationDbContext.create_log(
                rule_id=rule.id,
                user_id=rule.user_id,
                trigger_event=trigger_event,
                action_executed=f"Withdraw {rule.action_amount} {rule.action_asset} to {rule.action_address_key}",
                action_result=str(e),
                status='error',
            )
            print(f"[WORKER] Rule '{rule.rule_name}' failed: {e}")
    
    def _execute_withdraw(self, api_key: str, private_key: str, rule) -> dict:
        from helper.KrakenClient import withdraw_funds
        
        result = withdraw_funds(
            api_key=api_key,
            private_key=private_key,
            asset=rule.action_asset,
            key=rule.action_address_key,
            amount=rule.action_amount,
        )
        
        if result.get('error') and len(result['error']) > 0:
            raise Exception(result['error'][0])
        
        return result


_worker_instance = None


def start_worker(app: Flask):
    global _worker_instance
    if _worker_instance is None:
        _worker_instance = AutomationWorker(app)
        _worker_instance.start()


def stop_worker():
    global _worker_instance
    if _worker_instance:
        _worker_instance.stop()
        _worker_instance = None
