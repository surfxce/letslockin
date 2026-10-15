/**
 * What the desktop app's preload script exposes. In a plain browser tab
 * `window.lockin` is absent and every caller falls back to the web equivalent.
 */
declare global {
  interface Window {
    lockin?: {
      desktop?: boolean;
      pickFolder(): Promise<string | null>;
      /** Prints an /export address to a PDF the user names; null when they cancel. */
      savePdf?(
        pathname: string,
        title: string,
      ): Promise<{ ok: true; path: string; name: string } | { ok: false; message: string } | null>;
      /** Only files savePdf saved this session. */
      openFile?(path: string): Promise<void>;
      showFile?(path: string): Promise<void>;
    };
    /** Set while answering closed-book, so a background refresh never disturbs typing. */
    __lockinHoldRefresh?: boolean;
  }
}

export {};
