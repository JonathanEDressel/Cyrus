from helper.InitiateConnection import get_db_connection


def setup_database():
    conn = get_db_connection()
    
    try:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                kraken_api_key_encrypted TEXT,
                kraken_private_key_encrypted TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_login DATETIME NULL
            )
        ''')

        conn.execute('''
            CREATE TABLE IF NOT EXISTS automation_rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                rule_name TEXT NOT NULL,
                trigger_type TEXT NOT NULL,
                trigger_order_id TEXT,
                trigger_pair TEXT,
                trigger_side TEXT,
                action_type TEXT NOT NULL,
                action_asset TEXT,
                action_address_key TEXT,
                action_amount TEXT,
                use_filled_amount BOOLEAN DEFAULT 0,
                trigger_asset TEXT,
                trigger_threshold TEXT,
                last_executed_at DATETIME NULL,
                cooldown_minutes INTEGER DEFAULT 1440,
                is_active BOOLEAN DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_triggered_at DATETIME NULL,
                trigger_count INTEGER DEFAULT 0,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        ''')

        conn.execute('''
            CREATE TABLE IF NOT EXISTS order_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                order_id TEXT NOT NULL,
                pair TEXT,
                side TEXT,
                status TEXT,
                volume TEXT,
                filled TEXT,
                last_checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, order_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        ''')

        conn.execute('''
            CREATE TABLE IF NOT EXISTS automation_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                rule_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                trigger_event TEXT,
                action_executed TEXT,
                action_result TEXT,
                status TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (rule_id) REFERENCES automation_rules(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        ''')

        conn.execute('CREATE INDEX IF NOT EXISTS idx_username ON users(username)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_user_active ON automation_rules(user_id, is_active)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_user_log ON automation_log(user_id, created_at)')

        # Migration: add use_filled_amount column if it doesn't exist
        try:
            conn.execute('ALTER TABLE automation_rules ADD COLUMN use_filled_amount BOOLEAN DEFAULT 0')
        except Exception:
            pass  # Column already exists

        # Migration: add balance_threshold columns
        for migration in [
            'ALTER TABLE automation_rules ADD COLUMN trigger_asset TEXT',
            'ALTER TABLE automation_rules ADD COLUMN trigger_threshold TEXT',
            'ALTER TABLE automation_rules ADD COLUMN last_executed_at DATETIME NULL',
            'ALTER TABLE automation_rules ADD COLUMN cooldown_minutes INTEGER DEFAULT 1440',
        ]:
            try:
                conn.execute(migration)
            except Exception:
                pass  # Column already exists

        # Migration: add API key validation columns
        for migration in [
            'ALTER TABLE users ADD COLUMN keys_validated BOOLEAN DEFAULT 0',
            'ALTER TABLE users ADD COLUMN keys_last_validated DATETIME NULL',
        ]:
            try:
                conn.execute(migration)
            except Exception:
                pass  # Column already exists
        
        conn.commit()
        print("[DATABASE] Tables created/verified successfully")
        
    except Exception as e:
        print(f"[DATABASE ERROR] {e}")
        conn.rollback()
    finally:
        conn.close()
