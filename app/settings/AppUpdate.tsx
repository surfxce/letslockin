"use client";

import { useEffect, useState } from "react";

import type { UpdateCheck } from "@/app/ui/desktop";
import { Icon } from "@/app/ui/Icon";

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const mb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`;

/**
 * Which version the desktop app is, and its updates: checked when Settings opens, and
 * installed with one click — a few MB of Lockin's own code, then a restart. Not shown
 * in a browser, where `git pull` is the update.
 */
export function AppUpdate() {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [busy, setBusy] = useState<"checking" | "installing" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const run = async () => {
    if (!window.lockin?.checkUpdate) return;
    setBusy("checking");
    setProblem(null);
    setCheck(await window.lockin.checkUpdate());
    setBusy(null);
  };
  // eslint-disable-next-line react-hooks/set-state-in-effect -- window only exists after mount
  useEffect(() => void run(), []);

  if (!check || check.state === "unsupported") return null;
  const current = check.current;

  return (
    <>
      <h2 id="updates">Updates</h2>
      <div className="setting" style={{ alignItems: "flex-start" }}>
        <div>
          <div className="st">
            {check.state === "available" ? "A new version of Lockin is ready" : "Lockin is up to date"}
          </div>
          <div className="sd">
            {current && (
              <>
                This is build <code>{current.version}</code> from {day(current.builtAt)}.{" "}
              </>
            )}
            {check.state === "available" && (
              <>
                The new one is <code>{check.latest.version}</code> from {day(check.latest.builtAt)}
                {check.latest.notes ? `: ${check.latest.notes}` : ""}.{" "}
                {check.inPlace
                  ? `It's a ${mb(check.latest.size)} download, then Lockin restarts.`
                  : "It needs a newer Electron or libraries, so it comes as the full download: open it and drag Lockin into Applications again."}
              </>
            )}
            {check.state === "error" && <span className="result err">Couldn&apos;t check: {check.message}</span>}
            {problem && <span className="result err"> Couldn&apos;t update: {problem}</span>}
          </div>
        </div>
        {check.state === "available" && check.inPlace ? (
          <button
            type="button"
            className="btn primary"
            disabled={!!busy}
            onClick={async () => {
              setBusy("installing");
              const why = await window.lockin!.installUpdate!();
              // On success Lockin restarts and this never resolves to anything.
              setProblem(why);
              setBusy(null);
            }}
          >
            <Icon name="download" size={14} /> {busy === "installing" ? "Updating…" : "Update and restart"}
          </button>
        ) : check.state === "available" ? (
          <a className="btn primary" href={check.latest.dmg}>
            <Icon name="download" size={14} /> Download Lockin.dmg
          </a>
        ) : (
          <button type="button" className="btn" disabled={!!busy} onClick={() => void run()}>
            <Icon name="refresh" size={14} /> {busy === "checking" ? "Checking…" : "Check again"}
          </button>
        )}
      </div>
    </>
  );
}
