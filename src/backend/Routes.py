from controllers.AuthController import auth_bp
from controllers.UserController import user_bp
from controllers.ExchangeConnectionController import exchange_bp
from controllers.ExchangeController import exchange_data_bp
from controllers.AutomationController import automation_bp
from controllers.WatchlistController import watchlist_bp
from controllers.MarketDataController import market_data_bp
from controllers.ReportController import report_bp


def register_routes(app):
    app.register_blueprint(auth_bp, url_prefix='/api/auth')
    app.register_blueprint(user_bp, url_prefix='/api/user')
    app.register_blueprint(exchange_bp, url_prefix='/api/exchanges')
    app.register_blueprint(exchange_data_bp, url_prefix='/api/exchange')
    app.register_blueprint(automation_bp, url_prefix='/api/automation')
    app.register_blueprint(watchlist_bp, url_prefix='/api/watchlist')
    app.register_blueprint(market_data_bp, url_prefix='/api/market')
    app.register_blueprint(report_bp, url_prefix='/api/report')
