"""Robinhood HTTP transport: Ed25519 signing, rate-limit retry, pagination.

Every outbound request goes through RobinhoodClient.request().  The caller
never constructs raw HTTP requests directly.

Rate-limiting:
  Robinhood uses a token-bucket model per user account:
    - Sustained: 100 requests / minute (refill rate ~1.67 tokens/s)
    - Burst capacity: 300 tokens
    - HTTP 429 is returned when the bucket is empty.
  We handle 429 with exponential back-off (1 s → 2 s → 4 s → 8 s, max 4 retries).

Authentication:
  Every request must include three headers:
    x-api-key   : The API key (format: rh-api-<uuid>)
    x-timestamp : Unix timestamp (seconds).  Valid for 30 seconds only —
                  requests MUST be sent immediately after signing.
    x-signature : Base64-encoded Ed25519 signature of
                    "{api_key}{timestamp}{path}{method}{body}"
                  using the private key seed stored in private_key_b64.
"""

import base64
import json
import time

import requests
from nacl.signing import SigningKey

from helper.robinhood.errors import (
    RobinhoodAuthError,
    RobinhoodError,
    RobinhoodRateLimitError,
)

BASE_URL = "https://trading.robinhood.com"
_MAX_RETRIES = 4
_BASE_BACKOFF = 1.0  # seconds; doubles on each retry


class RobinhoodClient:
    """Thin authenticated HTTP client for the Robinhood Crypto Trading API."""

    def __init__(self, api_key: str, private_key_b64: str) -> None:
        self.api_key = api_key
        try:
            seed = base64.b64decode(private_key_b64)
            self._private_key = SigningKey(seed)
        except Exception as exc:
            raise RobinhoodAuthError(f"Invalid private key format: {exc}") from exc

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _timestamp() -> str:
        return str(int(time.time()))

    def _build_headers(self, method: str, path: str, body_str: str, timestamp: str) -> dict:
        message = f"{self.api_key}{timestamp}{path}{method}{body_str}"
        signed = self._private_key.sign(message.encode("utf-8"))
        return {
            "x-api-key": self.api_key,
            "x-timestamp": timestamp,
            "x-signature": base64.b64encode(signed.signature).decode("utf-8"),
            "Content-Type": "application/json",
        }

    # ------------------------------------------------------------------
    # Core request method with retry on 429
    # ------------------------------------------------------------------

    def request(self, method: str, path: str, body: dict | None = None) -> dict:
        """Execute an authenticated request, retrying up to 4 times on 429."""
        body_str = json.dumps(body) if body else ""
        url = BASE_URL + path

        for attempt in range(_MAX_RETRIES + 1):
            timestamp = self._timestamp()
            headers = self._build_headers(method, path, body_str, timestamp)

            try:
                if method == "GET":
                    resp = requests.get(url, headers=headers, timeout=15)
                elif method == "POST":
                    resp = requests.post(url, headers=headers, data=body_str, timeout=15)
                else:
                    raise RobinhoodError(f"Unsupported HTTP method: {method}")
            except requests.RequestException as exc:
                raise RobinhoodError(f"Network error contacting Robinhood: {exc}") from exc

            if resp.status_code == 401:
                raise RobinhoodAuthError("Invalid API key or signature — check your credentials")
            if resp.status_code == 403:
                raise RobinhoodAuthError("Access forbidden — verify API key permissions")

            if resp.status_code == 429:
                if attempt < _MAX_RETRIES:
                    wait = _BASE_BACKOFF * (2 ** attempt)  # 1 s, 2 s, 4 s, 8 s
                    print(f"[ROBINHOOD] Rate limited, retrying in {wait:.0f}s (attempt {attempt + 1}/{_MAX_RETRIES})")
                    time.sleep(wait)
                    continue
                raise RobinhoodRateLimitError("Robinhood rate limit exceeded — too many requests")

            if resp.status_code >= 500:
                raise RobinhoodError(f"Robinhood server error ({resp.status_code})")

            if resp.status_code >= 400:
                try:
                    err = resp.json()
                    errors = err.get("errors", [])
                    detail = errors[0].get("detail", str(err)) if errors else str(err)
                except Exception:
                    detail = resp.text or str(resp.status_code)
                raise RobinhoodError(f"Robinhood API error: {detail}")

            return resp.json()

        raise RobinhoodRateLimitError("Robinhood rate limit exceeded after all retries")

    # ------------------------------------------------------------------
    # Convenience wrappers
    # ------------------------------------------------------------------

    def get(self, path: str) -> dict:
        return self.request("GET", path)

    def post(self, path: str, body: dict | None = None) -> dict:
        return self.request("POST", path, body)

    def get_all_pages(self, path: str) -> list:
        """Follow pagination cursors and collect all results.

        Each page fetch counts as one request against the rate-limit budget.
        The ``next`` URL in the response is a full URL; we strip the base to
        obtain a path for the next signed request.
        """
        results: list = []
        response = self.get(path)

        while response:
            results.extend(response.get("results", []))
            next_url = response.get("next")
            if not next_url:
                break
            next_path = next_url.replace(BASE_URL, "")
            response = self.get(next_path)

        return results
