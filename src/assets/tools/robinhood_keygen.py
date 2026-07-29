"""Generate (and optionally verify) Robinhood Crypto API credentials for Cyrus.

Robinhood never hands you a secret. You generate an Ed25519 keypair yourself,
give Robinhood the PUBLIC key, and it issues an API key ID in return. The
PRIVATE key never leaves your machine - it signs every request Cyrus makes.

So this script does the half that can be automated: it creates the keypair and
prints both halves in the exact formats needed. Registering the public key is a
manual step on robinhood.com that no script can do for you.

Nothing is installed and nothing is saved: it runs on a plain Python 3 with only
the standard library, and prints the keys for you to paste. Generating your keys
yourself, offline, is the point - the app never sees the private key until you
choose to give it.

Usage
-----
Double-click it, or:

    python robinhood_keygen.py                 generate a new keypair
    python robinhood_keygen.py --json          same, as JSON
    python robinhood_keygen.py --verify --api-key rh-api-... --private-key "..."

--verify needs internet (it makes one signed request to Robinhood). Generating
keys does not, and is safe to run on a machine that has never been online.
"""

import argparse
import base64
import hashlib
import json
import os
import secrets
import sys


ACCOUNT_PATH = "/api/v1/crypto/trading/accounts/"
BASE_URL = "https://trading.robinhood.com"
CREDENTIALS_URL = "https://robinhood.com/account/crypto"


def _fail(message: str, hint: str = "") -> None:
    print(f"\n  ERROR: {message}", file=sys.stderr)
    if hint:
        print(f"  {hint}", file=sys.stderr)
    _pause_if_double_clicked()
    sys.exit(1)


# ---------------------------------------------------------------------------
# Ed25519
#
# PyNaCl and `cryptography` are used when present because they are fast and
# audited. The pure-Python fallback below is the RFC 8032 reference algorithm on
# top of hashlib, so this script still works on a bare Python install with no
# pip access - which is the situation anyone running the packaged Cyrus is in.
# ---------------------------------------------------------------------------

_Q = 2 ** 255 - 19
_L = 2 ** 252 + 27742317777372353535851937790883648493


def _inv(x: int) -> int:
    return pow(x, _Q - 2, _Q)


