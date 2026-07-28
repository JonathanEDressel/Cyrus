from flask import Blueprint, request
from controllers.AutomationDbContext import AutomationDbContext
from controllers.ExchangeConnectionDbContext import ExchangeConnectionDbContext
from helper.Security import token_required, active_required
from helper.ErrorHandler import handle_error, bad_request, not_found
from helper.Helper import success_response, created_response
from helper.ExchangeRegistry import (get_minimum_withdrawal, get_all_minimums,
                                     SUPPORTED_EXCHANGES, REBALANCE_TARGET_CANDIDATES,
                                     supports_rebalance, get_user_exchange,
                                     get_connection_row)

automation_bp = Blueprint('automation', __name__)

# 'allocation_threshold' (portfolio balancer) is deliberately absent: those rules
# are written as a set by the /allocations endpoints below, not one at a time
# through the generic rule builder.
VALID_TRIGGER_TYPES = ['order_filled', 'balance_threshold', 'price_threshold']
VALID_ACTION_TYPES = ['withdraw_crypto', 'convert_crypto']

ALLOCATION_TRIGGER = 'allocation_threshold'
DEFAULT_REBALANCE_COOLDOWN = 1440   # minutes
DEFAULT_MIN_TRADE_USD = 25.0
# Gap between the cap and where a rebalance lands when the user doesn't pick one.
DEFAULT_HYSTERESIS_POINTS = 5.0


@automation_bp.route('/rules', methods=['GET'])
@token_required
@active_required
def get_rules():
    try:
        rules = AutomationDbContext.get_rules_by_user(request.user_id)
        return success_response(data=[r.to_dict() for r in rules])
    except Exception as e:
        return handle_error(e)


