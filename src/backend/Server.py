import os
import socket
import sys

# A frozen (PyInstaller) Python on macOS has no CA store of its own, so any
# stdlib ssl default context (urllib, e.g. the CoinGecko price lookups) would
# fail certificate checks. Point it at certifi's bundle before anything opens
# a connection. Windows reads the system store and needs nothing.
if getattr(sys, 'frozen', False) and sys.platform == 'darwin':
    try:
        import certifi
        os.environ.setdefault('SSL_CERT_FILE', certifi.where())
    except Exception:
        pass

from flask import Flask
from dotenv import load_dotenv
from Extensions import cors
from Routes import register_routes
from helper.SetupDatabase import setup_database
from helper.MigrateDatabase import run_migrations, run_column_migrations
from helper import DbCrypto, SecretRekey
from automation.worker import start_worker

load_dotenv()

def create_app():
    app = Flask(__name__)
    
    app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'change-this-to-a-random-secret-key')
    app.config['DATABASE_PATH'] = os.getenv('DATABASE_PATH', os.path.join(os.path.dirname(__file__), 'kraking.db'))
    
    cors.init_app(app, resources={r"/api/*": {"origins": "*"}})
    
    # Encrypt an older install's plain database before anything opens it.
    # Raises DbCrypto.DatabaseLockedError if the file has a different key.
    outcome = DbCrypto.ensure_encrypted(app.config['DATABASE_PATH'], app.config['SECRET_KEY'])
    if outcome == 'converted':
        print('[DATABASE] Encrypted the existing database (SQLCipher).')
    elif outcome == 'disabled':
        print('[DATABASE] Encryption is off (CYRUS_DB_ENCRYPTION=off, development only).')

    with app.app_context():
        setup_database()
        run_migrations()
        run_column_migrations()
        _rekey_stored_secrets(app)
    
    register_routes(app)
    return app

def _rekey_stored_secrets(app) -> None:
    """Move stored exchange keys etc. from an old SECRET_KEY to this one."""
    legacy = SecretRekey.legacy_secrets_from_env(app.config['SECRET_KEY'])
    if not legacy:
        return
    from helper.InitiateConnection import get_db_connection
    conn = get_db_connection()
    try:
        stats = SecretRekey.rekey_secrets(conn, app.config['SECRET_KEY'], legacy)
        if stats['rekeyed'] or stats['unreadable']:
            print(f"[SECURITY] Re-encrypted {stats['rekeyed']} stored secret(s) with this "
                  f"install's key ({stats['unreadable']} unreadable).")
    finally:
        conn.close()


def _port_available(host: str, port: int) -> bool:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind((host, port))
        return True
    except OSError:
        return False
    finally:
        probe.close()


if __name__ == '__main__':
    from werkzeug.serving import make_server
    from helper.Logging import setup_logging, redirect_std_streams
    from helper.ProcessWatchdog import watch_parent_process

    log_path = setup_logging()
    watch_parent_process()

    try:
        app = create_app()
    except DbCrypto.DatabaseLockedError as e:
        # The Electron main process looks for this marker and offers the user
        # a way out instead of a backend that silently never starts.
        print(f'CYRUS_DB_LOCKED {e}', flush=True)
        sys.exit(3)

    requested_port = int(os.getenv('API_PORT', 5000))
    # werkzeug's make_server calls sys.exit(1) (not a catchable OSError) when a
    # bind fails, so check availability up front. If the requested port is taken
    # (e.g. 5000 is in use), pass 0 and let the OS assign a free port.
    port = requested_port if _port_available('127.0.0.1', requested_port) else 0
    server = make_server('127.0.0.1', port, app, threaded=True)

    actual_port = server.server_port
    # The Electron main process parses this line from stdout to learn which
    # port to point the frontend at. Keep the format stable.
    print(f'CYRUS_PORT={actual_port}', flush=True)

    # Handshake done — get off the inherited stdout pipe before anything else
    # writes to it. Electron stops draining that pipe when it exits, and a full
    # pipe makes the next print() block forever, which is what silently froze
    # the automation worker. No-op when running from a terminal in dev.
    redirect_std_streams()
    print(f'[SERVER] Listening on 127.0.0.1:{actual_port} — logging to {log_path}')

    # Started after the redirect so the worker never touches the pipe at all.
    start_worker(app)
    server.serve_forever()
