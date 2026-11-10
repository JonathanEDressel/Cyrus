/**
 * Save a generated file to disk — through Electron's native Save dialog when
 * the preload bridge is there, or as a plain browser download when it isn't
 * (an older build, or the renderer opened outside Electron).
 *
 * Shared by every page that exports something, so the dialog/fallback/reveal
 * behaviour stays identical across them.
 */

interface FileSaveOptions {
  filename: string;
  /** File content, base64-encoded (see `FileSave.textToBase64` for text). */
  base64: string;
  /** MIME type for the browser-download fallback. */
  mime: string;
  /** Label for the Save dialog's file-type filter, e.g. "CSV file". */
  filterName: string;
  extensions: string[];
  /** Open the containing folder once saved. Defaults to true. */
  reveal?: boolean;
}

interface FileSaveResult {
  saved: boolean;
  canceled?: boolean;
  path?: string;
  /** True when it went out as a browser download rather than a dialog. */
  browser?: boolean;
  error?: string;
}

class FileSave {
  /**
   * UTF-8-safe base64. `btoa` alone throws on anything outside Latin-1 (a coin
   * name, a label with an accent), so the text is encoded to bytes first. The
   * bytes are fed to `String.fromCharCode` in chunks because spreading a large
   * array as arguments overflows the call stack.
   */
  static textToBase64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
    }
    return btoa(binary);
  }

  static async save(options: FileSaveOptions): Promise<FileSaveResult> {
    const bridge = (window as any).cyrus;
    if (typeof bridge?.saveFile !== 'function') {
      FileSave.browserDownload(options.filename, options.base64, options.mime);
      return { saved: true, browser: true };
    }

    const result = await bridge.saveFile({
      defaultName: options.filename,
      base64: options.base64,
      filterName: options.filterName,
      extensions: options.extensions,
    });
    if (result?.canceled) return { saved: false, canceled: true };
    if (!result?.saved) return { saved: false, error: result?.error || 'Could not save the file.' };

    if (options.reveal !== false && result.path && typeof bridge?.showItemInFolder === 'function') {
      bridge.showItemInFolder(result.path);
    }
    return { saved: true, path: result.path };
  }

  /** Anchor-and-blob download, for when the Electron bridge isn't there. */
  static browserDownload(filename: string, base64: string, mime: string): void {
    const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    // Revoked on a timer: Chromium needs the URL to still resolve when it
    // starts the download, which happens after this returns.
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}
