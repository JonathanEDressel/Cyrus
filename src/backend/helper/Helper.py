from flask import jsonify
from typing import Any, Optional, Tuple, List, Dict
from helper.InitiateConnection import get_db_connection


# ============================================================================
# API Response Helpers
# ============================================================================

def success_response(data=None, message="Success"):
    """Standard success response."""
    response = {
        "success": True,
        "result": message
    }
    if data is not None:
        response["data"] = data
    return jsonify(response), 200


def created_response(data=None, message="Created successfully"):
    """Standard created response."""
    response = {
        "success": True,
        "result": message
    }
    if data is not None:
        response["data"] = data
    return jsonify(response), 201


# ============================================================================
# Database Query Helpers
# ============================================================================

def execute_query_one(sql: str, params: Optional[Tuple] = None, as_dict: bool = True) -> Optional[Dict[str, Any]]:
    """
    Execute a SELECT query and return one row.
    
    Args:
        sql: SQL query string with %s placeholders
        params: Tuple of parameters for the query
        as_dict: If True, return row as dictionary; if False, return as tuple
    
    Returns:
        Dictionary (or tuple) representing the row, or None if no results
    """
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=as_dict)
    try:
        cursor.execute(sql, params or ())
        return cursor.fetchone()
    finally:
        cursor.close()
        conn.close()


def execute_query_all(sql: str, params: Optional[Tuple] = None, as_dict: bool = True) -> List[Dict[str, Any]]:
    """
    Execute a SELECT query and return all rows.
    
    Args:
        sql: SQL query string with %s placeholders
        params: Tuple of parameters for the query
        as_dict: If True, return rows as dictionaries; if False, return as tuples
    
    Returns:
        List of dictionaries (or tuples) representing the rows
    """
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=as_dict)
    try:
        cursor.execute(sql, params or ())
        return cursor.fetchall()
    finally:
        cursor.close()
        conn.close()


def execute_non_query(sql: str, params: Optional[Tuple] = None) -> int:
    """
    Execute an INSERT, UPDATE, or DELETE query.
    
    Args:
        sql: SQL query string with %s placeholders
        params: Tuple of parameters for the query
    
    Returns:
        Number of rows affected
    """
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(sql, params or ())
        conn.commit()
        return cursor.rowcount
    finally:
        cursor.close()
        conn.close()


def execute_insert(sql: str, params: Optional[Tuple] = None) -> int:
    """
    Execute an INSERT query and return the last inserted ID.
    
    Args:
        sql: SQL INSERT query string with %s placeholders
        params: Tuple of parameters for the query
    
    Returns:
        The ID of the newly inserted row
    """
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(sql, params or ())
        conn.commit()
        return cursor.lastrowid
    finally:
        cursor.close()
        conn.close()


def execute_scalar(sql: str, params: Optional[Tuple] = None) -> Any:
    """
    Execute a SELECT query and return a single value (first column of first row).
    Useful for COUNT, EXISTS checks, or single-value queries.
    
    Args:
        sql: SQL query string with %s placeholders
        params: Tuple of parameters for the query
    
    Returns:
        The scalar value, or None if no results
    """
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(sql, params or ())
        row = cursor.fetchone()
        return row[0] if row else None
    finally:
        cursor.close()
        conn.close()
