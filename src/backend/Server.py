import os
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

if __name__ == '__main__':
    app = create_app()
    port = int(os.getenv('API_PORT', 5000))
    start_worker(app)
    app.run(host='127.0.0.1', port=port, debug=True, use_reloader=False)
