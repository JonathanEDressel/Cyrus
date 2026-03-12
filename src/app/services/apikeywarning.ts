class ApiKeyWarning {
  private static dismissed = false;

  static init(): void {
    ApiKeyState.onChange(() => ApiKeyWarning.update());

    document.getElementById('api-key-warning-dismiss')?.addEventListener('click', () => {
      ApiKeyWarning.dismissed = true;
      ApiKeyWarning.hide();
    });

    ApiKeyWarning.update();
  }

  static update(): void {
    const status = ApiKeyState.status;

    if (status === 'valid' || status === 'checking' || status === 'unknown') {
      ApiKeyWarning.hide();
      if (status === 'valid') {
        ApiKeyWarning.dismissed = false;
        // Keys just became valid — start KrakenStore if it wasn't running
        KrakenStore.start();
      }
      return;
    }

    if (ApiKeyWarning.dismissed) return;

    const messageEl = document.getElementById('api-key-warning-message');
    if (!messageEl) return;

    if (status === 'none') {
      messageEl.textContent = 'No Kraken API keys configured. Add your API keys in Settings to enable automation features.';
    } else if (status === 'invalid') {
      const error = ApiKeyState.error;
      messageEl.textContent = error
        ? `Invalid Kraken API keys: ${error}. Please update them in Settings.`
        : 'Invalid Kraken API keys. Please check your credentials in Settings.';
    }

    ApiKeyWarning.show();
  }

  private static show(): void {
    document.getElementById('api-key-warning')?.classList.remove('d-none');
  }

  private static hide(): void {
    document.getElementById('api-key-warning')?.classList.add('d-none');
  }
}