@automation_bp.route('/rules', methods=['POST'])
@token_required
@active_required
def create_rule():
    try:
        data = request.get_json()
        if not data:
            return bad_request("No data provided")

        rule_name = data.get('rule_name', '').strip()
        trigger_type = data.get('trigger_type', '').strip()
        action_type = data.get('action_type', '').strip()

        if not rule_name or len(rule_name) < 1:
            return bad_request("Rule name is required")
        if trigger_type not in VALID_TRIGGER_TYPES:
            return bad_request(f"Invalid trigger type. Must be one of: {', '.join(VALID_TRIGGER_TYPES)}")
        if action_type not in VALID_ACTION_TYPES:
            return bad_request(f"Invalid action type. Must be one of: {', '.join(VALID_ACTION_TYPES)}")
        if trigger_type == 'price_threshold' and action_type != 'convert_crypto':
            return bad_request("Price threshold trigger requires 'convert_crypto' action")

        # Validate exchange connections
        trigger_exchange_id = data.get('trigger_exchange_id')
        action_exchange_id = data.get('action_exchange_id')

        if not trigger_exchange_id:
            return bad_request("Trigger exchange connection is required")
        if not action_exchange_id:
            return bad_request("Action exchange connection is required")

        trigger_exchange_id = int(trigger_exchange_id)
        action_exchange_id = int(action_exchange_id)

        trigger_conn = ExchangeConnectionDbContext.get_connection(trigger_exchange_id, request.user_id)
        if not trigger_conn:
            return bad_request("Trigger exchange connection not found")
        if not trigger_conn['is_validated']:
            return bad_request("Trigger exchange connection keys are not validated")

        action_conn = ExchangeConnectionDbContext.get_connection(action_exchange_id, request.user_id)
        if not action_conn:
            return bad_request("Action exchange connection not found")
        if not action_conn['is_validated']:
            return bad_request("Action exchange connection keys are not validated")

        # Enforce exchange capability: block withdraw actions for exchanges that
        # don't support crypto withdrawals via API (e.g. Coinbase, Binance, Robinhood).
        if action_type == 'withdraw_crypto':
            action_exchange_meta = SUPPORTED_EXCHANGES.get(action_conn['exchange_name'], {})
            if not action_exchange_meta.get('supports_withdraw', False):
                exchange_label = action_exchange_meta.get('name', action_conn['exchange_name'])
                return bad_request(
                    f"Withdraw Crypto is not supported for {exchange_label}. "
                    f"Only 'Convert Crypto' is available for this exchange."
                )

        # Validate trigger params
        trigger_order_id = data.get('trigger_order_id', '').strip() or None
        trigger_pair = data.get('trigger_pair', '').strip() or None
        trigger_side = data.get('trigger_side', '').strip() or None

        if trigger_type == 'order_filled' and not trigger_order_id:
            return bad_request("Order ID is required for 'order_filled' trigger")

        # Validate balance_threshold trigger params
        trigger_asset = data.get('trigger_asset', '').strip() or None
        trigger_threshold = data.get('trigger_threshold', '').strip() or None
        trigger_price_quote_asset = data.get('trigger_price_quote_asset', '').strip().upper() or None
        cooldown_minutes = data.get('cooldown_minutes', 1440)

        if trigger_type in ('balance_threshold', 'price_threshold'):
            if not trigger_asset:
                return bad_request("Asset is required for this trigger")
            if not trigger_threshold:
                return bad_request("Threshold value is required for this trigger")
            try:
                threshold_val = float(trigger_threshold)
                if threshold_val <= 0:
                    return bad_request("Threshold must be a positive number")
            except (ValueError, TypeError):
                return bad_request("Threshold must be a valid number")
            try:
                cooldown_minutes = int(cooldown_minutes)
                if cooldown_minutes < 1:
                    return bad_request("Cooldown must be at least 1 minute")
            except (ValueError, TypeError):
                return bad_request("Cooldown must be a valid number")

        if trigger_type == 'price_threshold' and not trigger_price_quote_asset:
            return bad_request("Quote asset is required for 'price_threshold' trigger")

        # Validate action params
        action_asset = data.get('action_asset', '').strip() or None
        action_address_key = data.get('action_address_key', '').strip() or None
        action_amount = data.get('action_amount', '').strip() or None
        action_amount_mode = data.get('action_amount_mode', '').strip() or None
        use_filled_amount = bool(data.get('use_filled_amount', False))
        convert_to_asset = data.get('convert_to_asset', '').strip() or None
        max_executions = data.get('max_executions', None)

        if max_executions in ('', None):
            max_executions = None
        else:
            try:
                max_executions = int(max_executions)
                if max_executions < 1:
                    return bad_request("Max executions must be at least 1")
            except (ValueError, TypeError):
                return bad_request("Max executions must be a valid number")

        if action_type == 'withdraw_crypto':
            if not action_asset:
                return bad_request("Asset is required for withdraw action")
            if not action_address_key:
                return bad_request("Withdrawal address key is required for withdraw action")
            if trigger_type == 'balance_threshold':
                # For balance_threshold, amount is the balance itself; no fixed amount needed
                pass
            elif not use_filled_amount and not action_amount:
                return bad_request("Amount is required for withdraw action (or enable 'Use Filled Amount')")

            # Validate fixed amount against minimum withdrawal (with cushion)
            if not use_filled_amount and action_amount and trigger_type != 'balance_threshold':
                try:
                    amount_val = float(action_amount)
                    action_exchange_name = action_conn['exchange_name']
                    min_withdrawal = get_minimum_withdrawal(action_exchange_name, action_asset)
                    if min_withdrawal > 0 and amount_val < min_withdrawal:
                        return bad_request(
                            f"Amount {amount_val} is below the minimum withdrawal of "
                            f"{min_withdrawal:.6g} {action_asset} (includes 10% buffer)"
                        )
                except (ValueError, TypeError):
                    pass

        elif action_type == 'convert_crypto':
            if trigger_type not in ('balance_threshold', 'price_threshold', 'order_filled'):
                return bad_request("Convert Crypto is not available for this trigger")
            if not action_asset:
                return bad_request("Source asset is required for convert action")
            if not convert_to_asset:
                return bad_request("Target asset is required for convert action")
            if action_asset == convert_to_asset:
                return bad_request("Source and target assets must be different")

            if trigger_type == 'price_threshold':
                if action_asset != trigger_asset:
                    return bad_request("Price threshold source asset must match monitored trigger asset")
                if action_amount_mode not in ('all', 'percent', 'fixed'):
                    return bad_request("Price threshold requires amount mode: all, percent, or fixed")
                if action_amount_mode == 'all':
                    action_amount = ''
                elif not action_amount:
                    return bad_request("Amount is required for percent/fixed amount modes")

            # Validate optional or required amount (based on mode)
            if action_amount_mode in ('percent', 'fixed') and action_amount:
                try:
                    amount_val = float(action_amount)
                    if amount_val <= 0:
                        return bad_request("Convert amount must be a positive number")
                    if action_amount_mode == 'percent' and amount_val > 100:
                        return bad_request("Percent amount must be between 0 and 100")
                except (ValueError, TypeError):
                    return bad_request("Convert amount must be a valid number")
            elif action_amount and trigger_type in ('balance_threshold', 'order_filled'):
                try:
                    amount_val = float(action_amount)
                    if amount_val <= 0:
                        return bad_request("Convert amount must be a positive number")
                except (ValueError, TypeError):
                    return bad_request("Convert amount must be a valid number")
            action_address_key = ''  # not used for conversions

        rule_id = AutomationDbContext.create_rule(
            user_id=request.user_id,
            rule_name=rule_name,
            trigger_type=trigger_type,
            action_type=action_type,
            trigger_order_id=trigger_order_id,
            trigger_pair=trigger_pair,
            trigger_side=trigger_side,
            action_asset=action_asset,
            action_address_key=action_address_key,
            action_amount=action_amount,
            use_filled_amount=use_filled_amount,
            trigger_asset=trigger_asset,
            trigger_threshold=trigger_threshold,
            cooldown_minutes=cooldown_minutes,
            trigger_exchange_id=trigger_exchange_id,
            action_exchange_id=action_exchange_id,
            convert_to_asset=convert_to_asset,
            trigger_price_quote_asset=trigger_price_quote_asset,
            action_amount_mode=action_amount_mode,
            max_executions=max_executions,
        )

        rule = AutomationDbContext.get_rule_by_id(rule_id, request.user_id)
        return created_response(data=rule.to_dict(), message="Automation rule created")

    except Exception as e:
        return handle_error(e)


