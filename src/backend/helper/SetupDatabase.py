from helper.InitiateConnection import get_db_connection


def setup_database():
    conn = get_db_connection()
    try:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_login DATETIME NULL,
                notifications_enabled INTEGER NOT NULL DEFAULT 1,
                donation_modal_enabled INTEGER NOT NULL DEFAULT 1
            )
        ''')

        conn.execute('''
            CREATE TABLE IF NOT EXISTS exchange_connections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                exchange_name TEXT NOT NULL,
                label TEXT NOT NULL,
                api_key_encrypted TEXT,
                private_key_encrypted TEXT,
                passphrase_encrypted TEXT,
                is_validated BOOLEAN DEFAULT 0,
                keys_last_validated DATETIME NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, exchange_name, label),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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
                trigger_exchange_id INTEGER,
                action_exchange_id INTEGER,
                convert_to_asset TEXT,
                trigger_price_quote_asset TEXT,
                action_amount_mode TEXT,
                max_executions INTEGER,
                execution_count INTEGER DEFAULT 0,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (trigger_exchange_id) REFERENCES exchange_connections(id) ON DELETE SET NULL,
                FOREIGN KEY (action_exchange_id) REFERENCES exchange_connections(id) ON DELETE SET NULL
            )
        ''')

        conn.execute('''
            CREATE TABLE IF NOT EXISTS order_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                order_id TEXT NOT NULL,
                exchange_connection_id INTEGER,
                pair TEXT,
                side TEXT,
                status TEXT,
                volume TEXT,
                filled TEXT,
                last_checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, order_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (exchange_connection_id) REFERENCES exchange_connections(id) ON DELETE SET NULL
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

        conn.execute('''
            CREATE TABLE IF NOT EXISTS watched_cryptos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                symbol TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, symbol),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        ''')

        # Portfolio value history — one header row per snapshot (per connection,
        # 30-min aligned), with a detail row per held asset. captured_at is a
        # UNIX epoch second so the frontend chart can consume it directly.
        conn.execute('''
            CREATE TABLE IF NOT EXISTS portfolio_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                exchange_connection_id INTEGER,
                captured_at INTEGER NOT NULL,
                total_usd REAL NOT NULL,
                is_estimated INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, exchange_connection_id, captured_at),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (exchange_connection_id) REFERENCES exchange_connections(id) ON DELETE CASCADE
            )
        ''')

        conn.execute('''
            CREATE TABLE IF NOT EXISTS portfolio_snapshot_assets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                snapshot_id INTEGER NOT NULL,
                asset TEXT NOT NULL,
                amount REAL NOT NULL,
                usd_value REAL NOT NULL,
                FOREIGN KEY (snapshot_id) REFERENCES portfolio_snapshots(id) ON DELETE CASCADE
            )
        ''')

        # Tracks which monthly report periods have already been emailed, so the
        # end-of-month report is sent at most once per user per month.
        conn.execute('''
            CREATE TABLE IF NOT EXISTS report_sends (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                period TEXT NOT NULL,
                sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, period),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        ''')

        conn.execute('CREATE INDEX IF NOT EXISTS idx_username ON users(username)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_user_active ON automation_rules(user_id, is_active)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_user_log ON automation_log(user_id, created_at)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_exchange_conn_user ON exchange_connections(user_id)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_watched_cryptos_user ON watched_cryptos(user_id)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_pf_snap_user_time ON portfolio_snapshots(user_id, captured_at)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_pf_snap_assets_snap ON portfolio_snapshot_assets(snapshot_id)')

        for migration in [
            'ALTER TABLE automation_rules ADD COLUMN trigger_exchange_id INTEGER REFERENCES exchange_connections(id) ON DELETE SET NULL',
            'ALTER TABLE automation_rules ADD COLUMN action_exchange_id INTEGER REFERENCES exchange_connections(id) ON DELETE SET NULL',
        ]:
            try:
                conn.execute(migration)
            except Exception:
                pass

        try:
            conn.execute('ALTER TABLE order_snapshots ADD COLUMN exchange_connection_id INTEGER REFERENCES exchange_connections(id) ON DELETE SET NULL')
        except Exception:
            pass  

        try:
            conn.execute('ALTER TABLE exchange_connections ADD COLUMN is_sandbox INTEGER NOT NULL DEFAULT 0')
        except Exception:
            pass  

        for migration in [
            'ALTER TABLE automation_rules ADD COLUMN use_filled_amount BOOLEAN DEFAULT 0',
            'ALTER TABLE automation_rules ADD COLUMN trigger_asset TEXT',
            'ALTER TABLE automation_rules ADD COLUMN trigger_threshold TEXT',
            'ALTER TABLE automation_rules ADD COLUMN last_executed_at DATETIME NULL',
            'ALTER TABLE automation_rules ADD COLUMN cooldown_minutes INTEGER DEFAULT 1440',
            'ALTER TABLE automation_rules ADD COLUMN trigger_price_quote_asset TEXT',
            'ALTER TABLE automation_rules ADD COLUMN action_amount_mode TEXT',
            'ALTER TABLE automation_rules ADD COLUMN max_executions INTEGER',
            'ALTER TABLE automation_rules ADD COLUMN execution_count INTEGER DEFAULT 0',
        ]:
            try:
                conn.execute(migration)
            except Exception:
                pass  

        try:
            conn.execute('ALTER TABLE users ADD COLUMN notifications_enabled INTEGER NOT NULL DEFAULT 1')
        except Exception:
            pass  

        try:
            conn.execute('ALTER TABLE users ADD COLUMN donation_modal_enabled INTEGER NOT NULL DEFAULT 1')
        except Exception:
            pass  

        try:
            conn.execute('ALTER TABLE watched_cryptos ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0')
        except Exception:
            pass

        conn.commit()
        print("[DATABASE] Tables created/verified successfully")
        
    except Exception as e:
        print(f"[DATABASE ERROR] {e}")
        conn.rollback()
    finally:
        conn.close()
