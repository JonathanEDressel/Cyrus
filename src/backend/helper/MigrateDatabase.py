from flask import current_app

from helper import DbCrypto


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
    conn = DbCrypto.connect(db_path, current_app.config['SECRET_KEY'], check_same_thread=False)
    conn.row_factory = DbCrypto.Row
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
        # Keep notifications_enabled / donation_modal_enabled on the rebuilt
        # table — setup_database() adds them before this migration runs, and
        # run_column_migrations() never re-adds them, so omitting them here would
        # silently drop the columns (and break every notifications/donation-modal
        # write) after a legacy upgrade.
        conn.execute('''
            CREATE TABLE IF NOT EXISTS users_new (
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
            INSERT OR IGNORE INTO users_new
                (id, username, password_hash, created_at, last_login,
                 notifications_enabled, donation_modal_enabled)
            SELECT id, username, password_hash, created_at, last_login,
                   notifications_enabled, donation_modal_enabled FROM users
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
    conn = DbCrypto.connect(db_path, current_app.config['SECRET_KEY'], check_same_thread=False)
    conn.row_factory = DbCrypto.Row
    try:
        if not _has_column(conn, 'automation_rules', 'convert_to_asset'):
            conn.execute('ALTER TABLE automation_rules ADD COLUMN convert_to_asset TEXT')
            conn.commit()
            print("[MIGRATION] Added convert_to_asset column to automation_rules")

        if not _has_column(conn, 'users', 'is_active'):
            conn.execute('ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1')
            conn.commit()
            print("[MIGRATION] Added is_active column to users")

        if not _has_column(conn, 'users', 'theme'):
            conn.execute("ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'dark'")
            conn.commit()
            print("[MIGRATION] Added theme column to users")

        if not _has_column(conn, 'automation_rules', 'trigger_price_quote_asset'):
            conn.execute('ALTER TABLE automation_rules ADD COLUMN trigger_price_quote_asset TEXT')
            conn.commit()
            print("[MIGRATION] Added trigger_price_quote_asset column to automation_rules")

        if not _has_column(conn, 'automation_rules', 'action_amount_mode'):
            conn.execute('ALTER TABLE automation_rules ADD COLUMN action_amount_mode TEXT')
            conn.commit()
            print("[MIGRATION] Added action_amount_mode column to automation_rules")

        if not _has_column(conn, 'automation_rules', 'max_executions'):
            conn.execute('ALTER TABLE automation_rules ADD COLUMN max_executions INTEGER')
            conn.commit()
            print("[MIGRATION] Added max_executions column to automation_rules")

        if not _has_column(conn, 'automation_rules', 'execution_count'):
            conn.execute('ALTER TABLE automation_rules ADD COLUMN execution_count INTEGER DEFAULT 0')
            conn.commit()
            print("[MIGRATION] Added execution_count column to automation_rules")

        # Email notifications (per-user SMTP). The app password is stored
        # encrypted (Fernet) in smtp_password_encrypted — never in plaintext.
        if not _has_column(conn, 'users', 'email_notifications_enabled'):
            conn.execute('ALTER TABLE users ADD COLUMN email_notifications_enabled INTEGER NOT NULL DEFAULT 0')
            conn.commit()
            print("[MIGRATION] Added email_notifications_enabled column to users")

        if not _has_column(conn, 'users', 'notify_email'):
            conn.execute('ALTER TABLE users ADD COLUMN notify_email TEXT')
            conn.commit()
            print("[MIGRATION] Added notify_email column to users")

        if not _has_column(conn, 'users', 'smtp_password_encrypted'):
            conn.execute('ALTER TABLE users ADD COLUMN smtp_password_encrypted TEXT')
            conn.commit()
            print("[MIGRATION] Added smtp_password_encrypted column to users")

        if not _has_column(conn, 'users', 'smtp_host'):
            conn.execute('ALTER TABLE users ADD COLUMN smtp_host TEXT')
            conn.commit()
            print("[MIGRATION] Added smtp_host column to users")

        if not _has_column(conn, 'users', 'smtp_port'):
            conn.execute('ALTER TABLE users ADD COLUMN smtp_port INTEGER')
            conn.commit()
            print("[MIGRATION] Added smtp_port column to users")

        # Anthropic API key for the portfolio assistant. Stored encrypted
        # (Fernet) like the SMTP app password — never in plaintext, never
        # serialized back to the client.
        if not _has_column(conn, 'users', 'anthropic_key_encrypted'):
            conn.execute('ALTER TABLE users ADD COLUMN anthropic_key_encrypted TEXT')
            conn.commit()
            print("[MIGRATION] Added anthropic_key_encrypted column to users")

        # Alpaca market-data key (key id + secret) for the Charts page's Stocks
        # source. Both halves are Fernet-encrypted like the Anthropic key.
        for col in ('alpaca_key_id_encrypted', 'alpaca_secret_encrypted'):
            if not _has_column(conn, 'users', col):
                conn.execute(f'ALTER TABLE users ADD COLUMN {col} TEXT')
                conn.commit()
                print(f"[MIGRATION] Added {col} column to users")

        # The Overview page's customised layout (which widgets, their order and
        # size), as a JSON document. NULL means "use the default layout".
        if not _has_column(conn, 'users', 'dashboard_layout'):
            conn.execute('ALTER TABLE users ADD COLUMN dashboard_layout TEXT')
            conn.commit()
            print("[MIGRATION] Added dashboard_layout column to users")

        # Portfolio balancer (trigger_type = 'allocation_threshold'). The cap and
        # the rebalance-down-to target are stored as separate percentages: acting
        # exactly down to the cap would re-fire on the next tick, so a rule needs
        # both a ceiling and somewhere lower to land.
        # Fingerprint of each connection's API key, so the same credentials can't
        # be added twice now that one exchange may hold several connections.
        # Existing rows are backfilled by decrypting what's already stored.
        if not _has_column(conn, 'exchange_connections', 'api_key_fingerprint'):
            conn.execute('ALTER TABLE exchange_connections ADD COLUMN api_key_fingerprint TEXT')
            conn.commit()
            print("[MIGRATION] Added api_key_fingerprint column to exchange_connections")

            try:
                from helper.Security import decrypt_api_key, fingerprint_api_key
                rows = conn.execute(
                    'SELECT id, api_key_encrypted FROM exchange_connections '
                    'WHERE api_key_encrypted IS NOT NULL'
                ).fetchall()
                filled = 0
                for row in rows:
                    try:
                        plain = decrypt_api_key(row['api_key_encrypted'])
                    except Exception:
                        continue   # keys encrypted under a different SECRET_KEY
                    fp = fingerprint_api_key(plain)
                    if fp:
                        conn.execute(
                            'UPDATE exchange_connections SET api_key_fingerprint = ? WHERE id = ?',
                            (fp, row['id'])
                        )
                        filled += 1
                conn.commit()
                print(f"[MIGRATION] Fingerprinted {filled} existing exchange connection(s)")
            except Exception as e:
                # Non-fatal: without fingerprints the duplicate check simply
                # can't see pre-existing connections.
                print(f"[MIGRATION] Could not backfill key fingerprints: {e}")

        if not _has_column(conn, 'automation_rules', 'trigger_allocation_percent'):
            conn.execute('ALTER TABLE automation_rules ADD COLUMN trigger_allocation_percent TEXT')
            conn.commit()
            print("[MIGRATION] Added trigger_allocation_percent column to automation_rules")

        if not _has_column(conn, 'automation_rules', 'rebalance_target_percent'):
            conn.execute('ALTER TABLE automation_rules ADD COLUMN rebalance_target_percent TEXT')
            conn.commit()
            print("[MIGRATION] Added rebalance_target_percent column to automation_rules")

        if not _has_column(conn, 'automation_rules', 'min_trade_usd'):
            conn.execute('ALTER TABLE automation_rules ADD COLUMN min_trade_usd TEXT')
            conn.commit()
            print("[MIGRATION] Added min_trade_usd column to automation_rules")

        if not _has_column(conn, 'automation_rules', 'dry_run'):
            conn.execute('ALTER TABLE automation_rules ADD COLUMN dry_run INTEGER DEFAULT 0')
            conn.commit()
            print("[MIGRATION] Added dry_run column to automation_rules")

        # transfer_history shipped in v1.2.4 without the match columns, so
        # existing installs need them added rather than just declared in
        # SetupDatabase. Guarded on the table existing at all, because
        # run_column_migrations also runs on databases older than the feature.
        if _has_table(conn, 'user_wallets') and not _has_column(conn, 'user_wallets', 'tag'):
            conn.execute('ALTER TABLE user_wallets ADD COLUMN tag TEXT')
            conn.commit()
            print("[MIGRATION] Added tag column to user_wallets")

        if _has_table(conn, 'transfer_history'):
            for column, ddl in (
                ('match_confidence', 'REAL'),
                ('counterparty_wallet_id', 'INTEGER'),
                ('match_locked', 'INTEGER NOT NULL DEFAULT 0'),
            ):
                if not _has_column(conn, 'transfer_history', column):
                    conn.execute(
                        f'ALTER TABLE transfer_history ADD COLUMN {column} {ddl}')
                    conn.commit()
                    print(f"[MIGRATION] Added {column} column to transfer_history")
    except Exception as e:
        conn.rollback()
        print(f"[MIGRATION ERROR] Column migration failed: {e}")
    finally:
        conn.close()


def _has_column(conn, table: str, column: str) -> bool:
    """Check if a column exists on a table (SQLite PRAGMA)."""
    rows = conn.execute(f'PRAGMA table_info({table})').fetchall()
    return any(r['name'] == column for r in rows)


def _has_table(conn, table: str) -> bool:
    """Check if a table exists.

    Needed because ``run_column_migrations`` runs against databases created
    before a table existed, and ``PRAGMA table_info`` on a missing table returns
    an empty list rather than raising — which would read as "column absent" and
    send an ALTER at a table that isn't there.
    """
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return row is not None
