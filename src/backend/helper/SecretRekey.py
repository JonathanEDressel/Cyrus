"""Move stored secrets from an old SECRET_KEY to the current one.

Until 1.5.0 every packaged install ran with the same placeholder SECRET_KEY,
so the Fernet-encrypted exchange keys (and the email password and Anthropic
key) could be decrypted by anyone with the database file. Installs now get a
random key of their own (src/main.ts). On the first start with it, each stored
secret that the new key can't read but an old one can is decrypted and
re-encrypted, and the API-key fingerprints (peppered with SECRET_KEY) are
recomputed. Idempotent: values already on the current key are left alone.

The old keys arrive as a JSON list in CYRUS_LEGACY_SECRET_KEYS.
"""
import base64
import hashlib
import json
import os

from cryptography.fernet import Fernet, InvalidToken

#: (table, column) pairs holding Fernet ciphertext under SECRET_KEY.
ENCRYPTED_COLUMNS = [
    ('exchange_connections', 'api_key_encrypted'),
    ('exchange_connections', 'private_key_encrypted'),
    ('exchange_connections', 'passphrase_encrypted'),
    ('users', 'smtp_password_encrypted'),
    ('users', 'anthropic_key_encrypted'),
    ('users', 'alpaca_key_id_encrypted'),
    ('users', 'alpaca_secret_encrypted'),
]


def _fernet(secret: str) -> Fernet:
    # Same derivation as helper.Security._get_encryption_key.
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(secret.encode('utf-8')).digest()))


def _fingerprint(secret: str, api_key: str) -> str:
    # Same as helper.Security.fingerprint_api_key.
    return hashlib.sha256(secret.encode('utf-8') + api_key.strip().encode('utf-8')).hexdigest()


def legacy_secrets_from_env(current: str) -> list[str]:
    try:
        values = json.loads(os.getenv('CYRUS_LEGACY_SECRET_KEYS') or '[]')
    except ValueError:
        return []
    return [v for v in values if isinstance(v, str) and v and v != current]


def _columns(conn, table: str) -> set:
    return {r[1] for r in conn.execute(f'PRAGMA table_info("{table}")')}


def rekey_secrets(conn, secret: str, legacy: list[str]) -> dict:
    """Re-encrypt every stored secret under *secret*. Returns counts."""
    stats = {'rekeyed': 0, 'current': 0, 'unreadable': 0, 'fingerprints': 0}
    if not legacy:
        return stats
    new = _fernet(secret)
    olds = [_fernet(s) for s in legacy]

    for table, column in ENCRYPTED_COLUMNS:
        if column not in _columns(conn, table):
            continue
        rows = conn.execute(
            f'SELECT id, "{column}" FROM "{table}" WHERE "{column}" IS NOT NULL AND "{column}" != \'\''
        ).fetchall()
        for row_id, token in rows:
            token_b = token.encode('utf-8')
            try:
                new.decrypt(token_b)
                stats['current'] += 1
                continue
            except InvalidToken:
                pass
            plain = None
            for old in olds:
                try:
                    plain = old.decrypt(token_b)
                    break
                except InvalidToken:
                    continue
            if plain is None:
                stats['unreadable'] += 1
                continue
            conn.execute(f'UPDATE "{table}" SET "{column}" = ? WHERE id = ?',
                         (new.encrypt(plain).decode('utf-8'), row_id))
            stats['rekeyed'] += 1

    # Fingerprints are peppered with the secret, so they move with it.
    if 'api_key_fingerprint' in _columns(conn, 'exchange_connections'):
        for row_id, token in conn.execute(
                'SELECT id, api_key_encrypted FROM exchange_connections '
                'WHERE api_key_encrypted IS NOT NULL').fetchall():
            try:
                api_key = new.decrypt(token.encode('utf-8')).decode('utf-8')
            except InvalidToken:
                continue
            conn.execute('UPDATE exchange_connections SET api_key_fingerprint = ? WHERE id = ?',
                         (_fingerprint(secret, api_key), row_id))
            stats['fingerprints'] += 1
    conn.commit()
    return stats
