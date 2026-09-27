"use client";

import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    lockin?: { pickFolder(): Promise<string | null> };
  }
}

/**
 * In the desktop app this is a real folder picker. In a browser tab the button
 * simply is not rendered, and the path is typed.
 */
export function FolderPicker({ defaultValue }: { defaultValue: string }) {
  const [desktop, setDesktop] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => setDesktop(typeof window !== "undefined" && !!window.lockin), []);

  return (
    <div className="inline" style={{ alignItems: "flex-end" }}>
      <label className="field" style={{ flex: 1, minWidth: 260 }}>
        <span>Folder{desktop ? "" : " path"}</span>
        <input
          ref={input}
          name="root"
          placeholder="~/Documents/uni/BIOL3010"
          defaultValue={defaultValue}
          readOnly={desktop}
          required
        />
      </label>
      {desktop && (
        <button
          type="button"
          className="ghost"
          onClick={async () => {
            const picked = await window.lockin!.pickFolder();
            if (picked && input.current) input.current.value = picked;
          }}
        >
          Choose folder…
        </button>
      )}
    </div>
  );
}
