"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { setMode, setNotify } from "@/app/actions";
import "@/app/ui/desktop";
import type { Mode } from "@/lib/settings";

/** Choosing a mode saves it; there is no separate save button to forget. */
export function ModePicker({ mode, cliFound, cliVersion }: { mode: Mode; cliFound: boolean; cliVersion: string | null }) {
  const form = useRef<HTMLFormElement>(null);
  return (
    <form ref={form} action={setMode}>
      <label className="choice">
        <input type="radio" name="mode" value="auto" defaultChecked={mode === "auto"} onChange={() => form.current?.requestSubmit()} />
        <span>
          <span className="ct">
            Automatic
            {cliFound ? (
              <span className="tag t-green">Claude Code {cliVersion ? `· ${cliVersion}` : "found"}</span>
            ) : (
              <span className="tag t-red">Claude Code not found</span>
            )}
          </span>
          <span className="cd">
            Lockin prepares lectures itself with Claude Code on this computer, one lecture at a time, and marks your answers.
            {!cliFound && (
              <>
                {" "}
                Install it with <code>npm i -g @anthropic-ai/claude-code</code> and run <code>claude</code> once to sign in.
              </>
            )}
          </span>
        </span>
      </label>
      <label className="choice">
        <input type="radio" name="mode" value="manual" defaultChecked={mode === "manual"} onChange={() => form.current?.requestSubmit()} />
        <span>
          <span className="ct">Copy & paste</span>
          <span className="cd">
            No AI runs here. Each lecture has Copy prompt buttons for any AI chat, and boxes that format what you paste back.
          </span>
        </span>
      </label>
    </form>
  );
}

export function NotifyToggle({ enabled }: { enabled: boolean }) {
  const [on, setOn] = useState(enabled);
  const [note, setNote] = useState<string | null>(null);
  const [desktop, setDesktop] = useState(false);
  const [, start] = useTransition();
  // eslint-disable-next-line react-hooks/set-state-in-effect -- window only exists after mount
  useEffect(() => setDesktop(!!window.lockin?.desktop), []);

  const change = async (want: boolean) => {
    setNote(null);
    if (want && !window.lockin?.desktop) {
      if (!("Notification" in window)) {
        setNote("This browser cannot show notifications. The desktop app can.");
        return;
      }
      if (Notification.permission === "default") await Notification.requestPermission();
      if (Notification.permission !== "granted") {
        setNote("Notifications are blocked for this page — allow them in the browser's site settings.");
        return;
      }
    }
    setOn(want);
    start(() => setNotify(want));
  };

  const test = () => {
    if (!("Notification" in window) || Notification.permission !== "granted") {
      setNote("Turn reminders on first.");
      return;
    }
    new Notification("Time to redo your LAQs", { body: "This is what a Lockin reminder looks like." });
  };

  return (
    <>
      <div className="setting">
        <div>
          <div className="st">Remind me when LAQs are due</div>
          <div className="sd">
            One notification a day per due lecture, between 8am and 10pm.{" "}
            {desktop
              ? "The desktop app sends them even with its window closed."
              : "In a browser, only while a Lockin tab is open — the desktop app sends them any time."}
          </div>
          {note && <div className="result err" style={{ marginTop: 4 }}>{note}</div>}
        </div>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          {on && (
            <button type="button" className="btn sm" onClick={test}>
              Test
            </button>
          )}
          <label className="switch">
            <input type="checkbox" checked={on} onChange={(e) => change(e.target.checked)} aria-label="Reminders" />
            <span />
          </label>
        </div>
      </div>
    </>
  );
}
