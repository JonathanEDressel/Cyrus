# Robinhood Integration Plan

Implement Robinhood as a direct API integration (no CCXT) behind your existing exchange abstraction so all current routes stay unchanged, while enforcing exchange capabilities in backend validation so unsupported commands are blocked consistently (same user-facing pattern as Coinbase/Binance).

---

## Phase 1 — Capability Contract

Define explicit capabilities in supported exchange metadata:

| Capability Flag | Kraken | Coinbase | Binance | Robinhood v1 |
|---|:---:|:---:|:---:|:---:|
| `supports_balance` | ✅ | ✅ | ✅ | ✅ |
| `supports_open_orders` | ✅ | ✅ | ✅ | ✅ |
| `supports_closed_orders` | ✅ | ✅ | ✅ | ✅ |
| `supports_market_price` | ✅ | ✅ | ✅ | ✅ |
| `supports_convert` | ✅ | ✅ | ✅ | ✅ |
| `supports_withdrawal_addresses` | ✅ | ❌ | ❌ | ❌ |
| `supports_withdraw` | ✅ | ❌ | ❌ | ❌ |

**Files touched:** [`src/backend/helper/ExchangeRegistry.py`](src/backend/helper/ExchangeRegistry.py)

---

## Phase 2 — Robinhood Backend Module

Create a dedicated Robinhood helper package at `src/backend/helper/robinhood/` with clear file separation:

```
src/backend/helper/robinhood/
├── __init__.py          # package exports
├── client.py            # Ed25519 auth/signing, shared HTTP transport, rate-limit/retry logic, pagination
├── accounts.py          # account info and balance endpoint wrappers
├── orders.py            # open orders, closed/filled orders, market order execution
├── market.py            # quote / ticker / trading-pair discovery
├── adapter.py           # app-facing exchange adapter (same interface the worker/controllers already call)
└── errors.py            # Robinhood error translation to user-safe messages
```

### Auth & Signing (`client.py`)

Robinhood uses **Ed25519 key-pair signing**, not a simple API key/secret. Every authenticated request requires three headers:

| Header | Value |
|---|---|
| `x-api-key` | Your API key (format: `rh-api-<uuid>`) |
| `x-timestamp` | Unix timestamp (seconds). **Valid for 30 seconds only — requests must be sent immediately after signing.** |
| `x-signature` | Base64-encoded Ed25519 signature of `"{api_key}{timestamp}{path}{method}{body}"` |

The private key is a **base64-encoded Ed25519 seed** (generated via `pynacl`). The signing logic in `client.py`:

```python
import nacl.signing, base64, time

private_key = nacl.signing.SigningKey(base64.b64decode(base64_private_key))

def sign(api_key, path, method, body=""):
    timestamp = str(int(time.time()))
    message = f"{api_key}{timestamp}{path}{method}{body}"
    signed = private_key.sign(message.encode("utf-8"))
    return {
        "x-api-key": api_key,
        "x-timestamp": timestamp,
        "x-signature": base64.b64encode(signed.signature).decode("utf-8"),
    }
```

> **Credential storage**: The existing `exchange_connections` table stores `api_key_encrypted` and `private_key_encrypted`. For Robinhood, `api_key_encrypted` holds the API key and `private_key_encrypted` holds the base64-encoded Ed25519 private key seed. No passphrase field is needed (`passphrase_encrypted` is left null).

**New dependency** — add to `src/backend/requirements.txt`:
```
pynacl
```

### Rate Limiting (`client.py`)

Robinhood enforces rate limits using a **token bucket** per user account:

| Limit | Value |
|---|---|
| Sustained (refill rate) | **100 requests / minute** |
| Burst capacity | **300 requests** |
| Response when exceeded | HTTP **`429 Too Many Requests`** |

The bucket starts full at 300 tokens, refills at ~1.67 tokens/second (100/min) up to the 300 cap. The actual refill interval may fluctuate based on Robinhood service load.

`client.py` must handle this with a **429-triggered exponential backoff** strategy:

```python
MAX_RETRIES = 4
BASE_BACKOFF = 1.0  # seconds

def request_with_retry(method, path, body=""):
    for attempt in range(MAX_RETRIES):
        response = make_request(method, path, body)
        if response.status_code == 429:
            wait = BASE_BACKOFF * (2 ** attempt)  # 1s, 2s, 4s, 8s
            time.sleep(wait)
            continue
        return response
    raise RateLimitError("Robinhood rate limit exceeded after retries")
```

Because the worker's poll cycle runs every 60 seconds and touches multiple exchanges, the 100 req/min budget is unlikely to be exhausted in normal operation. However, burst-heavy scenarios (many rules, many users) require the retry guard.

### Pagination (`client.py`)