@automation_bp.route('/rules/<int:rule_id>', methods=['GET'])
@token_required
@active_required
def get_rule(rule_id):
    try:
        rule = AutomationDbContext.get_rule_by_id(rule_id, request.user_id)
        if not rule:
            return not_found("Rule not found")
        return success_response(data=rule.to_dict())
    except Exception as e:
        return handle_error(e)


@automation_bp.route('/rules/<int:rule_id>', methods=['PUT'])
@token_required
@active_required
def update_rule(rule_id):
    try:
        rule = AutomationDbContext.get_rule_by_id(rule_id, request.user_id)
        if not rule:
            return not_found("Rule not found")

        if rule.trigger_type == ALLOCATION_TRIGGER:
            # Caps are only coherent as a set (they share one portfolio), so they
            # are edited through PUT /allocations/<conn_id> instead.
            return bad_request(
                "Portfolio balancer rules are edited on the Balancer page."
            )

        data = request.get_json()
        if not data:
            return bad_request("No data provided")

        updates = {}

        # Always editable: rule name
        if 'rule_name' in data:
            rule_name = str(data['rule_name']).strip()
            if not rule_name:
                return bad_request("Rule name cannot be empty")
            updates['rule_name'] = rule_name

        # Always editable: max_executions
        if 'max_executions' in data:
            max_exec = data['max_executions']
            if max_exec in (None, '', 'null'):
                updates['max_executions'] = None
            else:
                try:
                    max_exec = int(max_exec)
                    if max_exec < 1:
                        return bad_request("Max executions must be at least 1")
                    updates['max_executions'] = max_exec
                except (ValueError, TypeError):
                    return bad_request("Max executions must be a valid number")

        # Threshold + cooldown (balance_threshold / price_threshold)
        if rule.trigger_type in ('balance_threshold', 'price_threshold'):
            if 'trigger_threshold' in data:
                try:
                    threshold_val = float(data['trigger_threshold'])
                    if threshold_val <= 0:
                        return bad_request("Threshold must be a positive number")
                    updates['trigger_threshold'] = str(threshold_val)
                except (ValueError, TypeError):
                    return bad_request("Threshold must be a valid number")

            if 'cooldown_minutes' in data:
                try:
                    cooldown = int(data['cooldown_minutes'])
                    if cooldown < 1:
                        return bad_request("Cooldown must be at least 1 minute")
                    updates['cooldown_minutes'] = cooldown
                except (ValueError, TypeError):
                    return bad_request("Cooldown must be a valid number")

        # Price threshold specific
        if rule.trigger_type == 'price_threshold':
            if 'trigger_price_quote_asset' in data:
                quote = str(data['trigger_price_quote_asset']).strip().upper()
                if quote not in ('USD', 'USDT', 'USDC'):
                    return bad_request("Invalid quote asset")
                updates['trigger_price_quote_asset'] = quote

            if 'action_amount_mode' in data:
                mode = str(data['action_amount_mode']).strip().lower()
                if mode not in ('all', 'percent', 'fixed'):
                    return bad_request("Invalid amount mode")
                updates['action_amount_mode'] = mode

            if 'action_amount' in data:
                mode = updates.get('action_amount_mode', rule.action_amount_mode or 'all')
                if mode == 'all':
                    updates['action_amount'] = ''
                else:
                    try:
                        amt = float(data['action_amount'])
                        if amt <= 0:
                            return bad_request("Amount must be positive")
                        if mode == 'percent' and amt > 100:
                            return bad_request("Percent must be between 1 and 100")
                        updates['action_amount'] = str(amt)
                    except (ValueError, TypeError):
                        return bad_request("Amount must be a valid number")

        # Withdraw address (both order_filled and balance_threshold with withdraw action)
        if rule.action_type == 'withdraw_crypto':
            if 'action_address_key' in data:
                addr = str(data['action_address_key']).strip()
                if not addr:
                    return bad_request("Withdrawal address key cannot be empty")
                updates['action_address_key'] = addr

            # order_filled: fixed amount or use_filled_amount
            if rule.trigger_type == 'order_filled':
                if 'use_filled_amount' in data:
                    updates['use_filled_amount'] = bool(data['use_filled_amount'])

                if 'action_amount' in data:
                    use_filled = updates.get('use_filled_amount', rule.use_filled_amount)
                    if not use_filled:
                        try:
                            amt = float(data['action_amount'])
                            if amt <= 0:
                                return bad_request("Amount must be positive")
                            updates['action_amount'] = str(amt)
                        except (ValueError, TypeError):
                            return bad_request("Amount must be a valid number")

        # Convert action (balance_threshold)
        if rule.action_type == 'convert_crypto' and rule.trigger_type == 'balance_threshold':
            if 'convert_to_asset' in data:
                target = str(data['convert_to_asset']).strip().upper()
                if not target:
                    return bad_request("Target asset cannot be empty")
                if target == (rule.action_asset or '').upper():
                    return bad_request("Source and target assets must be different")
                updates['convert_to_asset'] = target

            if 'action_amount' in data:
                amt_str = str(data['action_amount']).strip()
                if amt_str:
                    try:
                        amt = float(amt_str)
                        if amt <= 0:
                            return bad_request("Convert amount must be positive")
                        updates['action_amount'] = str(amt)
                    except (ValueError, TypeError):
                        return bad_request("Convert amount must be a valid number")
                else:
                    updates['action_amount'] = ''

        if not updates:
            return bad_request("No valid fields to update")

        AutomationDbContext.update_rule(rule_id, request.user_id, **updates)
        updated_rule = AutomationDbContext.get_rule_by_id(rule_id, request.user_id)
        return success_response(data=updated_rule.to_dict(), message="Rule updated")

    except Exception as e:
        return handle_error(e)


