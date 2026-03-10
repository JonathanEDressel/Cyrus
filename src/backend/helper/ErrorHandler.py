import traceback
from flask import jsonify


def handle_error(e, status_code=500):
    error_message = str(e)
    trace = traceback.format_exc()
    
    print(f"[ERROR] {error_message}")
    print(trace)
    
    return jsonify({
        "success": False,
        "result": error_message
    }), status_code


def bad_request(message="Bad request"):
    return jsonify({
        "success": False,
        "result": message
    }), 400


def unauthorized(message="Unauthorized"):
    return jsonify({
        "success": False,
        "result": message
    }), 401


def not_found(message="Not found"):
    return jsonify({
        "success": False,
        "result": message
    }), 404
