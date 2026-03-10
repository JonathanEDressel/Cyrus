from flask import Blueprint, request
from controllers.AutomationDbContext import AutomationDbContext
from helper.Security import token_required
from helper.ErrorHandler import handle_error, bad_request, not_found
from helper.Helper import success_response, created_response

automation_bp = Blueprint('automation', __name__)

VALID_TRIGGER_TYPES = ['order_filled']
VALID_ACTION_TYPES = ['withdraw_crypto']


@automation_bp.route('/rules', methods=['GET'])
@token_required
def get_rules():
    try:
        rules = AutomationDbContext.get_rules_by_user(request.user_id)
        return success_response(data=[r.to_dict() for r in rules])
    except Exception as e:
        return handle_error(e)


@automation_bp.route('/rules', methods=['POST'])
@token_required
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

        # Validate trigger params
        trigger_order_id = data.get('trigger_order_id', '').strip() or None
        trigger_pair = data.get('trigger_pair', '').strip() or None
        trigger_side = data.get('trigger_side', '').strip() or None

        if trigger_type == 'order_filled' and not trigger_order_id:
            return bad_request("Order ID is required for 'order_filled' trigger")

        # Validate action params
        action_asset = data.get('action_asset', '').strip() or None
        action_address_key = data.get('action_address_key', '').strip() or None
        action_amount = data.get('action_amount', '').strip() or None

        if action_type == 'withdraw_crypto':
            if not action_asset:
                return bad_request("Asset is required for withdraw action")
            if not action_address_key:
                return bad_request("Withdrawal address key is required for withdraw action")
            if not action_amount:
                return bad_request("Amount is required for withdraw action")

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
        )

        rule = AutomationDbContext.get_rule_by_id(rule_id, request.user_id)
        return created_response(data=rule.to_dict(), message="Automation rule created")

    except Exception as e:
        return handle_error(e)


@automation_bp.route('/rules/<int:rule_id>', methods=['GET'])
@token_required
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
def delete_rule(rule_id):
    try:
        rule = AutomationDbContext.get_rule_by_id(rule_id, request.user_id)
        if not rule:
            return not_found("Rule not found")

        AutomationDbContext.delete_rule(rule_id, request.user_id)
        return success_response(message="Rule deleted")

    except Exception as e:
        return handle_error(e)


@automation_bp.route('/logs', methods=['GET'])
@token_required
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
def get_rule_logs(rule_id):
    try:
        rule = AutomationDbContext.get_rule_by_id(rule_id, request.user_id)
        if not rule:
            return not_found("Rule not found")

        logs = AutomationDbContext.get_logs_by_rule(rule_id, request.user_id)
        return success_response(data=[l.to_dict() for l in logs])
    except Exception as e:
        return handle_error(e)