@automation_bp.route('/rules/<int:rule_id>/toggle', methods=['PUT'])
@token_required
@active_required
def toggle_rule(rule_id):
    try:
        rule = AutomationDbContext.get_rule_by_id(rule_id, request.user_id)
        if not rule:
            return not_found("Rule not found")

        new_state = not rule.is_active
        AutomationDbContext.toggle_rule(rule_id, request.user_id, new_state)

        state_text = "enabled" if new_state else "disabled"
        return success_response(message=f"Rule {state_text}")

    except Exception as e:
        return handle_error(e)


@automation_bp.route('/rules/<int:rule_id>', methods=['DELETE'])
@token_required
@active_required
def delete_rule(rule_id):
    try:
        rule = AutomationDbContext.get_rule_by_id(rule_id, request.user_id)
        if not rule:
            return not_found("Rule not found")

        AutomationDbContext.delete_rule(rule_id, request.user_id)
        return success_response(message="Rule deleted")

    except Exception as e:
        return handle_error(e)


# ---------------------------------------------------------------------------
# Portfolio balancer
#
# One 'allocation_threshold' rule per capped position: "when ASSET grows past
# max_percent of this connection's portfolio, convert the excess back down to
# target_percent". The Balancer page reads and writes the whole set at once, so
# these two endpoints replace the per-rule create/update path.
# ---------------------------------------------------------------------------

