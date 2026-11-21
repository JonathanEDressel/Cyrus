from flask import current_app

from helper import DbCrypto


def get_db_connection():
    # SQLCipher: the file is encrypted on disk (see helper/DbCrypto.py).
    conn = DbCrypto.connect(
        current_app.config['DATABASE_PATH'],
        current_app.config['SECRET_KEY'],
        check_same_thread=False
    )
    conn.row_factory = DbCrypto.Row
    conn.execute('PRAGMA foreign_keys = ON')
    conn.execute('PRAGMA journal_mode = WAL')
    return conn
