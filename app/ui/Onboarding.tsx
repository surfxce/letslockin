"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { finishOnboarding } from "@/app/actions";
import { Icon } from "@/app/ui/Icon";
import { ModelPicker } from "@/app/ui/ModelPicker";
import type { Mode } from "@/lib/modes";
import type { ModelsPayload } from "@/lib/payloads";

type StepKey = "intro" | "add" | "mode" | "model" | "practise" | "remind";

/**
 * The first-run walkthrough: what Lockin does, end to end. Opens by itself once, and
 * again from "How it works" (any link to #intro). Choosing to run the AI on this
 * computer adds a step for picking and downloading its model.
 */
export function Onboarding({
  firstRun,
  cliFound,
  hasCourses,
  mode: initialMode,
  notify: initialNotify,
  models,
}: {
  firstRun: boolean;
  cliFound: boolean;
  hasCourses: boolean;
  mode: Mode;
  notify: boolean;
  models: ModelsPayload;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(firstRun);
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<Mode>(firstRun && !cliFound ? "manual" : initialMode);
  const [notify, setNotify] = useState(initialNotify);
  const [saving, startSaving] = useTransition();

  useEffect(() => {
    const check = () => {
      if (window.location.hash === "#intro") {
        setStep(0);
        setOpen(true);
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, []);

  if (!open) return null;

  const keys: StepKey[] = ["intro", "add", "mode", ...(mode === "local" ? (["model"] as const) : []), "practise", "remind"];
  const key = keys[Math.min(step, keys.length - 1)];

  const finish = () =>
    startSaving(async () => {
      await finishOnboarding({ mode, notify });
      setOpen(false);
      if (!hasCourses) router.push("/courses/new");
      else router.refresh();
    });

  const askNotify = async (on: boolean) => {
    if (on && !window.lockin?.desktop && "Notification" in window && Notification.permission === "default") {
      const answer = await Notification.requestPermission();
      setNotify(answer === "granted");
      return;
    }
    setNotify(on);
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="intro-title">
      <div className={key === "model" ? "modal wide" : "modal"}>
        <div className="modal-body">
          {key === "intro" && (
            <>
              <div className="kicker">How Lockin works</div>
              <h2 id="intro-title">Lectures in, exam practice out</h2>
              <p>
                Lockin turns each lecture into a summary and a set of long-answer questions (LAQs), marks your answers, and
                tells you when to come back to each lecture. Five steps, and you only do two of them.
              </p>
              <div className="flow">
                <span className="node"><Icon name="folder" size={15} /> Lecture files</span>
                <span className="arrow">→</span>
                <span className="node"><Icon name="book" size={15} /> Summary</span>
                <span className="arrow">→</span>
                <span className="node"><Icon name="pen" size={15} /> LAQs</span>
                <span className="arrow">→</span>
                <span className="node"><Icon name="target" size={15} /> Score</span>
                <span className="arrow">→</span>
                <span className="node"><Icon name="bell" size={15} /> Reminder</span>
              </div>
            </>
          )}

          {key === "add" && (
            <>
              <div className="kicker">1 · Add your lectures</div>
              <h2 id="intro-title">Point it at a folder</h2>
              <p>
                Choose the folder your transcripts and slides are already in, however messy. Lockin pairs each transcript
                with its slides by lecture number, date or name — instantly, on your computer — and shows you the list to
                check before anything is imported.
              </p>
              <p>
                You can also add a single lecture by dropping in its files or pasting the transcript text.
              </p>
              <div className="callout">
                <span className="callout-icon"><Icon name="scissors" /></span>
                <p>
                  Each lecture is read on its own. <strong>Module aims, learning objectives and housekeeping are left
                  out</strong> of its title, summary and questions — and the lecture page shows you exactly what was skipped.
                </p>
              </div>
            </>
          )}

          {key === "mode" && (
            <>
              <div className="kicker">2 · Summary and LAQs</div>
              <h2 id="intro-title">Choose how the AI part happens</h2>
              <label className="choice">
                <input type="radio" name="mode" checked={mode === "auto"} onChange={() => setMode("auto")} />
                <span>
                  <span className="ct">
                    Automatic
                    {cliFound ? (
                      <span className="tag t-green">Claude Code found</span>
                    ) : (
                      <span className="tag t-gray">Claude Code not found on this computer</span>
                    )}
                  </span>
                  <span className="cd">
                    Lockin uses Claude Code to work through your lectures one at a time — summary first, then LAQs — and
                    the top-right corner always says what it&apos;s on and how long it&apos;s been.
                  </span>
                </span>
              </label>
              <label className="choice">
                <input type="radio" name="mode" checked={mode === "local"} onChange={() => setMode("local")} />
                <span>
                  <span className="ct">
                    On this computer — works fully offline
                    <span className="tag t-blue">Private · free</span>
                  </span>
                  <span className="cd">
                    Download a free AI model once and everything runs on your own {models.specs.kind}, with no internet
                    and no account. A little slower than Claude; next you&apos;ll pick a model that suits this machine.
                  </span>
                </span>
              </label>
              <label className="choice">
                <input type="radio" name="mode" checked={mode === "manual"} onChange={() => setMode("manual")} />
                <span>
                  <span className="ct">Copy & paste — works with any AI chat</span>
                  <span className="cd">
                    Nothing to install. Each lecture has a <strong>Copy prompt</strong> button: paste it into ChatGPT, Claude
                    or Gemini, then paste the reply into the box. Summaries, LAQs and scores are formatted for you.
                  </span>
                </span>
              </label>
              <p className="small">You can switch any time in Settings.</p>
            </>
          )}

          {key === "model" && (
            <>
              <div className="kicker">2b · Your offline model</div>
              <h2 id="intro-title">Pick a model for this {models.specs.kind}</h2>
              <p>
                We recommend the one in the middle for this computer&apos;s memory and processor. Go left for speed, right
                for quality. It downloads in the background — carry on with the tour — and links up by itself when
                it&apos;s done.
              </p>
              <ModelPicker initial={models} />
            </>
          )}

          {key === "practise" && (
            <>
              <div className="kicker">3 · Practise</div>
              <h2 id="intro-title">Read once, then answer closed book</h2>
              <p>
                Read a lecture&apos;s summary, then — ideally the next day — answer its LAQs from memory. The summary is
                out of sight while you answer: recalling it is what makes it stick.
              </p>
              <p>
                Each answer is marked out of 10 against a fixed marking guide, with what you got right, what you missed and
                what you got wrong. A sitting is scored with the <strong>geometric mean</strong>: 9 and 4 gives 6.0, not
                6.5, because one weak answer costs you in the exam too.
              </p>
              <div className="row">
                <span className="tag score t-red">0–3.9</span>
                <span className="tag score t-orange">4–5.9</span>
                <span className="tag score t-yellow">6–7.9</span>
                <span className="tag score t-green">8–10</span>
                <span className="small muted">— sort the table by “Weakest first” to see where to focus.</span>
              </div>
            </>
          )}

          {key === "remind" && (
            <>
              <div className="kicker">4 · Come back</div>
              <h2 id="intro-title">Redo each lecture&apos;s LAQs when it&apos;s due</h2>
              <p>
                Score 7 or more and the gap before the next sitting grows. Between 5 and 7 it holds. Under 5, the lecture
                is back tomorrow. Everything is pulled in before your exam date.
              </p>
              <div className="mini-ladder" aria-label="1, 3, 7, 14, then 30 days">
                {[1, 3, 7, 14, 30].map((d, i) => (
                  <div key={d}>
                    <i style={{ height: 12 + i * 12 }} />
                    {d}d
                  </div>
                ))}
              </div>
              <div className="setting" style={{ borderBottom: 0 }}>
                <div>
                  <div className="st">Remind me when LAQs are due</div>
                  <div className="sd">A notification once a day per lecture, never between 10pm and 8am.</div>
                </div>
                <label className="switch">
                  <input type="checkbox" checked={notify} onChange={(e) => askNotify(e.target.checked)} />
                  <span />
                </label>
              </div>
            </>
          )}
        </div>

        <div className="modal-foot">
          <div className="pips" aria-hidden="true">
            {keys.map((k, i) => (
              <i key={k} className={i === step ? "on" : undefined} />
            ))}
          </div>
          <span className="spacer" />
          {step > 0 && (
            <button className="btn quiet" onClick={() => setStep((s) => s - 1)}>
              Back
            </button>
          )}
          {step < keys.length - 1 ? (
            <button className="btn primary" onClick={() => setStep((s) => s + 1)}>
              Next <Icon name="arrowRight" size={14} />
            </button>
          ) : (
            <button className="btn primary" onClick={finish} disabled={saving}>
              {saving ? "Saving…" : hasCourses ? "Done" : "Add my first course"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