All list endpoints (orders, holdings, trading pairs) return cursor-based paginated responses:

```json
{ "next": "<url>", "previous": "<url>", "results": [...] }
```

`client.py` provides a `get_all_pages(path)` helper that follows `next` until exhausted. Each page fetch counts as one request against the rate limit budget.

### Adapter interface (must match what worker/controllers call)

```python
class RobinhoodAdapter:
    def fetch_balance(self) -> dict: ...
    def fetch_open_orders(self, symbol=None) -> list: ...
    def fetch_closed_orders(self, symbol=None, since=None) -> list: ...
    def fetch_ticker(self, symbol: str) -> dict: ...
    def load_markets(self) -> dict: ...
    def create_market_sell_order(self, symbol, amount, params=None) -> dict: ...
    def create_order(self, symbol, type, side, amount, price, params=None) -> dict: ...
    # withdraw() intentionally unsupported in v1 — raises NotSupportedError
    # privatePostWithdrawAddresses() unsupported — returns []
```

**Files created:**
- `src/backend/helper/robinhood/__init__.py`
- `src/backend/helper/robinhood/client.py`
- `src/backend/helper/robinhood/accounts.py`
- `src/backend/helper/robinhood/orders.py`
- `src/backend/helper/robinhood/market.py`
- `src/backend/helper/robinhood/adapter.py`
- `src/backend/helper/robinhood/errors.py`

---

## Phase 3 — Factory & Registry Integration (routes unchanged)

### `ExchangeRegistry.py` changes
- Add `'robinhood'` to `SUPPORTED_EXCHANGES` with all capability flags.
- Add `'robinhood'` to `WITHDRAWAL_MINIMUMS` (empty dict for v1; kept for forward compatibility).
- `get_user_exchange()` branches to `RobinhoodAdapter` when `exchange_name == 'robinhood'`; all other exchanges continue using the existing CCXT path.

### `ExchangeClient.py` changes
- `create_exchange()` gets a conditional branch: if `exchange_name == 'robinhood'`, instantiate `RobinhoodAdapter` instead of a CCXT class.
- All other functions remain unchanged — the adapter satisfies the same method contract.

### `ExchangeConnectionController.py` changes
- `validate_keys` route: call `adapter.fetch_balance()` instead of CCXT's `fetch_balance()` — no route change needed since adapter implements the same method.

**Files touched:**
- [`src/backend/helper/ExchangeRegistry.py`](src/backend/helper/ExchangeRegistry.py)
- [`src/backend/helper/ExchangeClient.py`](src/backend/helper/ExchangeClient.py)
- [`src/backend/controllers/ExchangeConnectionController.py`](src/backend/controllers/ExchangeConnectionController.py)

---

## Phase 4 — Backend Capability Enforcement

### `AutomationController.py` changes
After validating `action_conn` exists and is validated, add:

```python
from helper.ExchangeRegistry import SUPPORTED_EXCHANGES

action_exchange_meta = SUPPORTED_EXCHANGES.get(action_conn['exchange_name'], {})

if action_type == 'withdraw_crypto' and not action_exchange_meta.get('supports_withdraw', False):
    exchange_label = action_exchange_meta.get('name', action_conn['exchange_name'])
    return bad_request(
        f"Withdraw Crypto is not supported for {exchange_label}. "
        f"Only 'Convert Crypto' is available for this exchange."
    )
```

This applies uniformly to Coinbase, Binance, and Robinhood.

### `worker.py` changes (defense-in-depth)
Before executing a withdraw action at runtime, add a capability guard:

```python
conn_row = get_connection_row(user_id, rule.action_exchange_id)
exchange_meta = SUPPORTED_EXCHANGES.get(conn_row['exchange_name'], {})
if not exchange_meta.get('supports_withdraw', False):
    AutomationDbContext.create_log(
        rule_id=rule.id, user_id=rule.user_id,
        trigger_event=trigger_event,
        action_executed="Withdraw (skipped)",
        action_result=f"Withdraw is not supported for {exchange_meta.get('name', conn_row['exchange_name'])}",
        status='error',
    )
    continue
```

**Files touched:**
- [`src/backend/controllers/AutomationController.py`](src/backend/controllers/AutomationController.py)
- [`src/backend/automation/worker.py`](src/backend/automation/worker.py)

---

## Phase 5 — Frontend Alignment (same routes)

### `commands.ts` changes
Replace the hard-coded exchange list:

```typescript
// Before
const noAddressExchanges = ['coinbase', 'binance'];

// After — drive from capability metadata returned by /api/exchanges/supported
const noAddressExchanges = ExchangeStore.supportedExchanges
  .filter(e => !e.has_withdrawal_addresses)
  .map(e => e.id);
```

