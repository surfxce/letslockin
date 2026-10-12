/**
 * What the desktop app's preload script exposes. In a plain browser tab
 * `window.lockin` is absent and every caller falls back to the web equivalent.
 */
declare global {
  interface Window {
    lockin?: {
      desktop?: boolean;
      pickFolder(): Promise<string | null>;
    };
    /** Set while answering closed-book, so a background refresh never disturbs typing. */
    __lockinHoldRefresh?: boolean;
  }
}

export {};
