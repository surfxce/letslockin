"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { setMode, setNotify } from "@/app/actions";
import { setLaqSettings } from "@/app/study-actions";
import "@/app/ui/desktop";
import { LAQ_STYLE_LABEL, LAQ_STYLES, MAX_PER_HOUR, type LaqStyle, type Mode } from "@/lib/modes";

/** Choosing a mode saves it; there is no separate save button to forget. */
export function ModePicker({
  mode,
  engine,
  localModel,
}: {
  mode: Mode;
  /** The cloud AI chosen, and whether it is ready to use. */
  engine: { label: string; ready: boolean; detail: string | null };
  /** Name of the linked local model, if one is downloaded. */
  localModel: string | null;
}) {
  const form = useRef<HTMLFormElement>(null);
  return (
    <form ref={form} action={setMode}>
      <label className="choice">
        <input type="radio" name="mode" value="auto" defaultChecked={mode === "auto"} onChange={() => form.current?.requestSubmit()} />
        <span>
          <span className="ct">
            Automatic
            {engine.ready ? (
              <span className="tag t-green">
                {engine.label}
                {engine.detail ? ` · ${engine.detail}` : ""}
              </span>
            ) : (
              <span className="tag t-red">
                {engine.label} {engine.detail ?? "not set up"}
              </span>
            )}
          </span>
          <span className="cd">
            Lockin prepares lectures itself with a cloud AI — Claude Code, ChatGPT Codex, Google Antigravity or an API
            key, chosen below — one lecture at a time, and marks your answers.
          </span>
        </span>
      </label>
      <label className="choice">
        <input type="radio" name="mode" value="local" defaultChecked={mode === "local"} onChange={() => form.current?.requestSubmit()} />
        <span>
          <span className="ct">
            On this computer
            {localModel ? <span className="tag t-green">{localModel}</span> : <span className="tag t-gray">no model yet</span>}
          </span>
          <span className="cd">
            A model downloaded to this computer does the work: fully offline, private and free, a little slower.
            Pick one below.
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

/** A whole number from 1 to MAX_PER_HOUR, with buttons either side. */
function Stepper({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" onClick={() => onChange(Math.max(1, value - 1))} disabled={value <= 1} aria-label="Fewer">
        −
      </button>
      <output aria-live="polite">{value}</output>
      <button
        type="button"
        onClick={() => onChange(Math.min(MAX_PER_HOUR, value + 1))}
        disabled={value >= MAX_PER_HOUR}
        aria-label="More"
      >
        +
      </button>
    </div>
  );
}

/** How many LAQs are written and asked, and how they are worded. */
export function LaqSettings({
  laqsPerHour,
  sittingPerHour,
  laqStyle,
}: {
  laqsPerHour: number;
  sittingPerHour: number;
  laqStyle: LaqStyle;
}) {
  const [written, setWritten] = useState(laqsPerHour);
  const [asked, setAsked] = useState(sittingPerHour);
  const [style, setStyle] = useState(laqStyle);
  const [, start] = useTransition();
  const save = (patch: Parameters<typeof setLaqSettings>[0]) => start(() => setLaqSettings(patch));
  const examples: Record<LaqStyle, string> = {
    mixed: "Whatever suits each concept — mostly direct questions, some set in a scenario.",
    story:
      "“Jane eats porridge at 7am, skips lunch and runs 5 km at 5pm. Explain how insulin and glucagon coordinate her energy storage and release…”",
    facts:
      "“Describe how insulin is synthesised and how it promotes glucose uptake into skeletal muscle. Compare GLUT4 with GLUT1 and GLUT3…”",
  };
  return (
    <>
      <div className="setting">
        <div>
          <div className="st">LAQs written per lecture hour</div>
          <div className="sd">
            When a lecture is prepared, and each time you press Write new LAQs — a 2-hour lecture gets {written * 2}.
          </div>
        </div>
        <Stepper
          label="LAQs written per lecture hour"
          value={written}
          onChange={(n) => {
            setWritten(n);
            save({ laqsPerHour: n });
          }}
        />
      </div>
      <div className="setting">
        <div>
          <div className="st">LAQs per sitting, per lecture hour</div>
          <div className="sd">
            How many a sitting asks, closed book — your weakest concepts first, so more written means more variety
            from one sitting to the next.
          </div>
        </div>
        <Stepper
          label="LAQs per sitting, per lecture hour"
          value={asked}
          onChange={(n) => {
            setAsked(n);
            save({ sittingPerHour: n });
          }}
        />
      </div>
      <div className="setting" style={{ alignItems: "flex-start" }}>
        <div>
          <div className="st">Question style</div>
          <div className="sd">{examples[style]}</div>
          <div className="sd faint" style={{ marginTop: 2 }}>Applies to LAQs written from now on.</div>
        </div>
        <div className="seg" role="radiogroup" aria-label="Question style">
          {LAQ_STYLES.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={style === s}
              className={style === s ? "on" : undefined}
              onClick={() => {
                setStyle(s);
                save({ laqStyle: s });
              }}
            >
              {LAQ_STYLE_LABEL[s]}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