def _validated_rebalance_connection(conn_id: int):
    """Resolve a connection for balancer use. Returns ``(row, error_response)``."""
    conn = ExchangeConnectionDbContext.get_connection(conn_id, request.user_id)
    if not conn:
        return None, not_found("Exchange connection not found")
    if not conn['is_validated']:
        return None, bad_request("Exchange connection keys are not validated")
    if not supports_rebalance(conn['exchange_name']):
        meta = SUPPORTED_EXCHANGES.get(conn['exchange_name'], {})
        label = meta.get('name', conn['exchange_name'])
        return None, bad_request(f"The portfolio balancer is not supported for {label}.")
    return conn, None


def _allocation_settings(rules: list) -> dict:
    """Page-level balancer settings, read off the existing rules.

    Cooldown / minimum trade / simulate apply to a whole connection, but they
    live on each rule (no separate settings table), so every rule in a set
    carries the same values and any one of them can be read back.
    """
    for rule in rules:
        return {
            'cooldown_minutes': int(rule.cooldown_minutes or DEFAULT_REBALANCE_COOLDOWN),
            'min_trade_usd': float(rule.min_trade_usd or DEFAULT_MIN_TRADE_USD),
            'dry_run': bool(rule.dry_run),
        }
    return {
        'cooldown_minutes': DEFAULT_REBALANCE_COOLDOWN,
        'min_trade_usd': DEFAULT_MIN_TRADE_USD,
        'dry_run': False,
    }


def _allocation_row(asset: str, amount: float, usd_value: float, total_usd: float,
                    rule, targets: list, min_trade_usd: float) -> dict:
    """One bar on the balancer chart: current weight + its cap, if any."""
    weight = (usd_value / total_usd * 100.0) if total_usd > 0 else 0.0
    row = {
        'asset': asset,
        'amount': amount,
        'usd_value': usd_value,
        'weight_percent': round(weight, 4),
        'held': amount > 0,
        'convert_targets': targets,
        'rule_id': None,
        'enabled': False,
        'max_percent': None,
        'target_percent': None,
        'convert_to_asset': None,
        'excess_usd': 0.0,
        'would_convert_amount': 0.0,
        'over_cap': False,
    }
    if rule is None:
        return row

    cap = rule.allocation_cap()
    target = rule.allocation_target()
    row.update({
        'rule_id': rule.id,
        'enabled': bool(rule.is_active),
        'max_percent': cap,
        'target_percent': target,
        'convert_to_asset': rule.convert_to_asset,
        'trigger_count': rule.trigger_count,
        'last_triggered_at': rule.to_dict().get('last_triggered_at'),
    })

    # Live preview of what this rule would do right now — the same arithmetic the
    # worker uses, so the page can't promise something the worker won't do.
    if cap is not None and weight >= cap and total_usd > 0 and amount > 0:
        excess_usd = (weight - target) / 100.0 * total_usd
        unit_price = usd_value / amount
        row['over_cap'] = True
        row['excess_usd'] = round(excess_usd, 2)
        if unit_price > 0 and excess_usd >= min_trade_usd:
            row['would_convert_amount'] = min(excess_usd / unit_price, amount)
    return row


