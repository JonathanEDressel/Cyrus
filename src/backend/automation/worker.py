import os
import time
import threading
import traceback
from datetime import datetime

from ccxt.base.errors import DDoSProtection, RateLimitExceeded, ExchangeNotAvailable
from dotenv import load_dotenv
from flask import Flask

load_dotenv()


def create_worker_app() -> Flask:
    app = Flask(__name__)
    app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'change-this-to-a-random-secret-key')
    app.config['DATABASE_PATH'] = os.getenv('DATABASE_PATH', os.path.join(os.path.dirname(os.path.dirname(__file__)), 'kraking.db'))
    return app


class AutomationWorker:
    POLL_INTERVAL = 60
    
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
        from controllers.AuthDbContext import AuthDbContext
        from controllers.ExchangeConnectionDbContext import ExchangeConnectionDbContext
        from helper.ExchangeRegistry import get_user_exchange, get_connection_row, get_minimum_withdrawal, SUPPORTED_EXCHANGES
        from helper.ExchangeClient import get_open_orders, get_closed_orders, get_balance, withdraw, convert, get_market_price
        
        user_ids = AutomationDbContext.get_users_with_active_rules()
        
        if not user_ids:
            return
        
        for user_id in user_ids:
            if self._stop_event.is_set():
                return

            if not AuthDbContext.is_user_active(user_id):
                continue
            
            try:
                self._process_user(user_id, AutomationDbContext, ExchangeConnectionDbContext,
                                   get_user_exchange, get_connection_row, get_minimum_withdrawal,
                                   get_open_orders, get_closed_orders, get_balance, withdraw, convert,
                                   get_market_price)
            except Exception as e:
                print(f"[WORKER] Error processing user {user_id}: {e}")
                traceback.print_exc()
            
            time.sleep(2)
    
    def _process_user(self, user_id, AutomationDbContext, ExchangeConnectionDbContext,
                      get_user_exchange, get_connection_row, get_minimum_withdrawal,
                      get_open_orders, get_closed_orders, get_balance, withdraw, convert,
                      get_market_price):
        rules = AutomationDbContext.get_active_rules_by_user(user_id)
        if not rules:
            return

        # Group rules by their trigger exchange connection
        trigger_conn_ids = set()
        for rule in rules:
            if rule.trigger_exchange_id:
                trigger_conn_ids.add(rule.trigger_exchange_id)

        # Process order-based rules per exchange connection
        for conn_id in trigger_conn_ids:
            if self._stop_event.is_set():
                return

            try:
                exchange = get_user_exchange(user_id, conn_id)
                if not exchange:
                    continue

                conn_row = get_connection_row(user_id, conn_id)
                exchange_name = conn_row['exchange_name'] if conn_row else 'unknown'

                # Get open orders from the exchange via CCXT
                open_orders = get_open_orders(exchange)
                current_open_ids = {o['id'] for o in open_orders}

                prev_snapshots = AutomationDbContext.get_order_snapshots_by_user(user_id)
                # Only consider snapshots for this connection
                prev_snapshots_for_conn = [s for s in prev_snapshots
                                           if s.get('exchange_connection_id') == conn_id]
                prev_snapshot_ids = {s['order_id'] for s in prev_snapshots_for_conn}

                disappeared_ids = prev_snapshot_ids - current_open_ids

                conn_rules = [r for r in rules if r.trigger_exchange_id == conn_id
                              and r.trigger_type == 'order_filled']

                for order_id in disappeared_ids:
                    snapshot = next((s for s in prev_snapshots_for_conn if s['order_id'] == order_id), None)
                    if not snapshot:
                        continue

                    # Check if order was actually filled via closed orders.
                    # Pass the symbol so exchanges like Binance that require it work correctly.
                    pair = snapshot.get('pair') or None
                    closed_orders = get_closed_orders(exchange, symbol=pair)
                    closed_order = next((o for o in closed_orders if o['id'] == order_id), None)

                    if closed_order and closed_order.get('status') == 'closed':
                        for rule in conn_rules:
                            if self._rule_matches_order(rule, order_id, snapshot):
                                self._execute_rule(rule, user_id, conn_id,
                                                   order_id, snapshot, AutomationDbContext,
                                                   get_user_exchange, get_minimum_withdrawal, withdraw)

                    AutomationDbContext.delete_order_snapshot(user_id, order_id)

                # Upsert current open orders as snapshots
                for order in open_orders:
                    AutomationDbContext.upsert_order_snapshot(
                        user_id=user_id,
                        order_id=order['id'],
                        pair=order.get('symbol', ''),
                        side=order.get('side', ''),
                        status=order.get('status', ''),
                        volume=str(order.get('amount', '0')),
                        filled=str(order.get('filled', '0')),
                        exchange_connection_id=conn_id,
                    )

            except (DDoSProtection, RateLimitExceeded) as e:
                print(f"[WORKER] Rate limited on connection {conn_id} for user {user_id}, will retry next cycle")
            except ExchangeNotAvailable as e:
                print(f"[WORKER] Exchange unavailable for connection {conn_id} user {user_id}, will retry next cycle")
            except Exception as e:
                print(f"[WORKER] Error processing connection {conn_id} for user {user_id}: {e}")
                traceback.print_exc()

        # Process balance_threshold rules
        balance_rules = [r for r in rules if r.trigger_type == 'balance_threshold']
        if balance_rules:
            self._poll_balances(balance_rules, user_id, AutomationDbContext,
                                get_user_exchange, get_connection_row,
                                get_minimum_withdrawal, get_balance, withdraw, convert)

        price_rules = [r for r in rules if r.trigger_type == 'price_threshold']
        if price_rules:
            self._poll_prices(price_rules, user_id, AutomationDbContext,
                              get_user_exchange, get_market_price, get_balance, convert)
    
    def _poll_balances(self, balance_rules, user_id, AutomationDbContext,
                       get_user_exchange, get_connection_row,
                       get_minimum_withdrawal, get_balance, withdraw, convert):
        # Group balance rules by trigger exchange
        conn_balances = {}

        for rule in balance_rules:
            if self._stop_event.is_set():
                return

            if self._deactivate_if_limit_reached(rule, AutomationDbContext):
                continue

            if not AutomationDbContext.is_cooldown_elapsed(rule.id):
                continue

            conn_id = rule.trigger_exchange_id
            if not conn_id:
                continue

            # Cache balances per connection
            if conn_id not in conn_balances:
                try:
                    exchange = get_user_exchange(user_id, conn_id)
                    if not exchange:
                        conn_balances[conn_id] = None
                        continue
                    conn_balances[conn_id] = get_balance(exchange)
                except (DDoSProtection, RateLimitExceeded) as e:
                    print(f"[WORKER] Rate limited fetching balance for user {user_id} conn {conn_id}, will retry next cycle")
                    conn_balances[conn_id] = None
                    continue
                except ExchangeNotAvailable as e:
                    print(f"[WORKER] Exchange unavailable for balance user {user_id} conn {conn_id}, will retry next cycle")
                    conn_balances[conn_id] = None
                    continue
                except Exception as e:
                    print(f"[WORKER] Balance API error for user {user_id} conn {conn_id}: {e}")
                    conn_balances[conn_id] = None
                    continue

            balances = conn_balances.get(conn_id)
            if not balances:
                continue

            asset = rule.trigger_asset
            threshold = float(rule.trigger_threshold)
            current_balance = float(balances.get(asset, 0))

            if current_balance < threshold:
                continue

            trigger_event = f"Balance {asset} = {current_balance} >= threshold {threshold}"

            if rule.action_type == 'convert_crypto':
                # Convert: market-order into the target asset
                # Use fixed amount if set, otherwise full balance
                convert_amount = current_balance
                if rule.action_amount and float(rule.action_amount) > 0:
                    convert_amount = min(float(rule.action_amount), current_balance)

                # Mark as triggered BEFORE executing to prevent duplicate executions
                AutomationDbContext.mark_rule_triggered(rule.id)

                try:
                    action_exchange = get_user_exchange(user_id, rule.action_exchange_id)
                    if not action_exchange:
                        raise Exception("Action exchange connection not available")

                    result = convert(
                        exchange=action_exchange,
                        from_asset=rule.action_asset,
                        to_asset=rule.convert_to_asset,
                        amount=convert_amount,
                    )

                    AutomationDbContext.create_log(
                        rule_id=rule.id,
                        user_id=rule.user_id,
                        trigger_event=trigger_event,
                        action_executed=f"Convert {convert_amount} {rule.action_asset} \u2192 {rule.convert_to_asset}",
                        action_result=str(result),
                        status='success',
                    )
                    self._on_rule_success(rule, AutomationDbContext)
                    self._notify_execution(
                        rule.user_id, rule, trigger_event,
                        f"Convert {convert_amount} {rule.action_asset} → {rule.convert_to_asset}",
                        str(result),
                    )

                    print(f"[WORKER] Convert rule '{rule.rule_name}' executed for user {rule.user_id}")

                except Exception as e:
                    AutomationDbContext.create_log(
                        rule_id=rule.id,
                        user_id=rule.user_id,
                        trigger_event=trigger_event,
                        action_executed=f"Convert {convert_amount} {rule.action_asset} \u2192 {rule.convert_to_asset}",
                        action_result=str(e),
                        status='error',
                    )
                    print(f"[WORKER] Convert rule '{rule.rule_name}' failed: {e}")
                continue

            # Withdraw: original logic
            # Check minimum withdrawal on the action exchange
            action_conn_row = get_connection_row(user_id, rule.action_exchange_id)
            action_exchange_name = action_conn_row['exchange_name'] if action_conn_row else 'kraken'

            # Capability guard: skip if exchange doesn't support withdrawals
            from helper.ExchangeRegistry import SUPPORTED_EXCHANGES
            action_exchange_meta = SUPPORTED_EXCHANGES.get(action_exchange_name, {})
            if not action_exchange_meta.get('supports_withdraw', False):
                AutomationDbContext.create_log(
                    rule_id=rule.id,
                    user_id=rule.user_id,
                    trigger_event=trigger_event,
                    action_executed="Withdraw (skipped — not supported)",
                    action_result=(
                        f"Withdraw Crypto is not supported for "
                        f"{action_exchange_meta.get('name', action_exchange_name)}"
                    ),
                    status='error',
                )
                print(f"[WORKER] Withdraw not supported for {action_exchange_name}, rule '{rule.rule_name}' skipped")
                continue

            min_withdrawal = get_minimum_withdrawal(action_exchange_name, asset)
            withdraw_amount = current_balance

            if min_withdrawal > 0 and withdraw_amount < min_withdrawal:
                print(f"[WORKER] Balance {withdraw_amount} {asset} below minimum withdrawal {min_withdrawal}")
                continue

            trigger_event = f"Balance {asset} = {current_balance} >= threshold {threshold}"

            # Mark as triggered BEFORE executing to prevent duplicate executions
            AutomationDbContext.mark_rule_triggered(rule.id)

            try:
                action_exchange = get_user_exchange(user_id, rule.action_exchange_id)
                if not action_exchange:
                    raise Exception("Action exchange connection not available")
                
                print("Executing withdrawal action for rule:", rule.rule_name)
                print(f"Details: Withdraw {withdraw_amount} {asset} to {rule.action_address_key} on exchange {action_exchange.id}")
                result = withdraw(
                    exchange=action_exchange,
                    asset=rule.action_asset,
                    amount=withdraw_amount,
                    address=rule.action_address_key,
                )

                AutomationDbContext.create_log(
                    rule_id=rule.id,
                    user_id=rule.user_id,
                    trigger_event=trigger_event,
                    action_executed=f"Withdraw {withdraw_amount} {rule.action_asset} to {rule.action_address_key}",
                    action_result=str(result),
                    status='success',
                )
                self._on_rule_success(rule, AutomationDbContext)
                self._notify_execution(
                    rule.user_id, rule, trigger_event,
                    f"Withdraw {withdraw_amount} {rule.action_asset} to {rule.action_address_key}",
                    str(result),
                )

                print(f"[WORKER] Balance rule '{rule.rule_name}' executed for user {rule.user_id}")

            except Exception as e:
                AutomationDbContext.create_log(
                    rule_id=rule.id,
                    user_id=rule.user_id,
                    trigger_event=trigger_event,
                    action_executed=f"Withdraw {rule.action_asset} to {rule.action_address_key}",
                    action_result=str(e),
                    status='error',
                )
                print(f"[WORKER] Balance rule '{rule.rule_name}' failed: {e}")

    def _rule_matches_order(self, rule, order_id: str, snapshot: dict) -> bool:
        if rule.trigger_type == 'order_filled':
            if rule.trigger_order_id and rule.trigger_order_id == order_id:
                return True
            if rule.trigger_pair and rule.trigger_side:
                return (snapshot.get('pair', '') == rule.trigger_pair and
                        snapshot.get('side', '') == rule.trigger_side)
        return False
    
    def _execute_rule(self, rule, user_id, trigger_conn_id,
                      order_id: str, snapshot: dict, AutomationDbContext,
                      get_user_exchange, get_minimum_withdrawal, withdraw_fn):
        trigger_event = f"Order {order_id} filled ({snapshot.get('pair', '')} {snapshot.get('side', '')})"
        
        # Mark as triggered BEFORE executing to prevent duplicate executions
        AutomationDbContext.mark_rule_triggered(rule.id)
        
        try:
            if rule.action_type == 'withdraw_crypto':
                withdraw_amount = self._resolve_amount(rule, snapshot)

                # Check minimum withdrawal on action exchange
            from helper.ExchangeRegistry import get_connection_row, SUPPORTED_EXCHANGES
            action_conn_row = get_connection_row(user_id, rule.action_exchange_id)
            action_exchange_name = action_conn_row['exchange_name'] if action_conn_row else 'kraken'

            # Capability guard: skip if exchange doesn't support withdrawals
            action_exchange_meta = SUPPORTED_EXCHANGES.get(action_exchange_name, {})
            if not action_exchange_meta.get('supports_withdraw', False):
                AutomationDbContext.create_log(
                    rule_id=rule.id,
                    user_id=rule.user_id,
                    trigger_event=trigger_event,
                    action_executed="Withdraw (skipped — not supported)",
                    action_result=(
                        f"Withdraw Crypto is not supported for "
                        f"{action_exchange_meta.get('name', action_exchange_name)}"
                    ),
                    status='error',
                )
                print(f"[WORKER] Withdraw not supported for {action_exchange_name}, rule '{rule.rule_name}' skipped")
                return

                min_withdrawal = get_minimum_withdrawal(action_exchange_name, rule.action_asset)
                if min_withdrawal > 0 and float(withdraw_amount) < min_withdrawal:
                    skip_msg = (f"Amount {withdraw_amount} {rule.action_asset} is below minimum "
                                f"withdrawal of {min_withdrawal} (skipped)")
                    print(f"[WORKER] {skip_msg}")
                    AutomationDbContext.create_log(
                        rule_id=rule.id,
                        user_id=rule.user_id,
                        trigger_event=trigger_event,
                        action_executed=f"Withdraw {withdraw_amount} {rule.action_asset} to {rule.action_address_key}",
                        action_result=skip_msg,
                        status='skipped',
                    )
                    return

                action_exchange = get_user_exchange(user_id, rule.action_exchange_id)
                if not action_exchange:
                    raise Exception("Action exchange connection not available")

                result = withdraw_fn(
                    exchange=action_exchange,
                    asset=rule.action_asset,
                    amount=float(withdraw_amount),
                    address=rule.action_address_key,
                )
                
                amount_note = " (filled amount)" if rule.use_filled_amount else ""
                AutomationDbContext.create_log(
                    rule_id=rule.id,
                    user_id=rule.user_id,
                    trigger_event=trigger_event,
                    action_executed=f"Withdraw {withdraw_amount} {rule.action_asset} to {rule.action_address_key}{amount_note}",
                    action_result=str(result),
                    status='success',
                )
                self._on_rule_success(rule, AutomationDbContext)
                self._notify_execution(
                    rule.user_id, rule, trigger_event,
                    f"Withdraw {withdraw_amount} {rule.action_asset} to {rule.action_address_key}{amount_note}",
                    str(result),
                )

            print(f"[WORKER] Rule '{rule.rule_name}' executed for user {rule.user_id}")
            
        except Exception as e:
            AutomationDbContext.create_log(
                rule_id=rule.id,
                user_id=rule.user_id,
                trigger_event=trigger_event,
                action_executed=f"Withdraw {rule.action_asset} to {rule.action_address_key}",
                action_result=str(e),
                status='error',
            )
            print(f"[WORKER] Rule '{rule.rule_name}' failed: {e}")

    def _poll_prices(self, price_rules, user_id, AutomationDbContext,
                     get_user_exchange, get_market_price, get_balance, convert):
        trigger_exchanges = {}
        market_prices = {}

        for rule in price_rules:
            if self._stop_event.is_set():
                return

            if self._deactivate_if_limit_reached(rule, AutomationDbContext):
                continue

            if not AutomationDbContext.is_cooldown_elapsed(rule.id):
                continue

            if not rule.trigger_asset or not rule.trigger_threshold or not rule.trigger_price_quote_asset:
                continue

            conn_id = rule.trigger_exchange_id
            if not conn_id:
                continue

            if conn_id not in trigger_exchanges:
                try:
                    trigger_exchanges[conn_id] = get_user_exchange(user_id, conn_id)
                except Exception as e:
                    print(f"[WORKER] Trigger exchange unavailable for user {user_id} conn {conn_id}: {e}")
                    trigger_exchanges[conn_id] = None

            exchange = trigger_exchanges.get(conn_id)
            if not exchange:
                continue

            pair_key = f"{rule.trigger_asset}/{rule.trigger_price_quote_asset}"
            cache_key = f"{conn_id}:{pair_key}"
            if cache_key not in market_prices:
                try:
                    market_prices[cache_key] = get_market_price(
                        exchange,
                        base_asset=rule.trigger_asset,
                        quote_asset=rule.trigger_price_quote_asset,
                    )
                except (DDoSProtection, RateLimitExceeded):
                    print(f"[WORKER] Rate limited fetching ticker {pair_key} for user {user_id}")
                    market_prices[cache_key] = None
                except ExchangeNotAvailable:
                    print(f"[WORKER] Exchange unavailable fetching ticker {pair_key} for user {user_id}")
                    market_prices[cache_key] = None
                except Exception as e:
                    print(f"[WORKER] Failed to fetch ticker {pair_key} for user {user_id}: {e}")
                    market_prices[cache_key] = None

            current_price = market_prices.get(cache_key)
            if current_price is None:
                continue

            threshold = float(rule.trigger_threshold)
            if current_price < threshold:
                continue

            trigger_event = (
                f"Price {rule.trigger_asset}/{rule.trigger_price_quote_asset} = "
                f"{current_price:.10g} >= target {threshold:.10g}"
            )

            AutomationDbContext.mark_rule_triggered(rule.id)

            try:
                action_exchange = get_user_exchange(user_id, rule.action_exchange_id)
                if not action_exchange:
                    raise Exception("Action exchange connection not available")

                balances = get_balance(action_exchange)
                current_balance = float(balances.get(rule.action_asset, 0))
                amount = self._resolve_price_rule_amount(rule, current_balance)

                if amount <= 0:
                    raise Exception(f"No {rule.action_asset} available to convert")

                result = convert(
                    exchange=action_exchange,
                    from_asset=rule.action_asset,
                    to_asset=rule.convert_to_asset,
                    amount=amount,
                )

                mode_text = (rule.action_amount_mode or 'all').lower()
                if mode_text == 'percent':
                    amount_desc = f"{rule.action_amount}% ({amount:.10g} {rule.action_asset})"
                elif mode_text == 'fixed':
                    amount_desc = f"{amount:.10g} {rule.action_asset}"
                else:
                    amount_desc = f"all ({amount:.10g} {rule.action_asset})"

                AutomationDbContext.create_log(
                    rule_id=rule.id,
                    user_id=rule.user_id,
                    trigger_event=trigger_event,
                    action_executed=(
                        f"Convert {amount_desc} {rule.action_asset} -> {rule.convert_to_asset}"
                    ),
                    action_result=str(result),
                    status='success',
                )
                self._on_rule_success(rule, AutomationDbContext)
                self._notify_execution(
                    rule.user_id, rule, trigger_event,
                    f"Convert {amount_desc} {rule.action_asset} -> {rule.convert_to_asset}",
                    str(result),
                )
                print(f"[WORKER] Price rule '{rule.rule_name}' executed for user {rule.user_id}")

            except Exception as e:
                AutomationDbContext.create_log(
                    rule_id=rule.id,
                    user_id=rule.user_id,
                    trigger_event=trigger_event,
                    action_executed=f"Convert {rule.action_asset} -> {rule.convert_to_asset}",
                    action_result=str(e),
                    status='error',
                )
                print(f"[WORKER] Price rule '{rule.rule_name}' failed: {e}")
    
    def _resolve_amount(self, rule, snapshot: dict) -> str:
        if not rule.use_filled_amount:
            return rule.action_amount
        
        filled = snapshot.get('filled', '0')
        filled_float = float(filled)
        
        if filled_float <= 0:
            raise Exception("Order filled amount is zero or unavailable")
        
        return str(filled_float)

    def _resolve_price_rule_amount(self, rule, current_balance: float) -> float:
        if current_balance <= 0:
            return 0.0

        mode = (rule.action_amount_mode or 'all').lower()

        if mode == 'percent':
            pct = float(rule.action_amount or 0)
            return max(0.0, current_balance * (pct / 100.0))

        if mode == 'fixed':
            fixed = float(rule.action_amount or 0)
            if fixed <= 0:
                return 0.0
            return min(fixed, current_balance)

        return current_balance

    def _deactivate_if_limit_reached(self, rule, AutomationDbContext) -> bool:
        if not rule.has_reached_execution_limit():
            return False

        AutomationDbContext.deactivate_rule(rule.id, rule.user_id)
        AutomationDbContext.create_log(
            rule_id=rule.id,
            user_id=rule.user_id,
            trigger_event="Execution limit reached",
            action_executed="Auto-deactivate rule",
            action_result=(
                f"Rule deactivated after {rule.execution_count}/{rule.max_executions} successful executions"
            ),
            status='success',
        )
        rule.is_active = False
        print(f"[WORKER] Rule '{rule.rule_name}' auto-deactivated at max executions")
        return True

    def _on_rule_success(self, rule, AutomationDbContext) -> None:
        AutomationDbContext.mark_rule_execution_success(rule.id)
        rule.execution_count = int(rule.execution_count or 0) + 1
        if self._deactivate_if_limit_reached(rule, AutomationDbContext):
            return

    def _notify_execution(self, user_id, rule, trigger_event: str,
                          action_executed: str, action_result: str) -> None:
        """Email the user that a rule executed, if they enabled email alerts.

        Best-effort and fully isolated: the SMTP send is fire-and-forget and any
        failure here is swallowed so it can never affect rule execution. Runs in
        the worker's app context, so the encrypted app password can be decrypted.
        """
        try:
            from controllers.UserDbContext import UserDbContext
            settings = UserDbContext.get_email_settings(user_id)
            if not settings or not settings.get('email_notifications_enabled'):
                return

            to_addr = settings.get('notify_email')
            enc_pw = settings.get('smtp_password_encrypted')
            if not to_addr or not enc_pw:
                return

            from helper.Security import decrypt_api_key
            from helper.notifier import send_email_async

            password = decrypt_api_key(enc_pw)
            subject = f"Cyrus: '{rule.rule_name}' executed"
            body = (
                f"Your automation rule '{rule.rule_name}' just executed.\n\n"
                f"Trigger: {trigger_event}\n"
                f"Action:  {action_executed}\n"
                f"Result:  {action_result}\n"
            )
            send_email_async(
                to_addr=to_addr, subject=subject, body=body,
                smtp_user=to_addr, smtp_password=password,
                smtp_host=settings.get('smtp_host'), smtp_port=settings.get('smtp_port'),
            )
        except Exception as e:
            print(f"[WORKER] Failed to send execution email for user {user_id}: {e}")


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
