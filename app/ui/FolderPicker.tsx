"use client";

import { useEffect, useRef, useState } from "react";

import "@/app/ui/desktop";
import { Icon } from "@/app/ui/Icon";

/**
 * In the desktop app this is a real folder picker. In a browser tab the button is
 * not rendered, and the path is typed.
 */
export function FolderPicker({ defaultValue, onPicked }: { defaultValue: string; onPicked?: () => void }) {
  const [desktop, setDesktop] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- window only exists after mount
  useEffect(() => setDesktop(!!window.lockin?.pickFolder), []);

  return (
    <div className="row" style={{ alignItems: "flex-end", flexWrap: "nowrap" }}>
      <label className="field" style={{ flex: 1 }}>
        <span>Folder</span>
        <input
          ref={input}
          name="root"
          placeholder={desktop ? "Choose a folder…" : "/Users/you/Documents/Uni/BIOL3010"}
          defaultValue={defaultValue}
          required
          spellCheck={false}
          onClick={async () => {
            if (!desktop || input.current?.value) return;
            const picked = await window.lockin!.pickFolder();
            if (picked && input.current) {
              input.current.value = picked;
              onPicked?.();
            }
          }}
        />
      </label>
      {desktop && (
        <button
          type="button"
          className="btn"
          onClick={async () => {
            const picked = await window.lockin!.pickFolder();
            if (picked && input.current) {
              input.current.value = picked;
              onPicked?.();
            }
          }}
        >
          <Icon name="folder" /> Choose…
        </button>
      )}
    </div>
  );
}
