"""US stock data for the Charts page, from Alpaca Market Data.

Each user brings their own (free) Alpaca key, entered on Profile → Exchanges
and stored Fernet-encrypted on their `users` row. ``AlpacaMarket`` mimics the
handful of ccxt calls the chart code makes (``timeframes``, ``load_markets`` /
``markets``, ``fetch_ohlcv``, ``fetch_ticker``) and raises ccxt's own error
types, so ``helper/PublicMarket.get_public`` can hand it out like any other
chart source.

Data comes from the free IEX feed: prices are real time, but volume counts
only trades on IEX.
"""

import threading
import time
from datetime import datetime, timezone
from urllib.parse import quote

import ccxt
import requests

DATA_URL = 'https://data.alpaca.markets'
LIVE_TRADING_URL = 'https://api.alpaca.markets'
PAPER_TRADING_URL = 'https://paper-api.alpaca.markets'
FEED = 'iex'

REQUEST_TIMEOUT = 15
# The free plan allows 200 requests a minute; stay well under it.
MIN_REQUEST_INTERVAL = 0.35
MARKETS_TTL = 3600
# Listed venues; anything else (OTC) is left out of the symbol list.
LISTED_EXCHANGES = {'NYSE', 'NASDAQ', 'ARCA', 'NYSEARCA', 'AMEX', 'BATS'}
# Earliest date asked for; Alpaca's history starts in 2016.
EARLIEST_MS = int(datetime(2015, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)

KEY_MISSING_MESSAGE = "Add your Alpaca key on the Profile page (Exchanges tab) to chart stocks."
KEY_REJECTED_MESSAGE = "Alpaca rejected your key. Re-enter it on the Profile page (Exchanges tab)."


class StockKeyError(ValueError):
    """The user has no usable Alpaca key. A ValueError, so routes answer 400."""

    def __init__(self, message: str = KEY_MISSING_MESSAGE):
        super().__init__(message)


def get_alpaca_keys(user_id: int | None) -> tuple[str, str] | None:
    """The user's decrypted (key_id, secret), or None when none is usable."""
    if user_id is None:
        return None
    from controllers.UserDbContext import UserDbContext
    from helper.Security import decrypt_api_key

    user = UserDbContext.get_user_by_id(user_id)
    if not user or not user.alpaca_key_id_encrypted or not user.alpaca_secret_encrypted:
        return None
    try:
        key_id = decrypt_api_key(user.alpaca_key_id_encrypted)
        secret = decrypt_api_key(user.alpaca_secret_encrypted)
    except Exception:
        # Encrypted under a different SECRET_KEY: the fix is to re-enter it.
        return None
    if not key_id or not secret:
        return None
    return key_id, secret


def _iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _parse_ms(ts: str) -> int:
    # Alpaca sends RFC 3339, e.g. 2024-05-01T13:30:00Z (sometimes with nanoseconds).
    ts = ts.replace('Z', '+00:00')
    if '.' in ts:
        head, rest = ts.split('.', 1)
        frac, _, tz = rest.partition('+')
        ts = f"{head}.{frac[:6]}+{tz}" if tz else f"{head}.{frac[:6]}"
    return int(datetime.fromisoformat(ts).timestamp() * 1000)


class AlpacaMarket:
    """A ccxt-shaped, read-only client for Alpaca's stock data."""

    id = 'alpaca'
    TIMEFRAMES = {
        '1m': '1Min', '5m': '5Min', '15m': '15Min', '30m': '30Min',
        '1h': '1Hour', '4h': '4Hour', '1d': '1Day', '1w': '1Week',
    }
    TIMEFRAME_SECONDS = {
        '1m': 60, '5m': 300, '15m': 900, '30m': 1_800,
        '1h': 3_600, '4h': 14_400, '1d': 86_400, '1w': 604_800,
    }
    timeframes = TIMEFRAMES

    def __init__(self, key_id: str, secret: str):
        self._headers = {
            'APCA-API-KEY-ID': key_id,
            'APCA-API-SECRET-KEY': secret,
            'Accept': 'application/json',
        }
        # Paper keys start "PK"; live keys "AK". Either works for market data,
        # but the asset list lives on the matching trading host.
        self._trading_url = PAPER_TRADING_URL if key_id.upper().startswith('PK') else LIVE_TRADING_URL
        self._session = requests.Session()
        self._lock = threading.Lock()
        self._last_request = 0.0
        self._markets: dict[str, dict] = {}
        self._markets_at = 0.0

    # ------------------------------------------------------------------
    # HTTP
    # ------------------------------------------------------------------

    def _get(self, url: str, params: dict | None = None):
        with self._lock:
            wait = self._last_request + MIN_REQUEST_INTERVAL - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._last_request = time.monotonic()
        try:
            resp = self._session.get(url, params=params, headers=self._headers, timeout=REQUEST_TIMEOUT)
        except requests.RequestException as e:
            raise ccxt.NetworkError(f"Couldn't reach Alpaca: {e}") from e

        if resp.status_code < 300:
            return resp.json()
        try:
            detail = (resp.json() or {}).get('message') or resp.text
        except ValueError:
            detail = resp.text
        detail = (detail or '').strip()[:200]
        if resp.status_code in (401, 403):
            raise StockKeyError(KEY_REJECTED_MESSAGE if resp.status_code == 401 or not detail
                                else f"Alpaca: {detail}")
        if resp.status_code == 429:
            raise ccxt.RateLimitExceeded("Alpaca rate limit reached; try again in a minute.")
        if resp.status_code in (400, 404, 422):
            raise ccxt.BadSymbol(f"Alpaca: {detail or 'unknown symbol'}")
        raise ccxt.ExchangeNotAvailable(f"Alpaca error {resp.status_code}: {detail}")

    # ------------------------------------------------------------------
    # Markets
    # ------------------------------------------------------------------

    def _fetch_assets(self) -> list:
        try:
            return self._get(f"{self._trading_url}/v2/assets",
                             {'status': 'active', 'asset_class': 'us_equity'})
        except StockKeyError:
            # The key may belong to the other environment; try it once and
            # remember the one that answers.
            other = LIVE_TRADING_URL if self._trading_url == PAPER_TRADING_URL else PAPER_TRADING_URL
            data = self._get(f"{other}/v2/assets", {'status': 'active', 'asset_class': 'us_equity'})
            self._trading_url = other
            return data

    def load_markets(self, reload: bool = False) -> dict:
        if self._markets and not reload and time.time() - self._markets_at < MARKETS_TTL:
            return self._markets
        markets = {}
        for a in self._fetch_assets() or []:
            sym = a.get('symbol')
            if not sym or not a.get('tradable') or a.get('exchange') not in LISTED_EXCHANGES:
                continue
            markets[sym] = {
                'id': sym, 'symbol': sym, 'base': sym, 'quote': 'USD',
                'name': (a.get('name') or '').strip(),
                'spot': True, 'active': True, 'type': 'stock',
            }
        self._markets = markets
        self._markets_at = time.time()
        return markets

    @property
    def markets(self) -> dict:
        return self._markets

    # ------------------------------------------------------------------
    # Data
    # ------------------------------------------------------------------

    def fetch_ohlcv(self, symbol: str, timeframe: str = '1h', since: int | None = None,
                    limit: int | None = None, params: dict | None = None) -> list[list]:
        """Bars as ccxt rows ``[ms, open, high, low, close, volume]``, oldest first.

        With ``since`` (ms): bars from then on. Without it: the latest ``limit``
        bars ending before ``params['until']`` (ms, default now). Paging by end
        time keeps pages full across overnight and weekend gaps.
        """
        if timeframe not in self.TIMEFRAMES:
            raise ValueError(f"Stocks have no {timeframe} candles")
        params = params or {}
        limit = max(1, min(int(limit or 1000), 10_000))
        query = {
            'timeframe': self.TIMEFRAMES[timeframe],
            'feed': FEED,
            'adjustment': 'split',
            'limit': limit,
        }
        if since is not None:
            query.update(start=_iso(since), sort='asc')
            if params.get('until'):
                query['end'] = _iso(params['until'])
        else:
            end_ms = int(params.get('until') or time.time() * 1000)
            # Alpaca's start defaults to the beginning of today, so give it a
            # window wide enough to hold `limit` bars of trading time: markets
            # are open roughly a quarter of the week, so 7x is ample.
            span_ms = limit * self.TIMEFRAME_SECONDS[timeframe] * 1000 * 7
            start_ms = max(EARLIEST_MS, end_ms - span_ms)
            # Alpaca's `end` is inclusive; step back so `until` itself is excluded.
            query.update(start=_iso(start_ms), end=_iso(end_ms - 1000), sort='desc')

        rows: list[list] = []
        url = f"{DATA_URL}/v2/stocks/{quote(symbol, safe='')}/bars"
        while True:
            data = self._get(url, query) or {}
            for b in data.get('bars') or []:
                rows.append([_parse_ms(b['t']), b.get('o'), b.get('h'), b.get('l'), b.get('c'), b.get('v') or 0])
            token = data.get('next_page_token')
            if not token or len(rows) >= limit:
                break
            query['page_token'] = token
            query['limit'] = limit - len(rows)
        rows.sort(key=lambda r: r[0])
        return rows[-limit:] if since is None else rows[:limit]

    def fetch_ticker(self, symbol: str) -> dict:
        snap = self._get(f"{DATA_URL}/v2/stocks/{quote(symbol, safe='')}/snapshot", {'feed': FEED}) or {}
        trade = snap.get('latestTrade') or {}
        day = snap.get('dailyBar') or {}
        prev = snap.get('prevDailyBar') or {}
        last = trade.get('p') or (snap.get('minuteBar') or {}).get('c') or day.get('c')
        prev_close = prev.get('c')
        change = (last - prev_close) if last is not None and prev_close else None
        return {
            'symbol': symbol,
            'last': last,
            'high': day.get('h'),
            'low': day.get('l'),
            'open': day.get('o'),
            'close': last,
            'previousClose': prev_close,
            'change': change,
            'percentage': (change / prev_close * 100) if change is not None else None,
            'baseVolume': day.get('v'),
            'info': snap,
        }


def verify_keys(key_id: str, secret: str) -> None:
    """Check a key pair before storing it. Raises ValueError with a usable message."""
    client = AlpacaMarket(key_id, secret)
    try:
        client.fetch_ticker('SPY')
        client.load_markets()
    except StockKeyError:
        raise ValueError("Alpaca didn't accept that key ID and secret. Check both and try again.")
    except ccxt.BaseError as e:
        raise ValueError(f"Couldn't verify the key with Alpaca: {e}")
