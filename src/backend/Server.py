import os
from flask import Flask
from dotenv import load_dotenv
from Extensions import cors
from Routes import register_routes
from helper.SetupDatabase import setup_database

# Load environment variables
load_dotenv()

def create_app():
    app = Flask(__name__)
    
    # Configuration from environment
    app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'change-this-to-a-random-secret-key')
    app.config['MYSQL_HOST'] = os.getenv('MYSQL_HOST', 'localhost')
    app.config['MYSQL_PORT'] = int(os.getenv('MYSQL_PORT', 3306))
    app.config['MYSQL_USER'] = os.getenv('MYSQL_USER', 'root')
    app.config['MYSQL_PASSWORD'] = os.getenv('MYSQL_PASSWORD', '')
    app.config['MYSQL_DATABASE'] = os.getenv('MYSQL_DATABASE', 'kraking_db')
    
    # Initialize extensions
    cors.init_app(app, resources={r"/api/*": {"origins": "*"}})
    
    # Setup database (within app context)
    with app.app_context():
        setup_database()
    
    # Register routes
    register_routes(app)
    
    return app

if __name__ == '__main__':
    app = create_app()
    port = int(os.getenv('API_PORT', 5000))
    app.run(host='127.0.0.1', port=port, debug=True)