@automation_bp.route('/allocations/<int:conn_id>', methods=['GET'])
@token_required
@active_required
def get_allocations(conn_id):
    """Current holdings + their configured caps for one connection."""
    try:
        conn, err = _validated_rebalance_connection(conn_id)
        if err:
            return err

        from helper.ExchangeClient import get_portfolio, available_convert_targets

        exchange = get_user_exchange(request.user_id, conn_id)
        portfolio = get_portfolio(exchange)
        positions = portfolio.get('positions', [])
        total_usd = float(portfolio.get('total_usd') or 0)

        rules = AutomationDbContext.get_allocation_rules(request.user_id, conn_id)
        rules_by_asset = {(r.action_asset or '').upper(): r for r in rules}
        settings = _allocation_settings(rules)

        rows = []
        seen = set()
        for p in positions:
            asset = str(p['asset']).upper()
            seen.add(asset)
            rows.append(_allocation_row(
                asset, float(p['amount']), float(p['usd_value']), total_usd,
                rules_by_asset.get(asset),
                available_convert_targets(exchange, asset, REBALANCE_TARGET_CANDIDATES),
                settings['min_trade_usd'],
            ))

        # Caps on assets that are no longer held: keep them visible so they can
        # be removed deliberately rather than vanishing from the page.
        for asset, rule in rules_by_asset.items():
            if asset in seen:
                continue
            rows.append(_allocation_row(
                asset, 0.0, 0.0, total_usd, rule,
                available_convert_targets(exchange, asset, REBALANCE_TARGET_CANDIDATES),
                settings['min_trade_usd'],
            ))

        rows.sort(key=lambda r: r['usd_value'], reverse=True)

        return success_response(data={
            'connection': {
                'id': conn_id,
                'exchange_name': conn['exchange_name'],
                'label': conn['label'],
            },
            'total_usd': total_usd,
            'settings': settings,
            'positions': rows,
        })

    except Exception as e:
        return handle_error(e)


@automation_bp.route('/allocations/<int:conn_id>', methods=['PUT'])
@token_required
@active_required
def save_allocations(conn_id):
    """Replace the balancer configuration for one connection.

    Positions present in the payload are created or updated; existing caps left
    out of it are deleted. ``enabled: false`` keeps a cap's configuration but
    pauses the rule.
    """
    try:
        conn, err = _validated_rebalance_connection(conn_id)
        if err:
            return err

        data = request.get_json() or {}
        raw_positions = data.get('positions')
        if raw_positions is None or not isinstance(raw_positions, list):
            return bad_request("positions must be a list")

        settings = data.get('settings') or {}
        try:
            cooldown_minutes = int(settings.get('cooldown_minutes', DEFAULT_REBALANCE_COOLDOWN))
            if cooldown_minutes < 1:
                return bad_request("Cooldown must be at least 1 minute")
        except (TypeError, ValueError):
            return bad_request("Cooldown must be a valid number")

        try:
            min_trade_usd = float(settings.get('min_trade_usd', DEFAULT_MIN_TRADE_USD))
            if min_trade_usd < 0:
                return bad_request("Minimum trade size cannot be negative")
        except (TypeError, ValueError):
            return bad_request("Minimum trade size must be a valid number")

        dry_run = bool(settings.get('dry_run', False))

        # Validate everything before writing anything — a half-applied set of
        # caps is worse than a rejected save.
        cleaned = []
        seen_assets = set()
        for item in raw_positions:
            if not isinstance(item, dict):
                return bad_request("Each position must be an object")

            asset = str(item.get('asset') or '').strip().upper()
            if not asset:
                return bad_request("Each position needs an asset")
            if asset in seen_assets:
                return bad_request(f"Duplicate cap for {asset}")
            seen_assets.add(asset)

            try:
                max_percent = float(item.get('max_percent'))
            except (TypeError, ValueError):
                return bad_request(f"{asset}: maximum allocation must be a number")
            if not 0 < max_percent <= 100:
                return bad_request(f"{asset}: maximum allocation must be between 0 and 100%")

            target_raw = item.get('target_percent')
            if target_raw in (None, ''):
                target_percent = max(0.0, max_percent - DEFAULT_HYSTERESIS_POINTS)
            else:
                try:
                    target_percent = float(target_raw)
                except (TypeError, ValueError):
                    return bad_request(f"{asset}: rebalance target must be a number")
            if target_percent < 0:
                return bad_request(f"{asset}: rebalance target cannot be negative")
            if target_percent >= max_percent:
                return bad_request(
                    f"{asset}: rebalance target ({target_percent:g}%) must be below the "
                    f"maximum ({max_percent:g}%) — otherwise the rule re-fires every cycle"
                )

            convert_to = str(item.get('convert_to_asset') or '').strip().upper()
            if not convert_to:
                return bad_request(f"{asset}: choose an asset to convert into")
            if convert_to == asset:
                return bad_request(f"{asset}: cannot convert into itself")

            cleaned.append({
                'asset': asset,
                'max_percent': max_percent,
                'target_percent': target_percent,
                'convert_to_asset': convert_to,
                'enabled': bool(item.get('enabled', True)),
            })

        # Reject targets the exchange can't actually trade. Best-effort: if the
        # market list is unavailable right now, don't block the save — the worker
        # logs a per-rule error if a pair turns out to be missing.
        from helper.ExchangeClient import has_convert_pair
        exchange = None
        try:
            exchange = get_user_exchange(request.user_id, conn_id)
            exchange.load_markets()
        except Exception as e:
            exchange = None
            print(f"[BALANCER] Skipping pair validation for conn {conn_id}: {e}")

        if exchange is not None:
            for item in cleaned:
                if not has_convert_pair(exchange, item['asset'], item['convert_to_asset']):
                    return bad_request(
                        f"{conn['exchange_name'].title()} has no market to convert "
                        f"{item['asset']} into {item['convert_to_asset']}."
                    )

        existing = {(r.action_asset or '').upper(): r
                    for r in AutomationDbContext.get_allocation_rules(request.user_id, conn_id)}

        for item in cleaned:
            asset = item['asset']
            rule_name = f"Balance {asset} → {item['convert_to_asset']}"
            rule = existing.pop(asset, None)
            if rule:
                AutomationDbContext.update_rule(
                    rule.id, request.user_id,
                    rule_name=rule_name,
                    convert_to_asset=item['convert_to_asset'],
                    trigger_allocation_percent=str(item['max_percent']),
                    rebalance_target_percent=str(item['target_percent']),
                    cooldown_minutes=cooldown_minutes,
                    min_trade_usd=str(min_trade_usd),
                    dry_run=1 if dry_run else 0,
                    is_active=1 if item['enabled'] else 0,
                )
            else:
                new_rule_id = AutomationDbContext.create_rule(
                    user_id=request.user_id,
                    rule_name=rule_name,
                    trigger_type=ALLOCATION_TRIGGER,
                    action_type='convert_crypto',
                    action_asset=asset,
                    trigger_asset=asset,
                    convert_to_asset=item['convert_to_asset'],
                    trigger_allocation_percent=str(item['max_percent']),
                    rebalance_target_percent=str(item['target_percent']),
                    cooldown_minutes=cooldown_minutes,
                    min_trade_usd=str(min_trade_usd),
                    dry_run=dry_run,
                    trigger_exchange_id=conn_id,
                    action_exchange_id=conn_id,
                    action_address_key='',
                )
                if not item['enabled']:
                    AutomationDbContext.toggle_rule(new_rule_id, request.user_id, False)

        # Anything still in `existing` was removed on the page.
        for rule in existing.values():
            AutomationDbContext.delete_rule(rule.id, request.user_id)

        return success_response(message="Balancer saved")

    except Exception as e:
        return handle_error(e)


