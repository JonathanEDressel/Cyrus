"""The database is encrypted on disk with SQLCipher (AES-256, page-level).

Every connection goes through :func:`connect`, which unlocks the file with a
key derived from ``SECRET_KEY``. In a packaged install that secret is random
per install and kept by Electron in the operating system's protected storage
(DPAPI on Windows, the Keychain on macOS) — see ``loadSecretKey`` in
``src/main.ts`` — so a copy of ``kraking.db`` on its own can't be read.

Older installs have a plain SQLite file. :func:`ensure_encrypted` converts it
once at startup, before anything else opens it, and verifies the copy before
the plain file is removed.

Development: set ``CYRUS_DB_ENCRYPTION=off`` to keep a plain database you can
open in an SQLite browser. A packaged build ignores it.
"""
import hashlib
import json
import os
import sys

from sqlcipher3 import dbapi2 as sqlcipher

#: SQLite's plain-file header. An encrypted file starts with random bytes.
_PLAIN_HEADER = b'SQLite format 3\x00'

Row = sqlcipher.Row
DatabaseError = sqlcipher.DatabaseError


class DatabaseLockedError(RuntimeError):
    """The file is encrypted, but not with this install's key."""


def encryption_enabled() -> bool:
    if getattr(sys, 'frozen', False):
        return True
    return os.getenv('CYRUS_DB_ENCRYPTION', 'on').strip().lower() not in ('off', '0', 'false', 'no')


def _key_hex(secret: str) -> str:
    """A 256-bit raw key for SQLCipher, derived from the app secret.

    A raw ``x'...'`` key skips SQLCipher's own PBKDF2, which is there to
    stretch typed passwords; the secret here is already 32 random bytes in a
    packaged install, and skipping it keeps every connection cheap.
    """
    return hashlib.sha256(b'cyrus-sqlcipher-v1\x00' + secret.encode('utf-8')).hexdigest()


def _key_pragma(secret: str) -> str:
    return f"PRAGMA key = \"x'{_key_hex(secret)}'\""


def connect(db_path: str, secret: str, **kwargs):
    """Open (or create) the database, unlocked with *secret*'s key."""
    conn = sqlcipher.connect(db_path, **kwargs)
    if encryption_enabled():
        conn.execute(_key_pragma(secret))
    return conn


def is_plaintext(db_path: str) -> bool:
    try:
        with open(db_path, 'rb') as f:
            return f.read(16) == _PLAIN_HEADER
    except OSError:
        return False


def _opens_with(db_path: str, secret: str) -> bool:
    conn = sqlcipher.connect(db_path)
    try:
        conn.execute(_key_pragma(secret))
        conn.execute('SELECT count(*) FROM sqlite_master').fetchone()
        return True
    except sqlcipher.DatabaseError:
        return False
    finally:
        conn.close()


def _table_counts(conn) -> dict:
    tables = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")]
    return {t: conn.execute(f'SELECT count(*) FROM "{t}"').fetchone()[0] for t in tables}


def _remove(path: str) -> None:
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def ensure_encrypted(db_path: str, secret: str) -> str:
    """Make sure the file at *db_path* is encrypted with *secret*'s key.

    Returns what happened: ``'new'``, ``'encrypted'`` (already was),
    ``'converted'`` (was plain, now encrypted) or ``'disabled'``.
    Raises :class:`DatabaseLockedError` when the file is encrypted with a
    different key, rather than touching it.
    """
    if not encryption_enabled():
        return 'disabled'
    if not os.path.exists(db_path) or os.path.getsize(db_path) == 0:
        return 'new'
    if not is_plaintext(db_path):
        if _opens_with(db_path, secret):
            return 'encrypted'
        raise DatabaseLockedError(
            f'{db_path} is encrypted with a different key than this install has.')

    tmp = db_path + '.encrypting'
    _remove(tmp)

    plain = sqlcipher.connect(db_path)
    try:
        # Fold any write-ahead log into the main file first, so the export
        # sees every committed row.
        plain.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        before = _table_counts(plain)
        user_version = plain.execute('PRAGMA user_version').fetchone()[0]
        plain.execute(f"ATTACH DATABASE ? AS enc KEY \"x'{_key_hex(secret)}'\"", (tmp,))
        plain.execute("SELECT sqlcipher_export('enc')")
        plain.execute(f'PRAGMA enc.user_version = {int(user_version)}')
        plain.execute('DETACH DATABASE enc')
    finally:
        plain.close()

    # Verify the encrypted copy before the original goes anywhere.
    check = connect(tmp, secret)
    try:
        ok = check.execute('PRAGMA integrity_check').fetchone()[0]
        after = _table_counts(check)
    finally:
        check.close()
    if ok != 'ok' or after != before:
        _remove(tmp)
        raise RuntimeError(
            f'Encrypted copy failed verification (integrity: {ok}; '
            f'tables {json.dumps(before)} vs {json.dumps(after)}). The original is unchanged.')

    old = db_path + '.plain-old'
    _remove(old)
    os.replace(db_path, old)
    # The plain file's write-ahead log is already in the export (verified
    # above); left beside the new file it would be replayed into it.
    for wal in (db_path + '-wal', db_path + '-shm'):
        if os.path.exists(wal):
            os.replace(wal, old + wal[len(db_path):])
    try:
        os.replace(tmp, db_path)
    except Exception:
        os.replace(old, db_path)     # put the original back
        raise
    for leftover in (old, old + '-wal', old + '-shm'):
        try:
            _remove(leftover)
        except OSError as e:
            print(f'[DATABASE] Could not remove {leftover}: {e}')
    return 'converted'
