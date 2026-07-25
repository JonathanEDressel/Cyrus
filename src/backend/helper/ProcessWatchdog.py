"""Exit when the process that launched us goes away.

Without this, closing or crashing Electron leaves ``CyrusServer.exe`` running
indefinitely. The orphan keeps holding port 5000, so the *next* launch finds the
port taken and silently talks to the stale backend — potentially a build from
weeks earlier — while the freshly installed one either falls back to a random
port or never starts at all.

Electron passes its own PID as ``CYRUS_PARENT_PID``. On Windows we block on a
handle to that process rather than polling, so the exit is immediate and costs
nothing while the parent is alive.
"""

import os
import sys
import threading
import time

_POSIX_POLL_SECONDS = 5


def watch_parent_process() -> bool:
    """Start the watchdog thread. Returns True if watching."""
    raw = os.getenv('CYRUS_PARENT_PID')
    if not raw:
        return False
    try:
        ppid = int(raw)
    except (TypeError, ValueError):
        return False
    if ppid <= 0:
        return False

    thread = threading.Thread(
        target=_wait_for_parent, args=(ppid,), daemon=True, name='parent-watchdog'
    )
    thread.start()
    print(f'[SERVER] Watching parent process {ppid}; will exit when it does.')
    return True


def _wait_for_parent(ppid: int) -> None:
    try:
        if sys.platform == 'win32':
            _wait_windows(ppid)
        else:
            _wait_posix(ppid)
    except Exception as e:
        # Never let a watchdog failure take the server down.
        print(f'[SERVER] Parent watchdog stopped: {e}')


def _wait_windows(ppid: int) -> None:
    import ctypes

    SYNCHRONIZE = 0x00100000
    INFINITE = 0xFFFFFFFF

    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(SYNCHRONIZE, False, ppid)
    if not handle:
        # Could not open the parent (already gone, or denied). Don't guess and
        # exit — a false positive would kill a perfectly good server. The
        # Electron-side stale-process sweep covers this case instead.
        print(f'[SERVER] Could not watch parent {ppid}; continuing without watchdog.')
        return
    try:
        kernel32.WaitForSingleObject(handle, INFINITE)
    finally:
        kernel32.CloseHandle(handle)
    _exit_orphaned(ppid)


def _wait_posix(ppid: int) -> None:
    while True:
        if os.getppid() != ppid:
            _exit_orphaned(ppid)
            return
        time.sleep(_POSIX_POLL_SECONDS)


def _exit_orphaned(ppid: int) -> None:
    print(f'[SERVER] Parent process {ppid} exited; shutting down to avoid orphaning.')
    try:
        sys.stdout.flush()
    except Exception:
        pass
    # Hard exit: every DB helper opens and closes its own connection, so there
    # is nothing buffered to lose, and we want the port released immediately.
    os._exit(0)