@automation_bp.route('/withdrawal-minimums', methods=['GET'])
@token_required
@active_required
def get_withdrawal_minimums():
    try:
        exchange_name = request.args.get('exchange', 'kraken').strip().lower()
        minimums = get_all_minimums(exchange_name)
        return success_response(data=minimums)
    except Exception as e:
        return handle_error(e)


@automation_bp.route('/worker-status', methods=['GET'])
@token_required
@active_required
def worker_status():
    """Liveness of the background automation worker.

    Served by a Flask request thread, so it still answers when the worker
    thread itself is dead or blocked — which is the case this exists to catch.
    Imported lazily to keep Routes.py -> controllers import order independent
    of the worker module.
    """
    try:
        from automation.worker import get_worker_status
        return success_response(data=get_worker_status())
    except Exception as e:
        return handle_error(e)


@automation_bp.route('/logs', methods=['GET'])
@token_required
@active_required
def get_logs():
    try:
        limit = request.args.get('limit', 50, type=int)
        limit = min(limit, 200)
        logs = AutomationDbContext.get_logs_by_user(request.user_id, limit)
        return success_response(data=[l.to_dict() for l in logs])
    except Exception as e:
        return handle_error(e)


@automation_bp.route('/rules/<int:rule_id>/logs', methods=['GET'])
@token_required
@active_required
def get_rule_logs(rule_id):
    try:
        rule = AutomationDbContext.get_rule_by_id(rule_id, request.user_id)
        if not rule:
            return not_found("Rule not found")

        logs = AutomationDbContext.get_logs_by_rule(rule_id, request.user_id)
        return success_response(data=[l.to_dict() for l in logs])
    except Exception as e:
        return handle_error(e)
