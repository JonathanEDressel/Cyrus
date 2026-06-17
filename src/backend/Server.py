import os
import socket
from flask import Flask
from dotenv import load_dotenv
from Extensions import cors
from Routes import register_routes
from helper.SetupDatabase import setup_database
from helper.MigrateDatabase import run_migrations, run_column_migrations
from automation.worker import start_worker

load_dotenv()

def create_app():
    app = Flask(__name__)
    
    app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'change-this-to-a-random-secret-key')
    app.config['DATABASE_PATH'] = os.getenv('DATABASE_PATH', os.path.join(os.path.dirname(__file__), 'kraking.db'))
    
    cors.init_app(app, resources={r"/api/*": {"origins": "*"}})
    
    with app.app_context():
        setup_database()
        run_migrations()
        run_column_migrations()
    
    register_routes(app)
    return app

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

    app = create_app()
    start_worker(app)

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
    server.serve_forever()
