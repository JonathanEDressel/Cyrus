import mysql.connector
from helper.InitiateConnection import get_db_connection


def setup_database():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    try:
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

        cursor.execute('''
            CREATE TABLE IF NOT EXISTS automation_rules (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                rule_name VARCHAR(255) NOT NULL,
                trigger_type VARCHAR(50) NOT NULL,
                trigger_order_id VARCHAR(255),
                trigger_pair VARCHAR(50),
                trigger_side VARCHAR(10),
                action_type VARCHAR(50) NOT NULL,
                action_asset VARCHAR(20),
                action_address_key VARCHAR(255),
                action_amount VARCHAR(50),
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_triggered_at TIMESTAMP NULL,
                trigger_count INT DEFAULT 0,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_user_active (user_id, is_active)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ''')

        cursor.execute('''
            CREATE TABLE IF NOT EXISTS order_snapshots (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                order_id VARCHAR(255) NOT NULL,
                pair VARCHAR(50),
                side VARCHAR(10),
                status VARCHAR(50),
                volume VARCHAR(50),
                filled VARCHAR(50),
                last_checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_user_order (user_id, order_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ''')

        cursor.execute('''
            CREATE TABLE IF NOT EXISTS automation_log (
                id INT AUTO_INCREMENT PRIMARY KEY,
                rule_id INT NOT NULL,
                user_id INT NOT NULL,
                trigger_event TEXT,
                action_executed TEXT,
                action_result TEXT,
                status VARCHAR(20) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (rule_id) REFERENCES automation_rules(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_user_log (user_id, created_at)
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