This means Robinhood is automatically included in the unsupported notice without any further code changes.

### `exchangestore.ts` / `exchangedata.ts` changes
- Ensure the `SupportedExchange` type includes `has_withdrawal_addresses` (and optionally `supports_withdraw`, `supports_convert`) from the `/api/exchanges/supported` response — already present in the backend response, just needs to be stored on the frontend model.

**Files touched:**
- [`src/app/viewmodels/overview/commands.ts`](src/app/viewmodels/overview/commands.ts)
- [`src/app/services/exchangestore.ts`](src/app/services/exchangestore.ts)
- [`src/app/services/exchangedata.ts`](src/app/services/exchangedata.ts)

---

## Phase 6 — Data & Migration

- Robinhood connection rows use the same `exchange_connections` schema — no migration needed.
- Any existing automation rules that now fail the new capability check (e.g., a previously-created withdraw rule on Coinbase/Binance) should be **soft-disabled** with a log entry, not deleted. Worker's runtime guard covers this path.

---

## Phase 7 — Verification Checklist

### Backend
- [ ] `POST /api/exchanges/connections` — create Robinhood connection with valid keys → `201`
- [ ] `POST /api/exchanges/connections/<id>/validate` — valid Robinhood keys → validated; invalid → clear error
- [ ] `GET /api/exchange/<id>/balance` — returns non-zero balances
- [ ] `GET /api/exchange/<id>/open-orders` — returns list
- [ ] `POST /api/automation/rules` — withdraw rule on Robinhood → `400` with capability message
- [ ] `POST /api/automation/rules` — convert rule (balance/price threshold) on Robinhood → `201`
- [ ] Worker poll cycle — convert rule executes and logs `success`
- [ ] Worker poll cycle — legacy withdraw rule logs `error` with capability reason, does not throw

### Frontend
- [ ] Robinhood selected → unsupported notice appears (same style as Coinbase/Binance)
- [ ] No hard-coded exchange IDs remain in unsupported-notice logic
- [ ] Only supported actions are selectable when Robinhood is active exchange
- [ ] No route or API endpoint changes visible in network calls

### Regression
- [ ] Kraken: withdrawal addresses, withdraw rule creation, convert — all still work
- [ ] Coinbase: convert rules still work; withdraw rule still blocked (now via API, not just UI)
- [ ] Binance: same as Coinbase

---

## Decisions

| Topic | Decision |
|---|---|
| Robinhood auth | Ed25519 key-pair signing via `pynacl` (`x-api-key` + `x-signature` + `x-timestamp`) |
| Credential storage | `api_key_encrypted` = API key; `private_key_encrypted` = base64 Ed25519 private key seed |
| API version | v1 (simpler, no per-call `account_number` requirement for most endpoints) |
| Base URL | `https://trading.robinhood.com` |
| Symbol format | `BTC-USD` (uppercase, dash-separated) |
| Rate limiting | Token bucket: 100 req/min sustained, 300 burst; 429-triggered exponential backoff in `client.py` |
| Robinhood withdraw support | Unsupported in v1 |
| Enforcement model | Backend validation for all exchanges (not UI-only) |
| Unsupported legacy rules | Soft-disable + log reason (no hard-delete) |
| Route changes | None — all existing endpoints and payloads unchanged |
| Market data source | Robinhood `best_bid_ask` endpoint via adapter (`ask` price used as market price) |
| Market order support | Confirmed supported — `convert_crypto` is feasible |
| HTTP retry strategy | 429-triggered exponential backoff in `client.py` (max 4 retries: 1s, 2s, 4s, 8s) |
| Pagination | `get_all_pages()` helper in `client.py` follows `next` cursor automatically |
| New dependency | `pynacl` — add to `src/backend/requirements.txt` |

---

## Open Questions (resolve before implementation)

~~1. **Robinhood Crypto Trading API endpoint base URL**~~ — ✅ Resolved: `https://trading.robinhood.com`

~~2. **Order type support**~~ — ✅ Resolved: market orders are fully supported. `convert_crypto` is feasible using `market_order_config: { asset_quantity: "..." }`.

~~3. **Ticker/quote format**~~ — ✅ Resolved: `BTC-USD` (uppercase, dash-separated). Adapter must convert internal `BTC/USD`-style symbols to `BTC-USD` before calling the API.

~~4. **Rate limits**~~ — ✅ Resolved: 100 req/min sustained, 300 burst (token bucket). HTTP 429 on breach. See Phase 2 Rate Limiting section for retry strategy.

**Remaining open question:**

5. **API version for orders** — v1 orders endpoint does not require `account_number` in the path, but v2 does. Plan targets v1 for simplicity. Confirm this is acceptable or whether fee-tier access (v2) is needed.
