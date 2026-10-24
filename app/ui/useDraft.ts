"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Text that outlives the page: whatever is typed or pasted is kept in this browser
 * under `key`, so leaving and coming back finds it still there. The first render uses
 * `initial` on server and client alike (no hydration mismatch); the kept text is read
 * just after mount. Storage that is full or blocked only means the text is not kept.
 */
export function usePersistentText(
  key: string,
  initial = "",
): [value: string, setValue: (value: string) => void, clear: () => void] {
  const [value, setState] = useState(initial);
  // The key the current value belongs to; nothing is written for a key until it has been read.
  const loadedKey = useRef<string | null>(null);

  useEffect(() => {
    const saved = readText(key);
    loadedKey.current = key;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is readable only after mount
    setState(saved ?? initial);
    // `initial` is a starting point, not something to follow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const setValue = useCallback(
    (next: string) => {
      setState(next);
      if (loadedKey.current === key) writeText(key, next);
    },
    [key],
  );

  const clear = useCallback(() => {
    setState("");
    writeText(key, "");
  }, [key]);

  return [value, setValue, clear];
}

export function readText(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Empty text removes the entry rather than keeping an empty one about. */
export function writeText(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Full or blocked: the text is still on the page, just not kept.
  }
}
