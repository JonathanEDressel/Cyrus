"""Rotating file logging, and getting the process off the inherited stdout pipe.

Why this exists
---------------
In a packaged install Electron spawns ``CyrusServer.exe`` and reads its stdout
to learn the bound port. Node only drains that pipe while the parent lives; if
Electron exits or stops reading, the OS pipe buffer (tens of KB) fills up and
the **next ``print()`` blocks forever**.

That is not hypothetical — it is exactly how the automation worker ended up
silently dead for three days while Flask kept happily serving requests. The
worker prints a traceback every poll cycle when an exchange call fails, so a
persistent error plus a departed reader is all it takes to wedge it.

The fix is to stop writing to that pipe at all once the port handshake is done:
``redirect_std_streams()`` re-points ``sys.stdout``/``sys.stderr`` at a rotating
log file. Existing ``print()`` calls throughout the backend keep working
unchanged — they just land somewhere that can never block.
"""

import io
import logging
import os
import sys
from logging.handlers import RotatingFileHandler

LOG_FILENAME = 'cyrus.log'
MAX_BYTES = 2 * 1024 * 1024   # 2 MB per file
BACKUP_COUNT = 3              # ~8 MB ceiling total

_configured = False
_log_path: str | None = None


def log_dir() -> str:
    """Directory for logs — alongside the database so it follows DATABASE_PATH."""
    db = os.getenv('DATABASE_PATH')
    base = (os.path.dirname(db) if db
            else os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    path = os.path.join(base, 'logs')
    os.makedirs(path, exist_ok=True)
    return path


def setup_logging() -> str:
    """Configure the rotating file handler. Returns the log file path."""
    global _configured, _log_path
    if _configured and _log_path:
        return _log_path

    _log_path = os.path.join(log_dir(), LOG_FILENAME)
    handler = RotatingFileHandler(
        _log_path, maxBytes=MAX_BYTES, backupCount=BACKUP_COUNT, encoding='utf-8'
    )
    handler.setFormatter(logging.Formatter(
        '%(asctime)s %(levelname)-7s %(message)s', datefmt='%Y-%m-%d %H:%M:%S'
    ))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(handler)
    _configured = True
    return _log_path


def get_log_path() -> str | None:
    return _log_path


class _StreamToLogger(io.TextIOBase):
    """File-like shim that turns writes into log records, line by line.

    Every write is wrapped in a bare ``except``: this object replaces stdout for
    the whole process, so if it ever raised (disk full, rotation race) it would
    take down whatever thread was merely trying to print. Losing a log line is
    always preferable to losing the worker.
    """

    def __init__(self, logger: logging.Logger, level: int):
        self._logger = logger
        self._level = level
        self._buf = ''

    def write(self, s) -> int:
        if not s:
            return 0
        try:
            self._buf += s
            while '\n' in self._buf:
                line, self._buf = self._buf.split('\n', 1)
                if line.strip():
                    self._logger.log(self._level, line.rstrip())
        except Exception:
            self._buf = ''
        return len(s)

    def flush(self) -> None:
        try:
            if self._buf.strip():
                self._logger.log(self._level, self._buf.strip())
            self._buf = ''
        except Exception:
            self._buf = ''

    def isatty(self) -> bool:
        return False

    def writable(self) -> bool:
        return True


def redirect_std_streams(force: bool = False) -> bool:
    """Point stdout/stderr at the log file so they can never block.

    No-op when stdout is an interactive terminal, so running
    ``python Server.py`` in dev still prints to the console. Pass
    ``force=True`` to override.

    Returns True if the streams were redirected.
    """
    if not force:
        try:
            if sys.stdout is not None and sys.stdout.isatty():
                return False
        except Exception:
            pass  # a detached/None stdout is exactly the case we want to fix

    setup_logging()
    sys.stdout = _StreamToLogger(logging.getLogger('stdout'), logging.INFO)
    sys.stderr = _StreamToLogger(logging.getLogger('stderr'), logging.ERROR)
    return True
