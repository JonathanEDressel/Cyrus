import mysql.connector
from helper.InitiateConnection import get_db_connection


def setup_database():
    """Create database tables if they don't exist."""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    try:
        # Users table with last_login column
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                kraken_api_key_encrypted TEXT,
                kraken_private_key_encrypted TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP NULL,
                INDEX idx_username (username)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ''')
        
        conn.commit()
        print("[DATABASE] Tables created/verified successfully")
        
    except mysql.connector.Error as e:
        print(f"[DATABASE ERROR] {e}")
        conn.rollback()
    finally:
        cursor.close()
        conn.close()
