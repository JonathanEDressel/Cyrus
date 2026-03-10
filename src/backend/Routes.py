from controllers.AuthController import auth_bp
from controllers.UserController import user_bp
from controllers.KrakenController import kraken_bp
from controllers.AutomationController import automation_bp


def register_routes(app):
    app.register_blueprint(auth_bp, url_prefix='/api/auth')
    app.register_blueprint(user_bp, url_prefix='/api/user')
    app.register_blueprint(kraken_bp, url_prefix='/api/kraken')
    app.register_blueprint(automation_bp, url_prefix='/api/automation')
