from controllers.AuthController import auth_bp
from controllers.UserController import user_bp
from controllers.ExchangeConnectionController import exchange_bp
from controllers.ExchangeController import exchange_data_bp
from controllers.AutomationController import automation_bp
from controllers.WatchlistController import watchlist_bp
from controllers.MarketDataController import market_data_bp
from controllers.ReportController import report_bp


def register_health_route(app):
    """Unauthenticated liveness probe for the Electron tray.

    The tray has to show automation status while the window (and therefore any
    logged-in session) is closed, so this can't require a token. The server
    binds to 127.0.0.1 only and this returns nothing user-specific — no
    balances, no rules, and deliberately no ``last_error``, which can quote
    exchange responses.
    """
    from flask import jsonify

    @app.route('/api/health', methods=['GET'])
    def health():
        from automation.worker import get_worker_status
        s = get_worker_status()
        return jsonify({
            'ok': True,
            'worker': {
                'state': s['state'],
                'running': s['running'],
                'healthy': s['healthy'],
                'poll_interval': s['poll_interval'],
                'age_seconds': s['age_seconds'],
                'cycle_count': s['cycle_count'],
            },
        })


def register_routes(app):
    register_health_route(app)
    app.register_blueprint(auth_bp, url_prefix='/api/auth')
    app.register_blueprint(user_bp, url_prefix='/api/user')
    app.register_blueprint(exchange_bp, url_prefix='/api/exchanges')
    app.register_blueprint(exchange_data_bp, url_prefix='/api/exchange')
    app.register_blueprint(automation_bp, url_prefix='/api/automation')
    app.register_blueprint(watchlist_bp, url_prefix='/api/watchlist')
    app.register_blueprint(market_data_bp, url_prefix='/api/market')
    app.register_blueprint(report_bp, url_prefix='/api/report')
