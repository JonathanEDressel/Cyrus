import sqlite3
from flask import current_app


def run_migrations():
    """Migrate existing DB from Kraken-only schema to multi-exchange schema.
    
    Detects the old layout (kraken_api_key_encrypted on users table) and:
      1. Creates exchange_connections table (if needed — SetupDatabase already does this).
      2. Copies each user's Kraken keys into exchange_connections.
      3. Back-fills trigger_exchange_id / action_exchange_id on automation_rules.
      4. Back-fills exchange_connection_id on order_snapshots.
      5. Drops the legacy key columns from the users table (SQLite = table rebuild).
    
    Safe to run repeatedly — every step is guarded.
    """
    db_path = current_app.config['DATABASE_PATH']
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = OFF')  # disable during migration
    conn.execute('PRAGMA journal_mode = WAL')

    try:
        if not _has_column(conn, 'users', 'kraken_api_key_encrypted'):
            print("[MIGRATION] No legacy columns detected — nothing to migrate.")
            return

        print("[MIGRATION] Legacy Kraken key columns detected — starting migration …")

        # 1. Ensure exchange_connections exists (SetupDatabase should handle this, but be safe)
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

        # 2. Migrate Kraken keys → exchange_connections
        users = conn.execute(
            'SELECT id, kraken_api_key_encrypted, kraken_private_key_encrypted, '
            'keys_validated, keys_last_validated FROM users'
        ).fetchall()

        for u in users:
            if u['kraken_api_key_encrypted'] or u['kraken_private_key_encrypted']:
                # Only insert if not already migrated
                exists = conn.execute(
                    "SELECT 1 FROM exchange_connections WHERE user_id = ? AND exchange_name = 'kraken' AND label = 'Kraken'",
                    (u['id'],)
                ).fetchone()
                if not exists:
                    conn.execute(
                        '''INSERT INTO exchange_connections
                           (user_id, exchange_name, label, api_key_encrypted, private_key_encrypted, is_validated, keys_last_validated)
                           VALUES (?, 'kraken', 'Kraken', ?, ?, ?, ?)''',
                        (u['id'], u['kraken_api_key_encrypted'], u['kraken_private_key_encrypted'],
                         u['keys_validated'] or 0, u['keys_last_validated'])
                    )

        print("[MIGRATION] Migrated user Kraken keys → exchange_connections")

        # 3. Back-fill automation_rules with exchange connection ids
        if _has_column(conn, 'automation_rules', 'trigger_exchange_id'):
            conn.execute('''
                UPDATE automation_rules
                SET trigger_exchange_id = (
                    SELECT ec.id FROM exchange_connections ec
                    WHERE ec.user_id = automation_rules.user_id
                      AND ec.exchange_name = 'kraken'
                    LIMIT 1
                )
                WHERE trigger_exchange_id IS NULL
            ''')
            conn.execute('''
                UPDATE automation_rules
                SET action_exchange_id = (
                    SELECT ec.id FROM exchange_connections ec
                    WHERE ec.user_id = automation_rules.user_id
                      AND ec.exchange_name = 'kraken'
                    LIMIT 1
                )
                WHERE action_exchange_id IS NULL
            ''')
            print("[MIGRATION] Back-filled automation_rules exchange IDs")

        # 4. Back-fill order_snapshots
        if _has_column(conn, 'order_snapshots', 'exchange_connection_id'):
            conn.execute('''
                UPDATE order_snapshots
                SET exchange_connection_id = (
                    SELECT ec.id FROM exchange_connections ec
                    WHERE ec.user_id = order_snapshots.user_id
                      AND ec.exchange_name = 'kraken'
                    LIMIT 1
                )
                WHERE exchange_connection_id IS NULL
            ''')
            print("[MIGRATION] Back-filled order_snapshots exchange IDs")

        # 5. Rebuild users table without legacy columns
        conn.execute('''
            CREATE TABLE IF NOT EXISTS users_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_login DATETIME NULL
            )
        ''')
        conn.execute('''
            INSERT OR IGNORE INTO users_new (id, username, password_hash, created_at, last_login)
            SELECT id, username, password_hash, created_at, last_login FROM users
        ''')
        conn.execute('DROP TABLE users')
        conn.execute('ALTER TABLE users_new RENAME TO users')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_username ON users(username)')
        print("[MIGRATION] Rebuilt users table (removed legacy key columns)")

        conn.commit()
        print("[MIGRATION] Migration completed successfully")

    except Exception as e:
        conn.rollback()
        print(f"[MIGRATION ERROR] {e}")
        raise
    finally:
        conn.execute('PRAGMA foreign_keys = ON')
        conn.close()


def run_column_migrations():
    """Add new columns to existing tables if they don't exist yet.

    Safe to run repeatedly — every step is guarded by _has_column().
    """
    from flask import current_app
    db_path = current_app.config['DATABASE_PATH']
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        if not _has_column(conn, 'automation_rules', 'convert_to_asset'):
            conn.execute('ALTER TABLE automation_rules ADD COLUMN convert_to_asset TEXT')
            conn.commit()
            print("[MIGRATION] Added convert_to_asset column to automation_rules")

        if not _has_column(conn, 'users', 'is_active'):
            conn.execute('ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1')
            conn.commit()
            print("[MIGRATION] Added is_active column to users")
    except Exception as e:
        conn.rollback()
        print(f"[MIGRATION ERROR] Column migration failed: {e}")
    finally:
        conn.close()


def _has_column(conn, table: str, column: str) -> bool:
    """Check if a column exists on a table (SQLite PRAGMA)."""
    rows = conn.execute(f'PRAGMA table_info({table})').fetchall()
    return any(r['name'] == column for r in rows)
