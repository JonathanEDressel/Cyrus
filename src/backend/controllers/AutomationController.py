from flask import Blueprint, request
from controllers.AutomationDbContext import AutomationDbContext
from controllers.ExchangeConnectionDbContext import ExchangeConnectionDbContext
from helper.Security import token_required, active_required
from helper.ErrorHandler import handle_error, bad_request, not_found
from helper.Helper import success_response, created_response
from helper.ExchangeRegistry import get_minimum_withdrawal, get_all_minimums

automation_bp = Blueprint('automation', __name__)

VALID_TRIGGER_TYPES = ['order_filled', 'balance_threshold']
VALID_ACTION_TYPES = ['withdraw_crypto', 'convert_crypto']


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

        # Validate trigger params
        trigger_order_id = data.get('trigger_order_id', '').strip() or None
        trigger_pair = data.get('trigger_pair', '').strip() or None
        trigger_side = data.get('trigger_side', '').strip() or None

        if trigger_type == 'order_filled' and not trigger_order_id:
            return bad_request("Order ID is required for 'order_filled' trigger")

        # Validate balance_threshold trigger params
        trigger_asset = data.get('trigger_asset', '').strip() or None
        trigger_threshold = data.get('trigger_threshold', '').strip() or None
        cooldown_minutes = data.get('cooldown_minutes', 1440)

        if trigger_type == 'balance_threshold':
            if not trigger_asset:
                return bad_request("Asset is required for 'balance_threshold' trigger")
            if not trigger_threshold:
                return bad_request("Threshold amount is required for 'balance_threshold' trigger")
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

        # Validate action params
        action_asset = data.get('action_asset', '').strip() or None
        action_address_key = data.get('action_address_key', '').strip() or None
        action_amount = data.get('action_amount', '').strip() or None
        use_filled_amount = bool(data.get('use_filled_amount', False))
        convert_to_asset = data.get('convert_to_asset', '').strip() or None

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
            if trigger_type != 'balance_threshold':
                return bad_request("Convert Crypto is only available with the Balance Threshold trigger")
            if not action_asset:
                return bad_request("Source asset is required for convert action")
            if not convert_to_asset:
                return bad_request("Target asset is required for convert action")
            if action_asset == convert_to_asset:
                return bad_request("Source and target assets must be different")
            # Validate optional fixed amount
            if action_amount:
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
