# -*- mode: python ; coding: utf-8 -*-
#
# Builds the bundled backend for both platforms:
#   Windows -> dist/CyrusServer.exe          (single file, as always)
#   macOS   -> dist/CyrusServer/CyrusServer   (folder build: starts faster than a
#              single file, which unpacks itself on every launch, and is the
#              layout Apple's signing/notarization expects)
#
# Run it through the venv's interpreter so the packages below resolve from it:
#   Windows:  venv\Scripts\python.exe -m PyInstaller server.spec --noconfirm
#   macOS:    venv/bin/python -m PyInstaller server.spec --noconfirm
# (The venv's pyinstaller.exe launcher can point at a stale interpreter and
# silently build without the assistant's packages — hence the check below.)
import os
import sys
import glob
import importlib.util

IS_MAC = sys.platform == 'darwin'

_REQUIRED = ['flask', 'flask_cors', 'ccxt', 'anthropic', 'pydantic', 'bcrypt',
             'cryptography', 'jwt', 'dotenv', 'certifi', 'nacl', 'sqlcipher3']
_missing = [m for m in _REQUIRED if importlib.util.find_spec(m) is None]
if _missing:
    raise SystemExit(
        f'server.spec: {sys.executable} is missing {", ".join(_missing)}. '
        'Run PyInstaller with the venv\'s python: python -m PyInstaller server.spec')

# Find ccxt through the interpreter running PyInstaller rather than a
# hard-coded path, so the same spec works on any machine (and in CI).
try:
    import ccxt
    CCXT_DIR = os.path.dirname(ccxt.__file__)
    SITE_PACKAGES = os.path.dirname(CCXT_DIR)
except ImportError:
    # Old fallback for the original dev machine's venv layout.
    SITE_PACKAGES = r'C:\Users\jonat\Documents\Resume Projects\Cyrus\venv\Lib\site-packages'
    CCXT_DIR = os.path.join(SITE_PACKAGES, 'ccxt')

# Collect all ccxt .py files as hidden imports
ccxt_hidden = []
for py in glob.glob(os.path.join(CCXT_DIR, '**', '*.py'), recursive=True):
    mod = py.replace(SITE_PACKAGES + os.sep, '').replace(os.sep, '.').removesuffix('.py')
    if mod.endswith('.__init__'):
        mod = mod.removesuffix('.__init__')
    ccxt_hidden.append(mod)

# Include the entire ccxt directory as data (for JSON configs etc.)
ccxt_datas = [(CCXT_DIR, 'ccxt')]

a = Analysis(
    ['Server.py'],
    pathex=[SITE_PACKAGES],
    binaries=[],
    datas=ccxt_datas,
    hiddenimports=ccxt_hidden + [
        # Flask internals
        'flask',
        'flask.json',
        'flask_cors',
        # Crypto / auth
        'bcrypt',
        'cryptography',
        'cryptography.fernet',
        'cryptography.hazmat.primitives.kdf.pbkdf2',
        'jwt',
        # SQLCipher (encrypted database): the extension module carries
        # SQLCipher and its crypto statically.
        'sqlcipher3',
        'sqlcipher3.dbapi2',
        'sqlcipher3._sqlite3',
        # dotenv
        'dotenv',
        # Anthropic SDK (portfolio assistant) and the transport stack it pulls
        # in. PyInstaller misses most of these because they're reached through
        # httpx's lazy imports rather than a plain top-level import.
        'anthropic',
        'httpx',
        'httpcore',
        'h11',
        'anyio',
        'sniffio',
        'certifi',
        'distro',
        'jiter',
        'pydantic',
        'pydantic_core',
        'pydantic.deprecated.decorator',
        # Standard lib helpers often missed
        'sqlite3',
        'email.mime.text',
        'email.mime.multipart',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

if IS_MAC:
    exe = EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,
        name='CyrusServer',
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,       # UPX breaks Mach-O code signatures
        console=True,    # no console window on macOS; stdout is piped to Electron
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,  # each CI runner builds its own architecture
        codesign_identity=None,
        entitlements_file=None,
    )
    coll = COLLECT(
        exe,
        a.binaries,
        a.datas,
        strip=False,
        upx=False,
        upx_exclude=[],
        name='CyrusServer',
    )
else:
    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.datas,
        [],
        name='CyrusServer',
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=True,
        upx_exclude=[],
        runtime_tmpdir=None,
        console=False,   # no console window when launched by Electron
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
    )
