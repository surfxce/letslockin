/**
 * What the desktop app's preload script exposes. In a plain browser tab
 * `window.lockin` is absent and every caller falls back to the web equivalent.
 */
interface BuildInfo {
  version: string;
  builtAt: string;
  depsHash: string;
  notes?: string;
}

/** Newer changes still being built on GitHub: when the update should be ready. */
interface Building {
  version: string;
  notes: string;
  readyAt: string;
}

export type UpdateCheck =
  | { state: "unsupported"; current: BuildInfo | null }
  | { state: "current"; current: BuildInfo; building?: Building }
  | {
      state: "available";
      current: BuildInfo;
      building?: Building;
      latest: BuildInfo & { size: number; dmg: string };
      /** False when it needs new libraries or Electron: only the .dmg will do. */
      inPlace: boolean;
    }
  | { state: "error"; current: BuildInfo | null; message: string };

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
      /** Only files savePdf saved this session; resolves to what went wrong, if anything. */
      openFile?(path: string): Promise<string | null>;
      showFile?(path: string): Promise<string | null>;
      /** Updating from Settings (electron/updates.ts). */
      checkUpdate?(): Promise<UpdateCheck>;
      /** Downloads the update and restarts into it; resolves only with what went wrong. */
      installUpdate?(): Promise<string | null>;
    };
    /** Set while answering closed-book, so a background refresh never disturbs typing. */
    __lockinHoldRefresh?: boolean;
  }
}

export {};
