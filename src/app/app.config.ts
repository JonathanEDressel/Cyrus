const AppConfig = {
  API_BASE: 'http://127.0.0.1:5000/api',
  TOKEN_KEY: 'cyrus_token',
  USER_KEY: 'cyrus_user',

  // Resolve the backend's actual port (it may not be 5000 if that port was
  // taken). Must be awaited before any API call is made. Falls back to 5000
  // if the Electron bridge isn't available.
  async init(): Promise<void> {
    try {
      const bridge = (window as any).cyrus;
      if (bridge && typeof bridge.getBackendPort === 'function') {
        const port = await bridge.getBackendPort();
        if (port) {
          this.API_BASE = `http://127.0.0.1:${port}/api`;
        }
      }
    } catch (err) {
      console.error('[AppConfig] Could not resolve backend port; using default.', err);
    }
    console.log('[AppConfig] API_BASE =', this.API_BASE);
  },
};