_D = -121665 * _inv(121666) % _Q
_I = pow(2, (_Q - 1) // 4, _Q)


def _x_recover(y: int) -> int:
    xx = (y * y - 1) * _inv(_D * y * y + 1)
    x = pow(xx, (_Q + 3) // 8, _Q)
    if (x * x - xx) % _Q != 0:
        x = (x * _I) % _Q
    if x % 2 != 0:
        x = _Q - x
    return x


_BY = 4 * _inv(5) % _Q
_B = (_x_recover(_BY) % _Q, _BY % _Q)


def _point_add(p: tuple, q: tuple) -> tuple:
    x1, y1 = p
    x2, y2 = q
    x3 = (x1 * y2 + x2 * y1) * _inv(1 + _D * x1 * x2 * y1 * y2)
    y3 = (y1 * y2 + x1 * x2) * _inv(1 - _D * x1 * x2 * y1 * y2)
    return (x3 % _Q, y3 % _Q)


def _scalar_mult(point: tuple, e: int) -> tuple:
    """Double-and-add, iterative so a 253-bit scalar can't hit the recursion cap."""
    result = (0, 1)
    addend = point
    while e > 0:
        if e & 1:
            result = _point_add(result, addend)
        addend = _point_add(addend, addend)
        e >>= 1
    return result


def _encode_point(point: tuple) -> bytes:
    x, y = point
    bits = [(y >> i) & 1 for i in range(255)] + [x & 1]
    return bytes(
        sum(bits[i * 8 + j] << j for j in range(8)) for i in range(32)
    )


def _clamp_scalar(h: bytes) -> int:
    a = int.from_bytes(h[:32], "little")
    a &= (1 << 254) - 8       # clear the low 3 bits
    a |= 1 << 254             # set bit 254
    return a


def _pure_public_key(seed: bytes) -> bytes:
    h = hashlib.sha512(seed).digest()
    return _encode_point(_scalar_mult(_B, _clamp_scalar(h)))


def _pure_sign(seed: bytes, message: bytes) -> bytes:
    h = hashlib.sha512(seed).digest()
    a = _clamp_scalar(h)
    public = _encode_point(_scalar_mult(_B, a))
    r = int.from_bytes(hashlib.sha512(h[32:] + message).digest(), "little")
    big_r = _encode_point(_scalar_mult(_B, r))
    k = int.from_bytes(hashlib.sha512(big_r + public + message).digest(), "little")
    s = (r + k * a) % _L
    return big_r + s.to_bytes(32, "little")


def _backend() -> tuple:
    """Return ``(name, public_key_from_seed, sign)`` from the best available library."""
    try:
        from nacl.signing import SigningKey

        return (
            "PyNaCl",
            lambda seed: bytes(SigningKey(seed).verify_key),
            lambda seed, msg: SigningKey(seed).sign(msg).signature,
        )
    except ImportError:
        pass

    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

        def public(seed: bytes) -> bytes:
            return Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes(
                encoding=serialization.Encoding.Raw,
                format=serialization.PublicFormat.Raw,
            )

        return (
            "cryptography",
            public,
            lambda seed, msg: Ed25519PrivateKey.from_private_bytes(seed).sign(msg),
        )
    except ImportError:
        pass

    return ("built-in", _pure_public_key, _pure_sign)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def _pause_if_double_clicked() -> None:
    """Keep the window open when launched from Explorer rather than a shell."""
    if os.name != "nt" or not sys.stdout.isatty():
        return
    try:
        input("\n  Press Enter to close...")
    except (EOFError, KeyboardInterrupt):
        pass


def generate(as_json: bool) -> None:
    name, public_from_seed, _ = _backend()

    # 32 cryptographically-random bytes: the private key, in the seed form Cyrus
    # expects. The expanded 64-byte form other tools emit will NOT load.
    seed = secrets.token_bytes(32)
    private_b64 = base64.b64encode(seed).decode()
    public_b64 = base64.b64encode(public_from_seed(seed)).decode()

    if as_json:
        print(json.dumps({
            "public_key": public_b64,
            "private_key": private_b64,
            "backend": name,
        }, indent=2))
        return

    print()
    print("=" * 72)
    print("  ROBINHOOD API KEYPAIR")
    print("=" * 72)
    print()
    print("  STEP 1 - Give this PUBLIC key to Robinhood")
    print(f"           {CREDENTIALS_URL}")
    print("           (API keys -> create new -> paste as the public key)")
    print()
    print(f"      {public_b64}")
    print()
    print("  STEP 2 - Robinhood shows you an API key ID like")
    print("           rh-api-1a2b3c4d-5e6f-7890-abcd-ef1234567890")
    print("           That goes in Cyrus's 'API Key' field.")
    print()
    print("  STEP 3 - Paste this PRIVATE key into Cyrus's 'Private Key' field")
    print("           Profile -> Exchange Connections -> Robinhood")
    print()
    print(f"      {private_b64}")
    print()
    print("-" * 72)
    print("  This private key is not saved anywhere by this script, and Robinhood")
    print("  never sees it. Anyone who has it can trade your crypto account, so")
    print("  don't paste it into a chat or a support ticket, and close this window")
    print("  when you're done. Lost it? Run this again and register the new public")
    print("  key - the old pair simply stops working.")
    print("-" * 72)
    print(f"  Keys generated with: {name}")
    print()
    _pause_if_double_clicked()


def verify(api_key: str, private_key_b64: str) -> None:
    """One signed request, so bad credentials fail here instead of inside Cyrus."""
    _, _, sign = _backend()

    try:
        seed = base64.b64decode(private_key_b64, validate=True)
    except Exception as exc:
        _fail(f"Private key isn't valid base64: {exc}")

    if len(seed) != 32:
        _fail(
            f"Private key decodes to {len(seed)} bytes; 32 are expected.",
            "A 64-byte key is the expanded form - its first 32 bytes are the "
            "seed, or just generate a fresh pair with this script.",
        )

    import time
    import urllib.error
    import urllib.request

    timestamp = str(int(time.time()))
    # Must match helper/robinhood/client.py: api_key + timestamp + path + method
    # + body, where a GET has an empty body.
    message = f"{api_key}{timestamp}{ACCOUNT_PATH}GET".encode()
    signature = base64.b64encode(sign(seed, message)).decode()

    request = urllib.request.Request(
        BASE_URL + ACCOUNT_PATH,
        headers={
            "x-api-key": api_key,
            "x-timestamp": timestamp,
            "x-signature": signature,
            "Content-Type": "application/json",
        },
    )

    print(f"\n  GET {BASE_URL}{ACCOUNT_PATH}")
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            status = response.status
            body = json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        status = exc.code
        body = {}
        detail = (exc.read() or b"").decode("utf-8", "replace")[:400]
    except Exception as exc:
        _fail(f"Network error contacting Robinhood: {exc}")
    else:
        detail = ""

    print(f"  HTTP {status}\n")

    if status == 200:
        print("  Credentials work. Cyrus can use this pair.")
        for field in ("account_number", "status", "buying_power", "buying_power_currency"):
            if field in body:
                print(f"    {field}: {body[field]}")
        print()
        _pause_if_double_clicked()
        return

    if status == 401:
        _fail("401 Unauthorized - the API key and private key don't match, or the "
              "public key for this pair was never registered with Robinhood.",
              "Check the API key ID was pasted exactly, and that Robinhood holds "
              "the public key from the SAME run of this script.")
    if status == 403:
        _fail("403 Forbidden - the key is recognised but lacks permission.",
              "Give the key trading and read scopes in Robinhood.")
    if status == 429:
        _fail("429 Rate limited - wait a minute and try again.")
    _fail(f"Unexpected response: {detail or status}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate or verify Robinhood Crypto API credentials for Cyrus.",
    )
    parser.add_argument("--verify", action="store_true",
                        help="test credentials you already have instead of generating new ones")
    parser.add_argument("--api-key", help="Robinhood API key ID (rh-api-...), with --verify")
    parser.add_argument("--private-key", help="base64 private key, with --verify")
    parser.add_argument("--json", action="store_true",
                        help="print the generated pair as JSON")
    args = parser.parse_args()

    if args.verify:
        if not args.api_key or not args.private_key:
            _fail("--verify needs both --api-key and --private-key.")
        verify(args.api_key.strip(), args.private_key.strip())
    else:
        generate(args.json)


if __name__ == "__main__":
    main()
