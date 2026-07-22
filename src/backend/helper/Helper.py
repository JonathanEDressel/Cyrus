from flask import jsonify
from typing import Any, Optional, Tuple, List, Dict
from helper.InitiateConnection import get_db_connection


def success_response(data=None, message="Success"):
    response = {
        "success": True,
        "result": message
    }
    if data is not None:
        response["data"] = data
    return jsonify(response), 200


def created_response(data=None, message="Created successfully"):
    response = {
        "success": True,
        "result": message
    }
    if data is not None:
        response["data"] = data
    return jsonify(response), 201


def execute_query_one(sql: str, params: Optional[Tuple] = None, as_dict: bool = True) -> Optional[Dict[str, Any]]:
    conn = get_db_connection()
    try:
        cursor = conn.execute(sql, params or ())
        row = cursor.fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def execute_query_all(sql: str, params: Optional[Tuple] = None, as_dict: bool = True) -> List[Dict[str, Any]]:
    conn = get_db_connection()
    try:
        cursor = conn.execute(sql, params or ())
        return [dict(r) for r in cursor.fetchall()]
    finally:
        conn.close()


def execute_non_query(sql: str, params: Optional[Tuple] = None) -> int:
    conn = get_db_connection()
    try:
        cursor = conn.execute(sql, params or ())
        conn.commit()
        return cursor.rowcount
    finally:
        conn.close()


def execute_insert(sql: str, params: Optional[Tuple] = None) -> int:
    conn = get_db_connection()
    try:
        cursor = conn.execute(sql, params or ())
        conn.commit()
        return cursor.lastrowid
    finally:
        conn.close()


def execute_scalar(sql: str, params: Optional[Tuple] = None) -> Any:
    conn = get_db_connection()
    try:
        cursor = conn.execute(sql, params or ())
        row = cursor.fetchone()
        return row[0] if row else None
    finally:
        conn.close()
