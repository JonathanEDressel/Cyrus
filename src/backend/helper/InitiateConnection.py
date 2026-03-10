import mysql.connector
from flask import current_app


def get_db_connection():
    conn = mysql.connector.connect(
        host=current_app.config['MYSQL_HOST'],
        port=current_app.config['MYSQL_PORT'],
        user=current_app.config['MYSQL_USER'],
        password=current_app.config['MYSQL_PASSWORD'],
        database=current_app.config['MYSQL_DATABASE']
    )
    return conn


def get_cursor(conn, dictionary=True):
    return conn.cursor(dictionary=dictionary)
