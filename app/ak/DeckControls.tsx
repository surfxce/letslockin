"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startDeck, stopDeck, setAutoFlashcards } from "@/app/ak/actions";
import { Icon } from "@/app/ui/Icon";

export function DeckControls({ lectureId, job }: { lectureId: string; job: { id: string; status: string; error: string | null } | null }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const busy = job?.status === "PENDING" || job?.status === "RUNNING";
  return <div>
    <button className="btn sm" disabled={pending} onClick={() => start(async () => {
      setError(null);
      try {
        if (busy) await stopDeck(job.id);
        else setError((await startDeck(lectureId)).error ?? null);
      } catch { setError("Couldn't save that change. Try again."); }
    })}>
      <Icon name={busy ? "x" : "sparkles"} size={14} />
      {pending ? "Saving…" : busy ? "Cancel" : job?.status === "FAILED" ? "Try again" : "Generate deck"}
    </button>
    {error && <p className="small ak-error" role="alert">{error}</p>}
  </div>;
}

/** Only active generation polls; the deck table does not refresh while someone reviews. */
export function DeckRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { if (!document.hidden) router.refresh(); }, 4000);
    return () => clearInterval(timer);
  }, [active, router]);
  return null;
}

export function AutoFlashcardsToggle({ enabled }: { enabled: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return <div className="setting">
    <div><div className="st">Generate AK decks with lectures</div>
      <div className="sd">Make a deck of flashcards whenever a lecture is prepared. You can also make decks one at a time in AK.</div>
      {error && <p role="alert" className="ak-error small">{error}</p>}
    </div>
    <label className="row"><input type="checkbox" aria-label="Generate AK decks with lectures" checked={enabled} disabled={pending} onChange={e => {
      const checked = e.target.checked;
      start(async () => { try { await setAutoFlashcards(checked); setError(null); } catch { setError("Couldn't save. Try again."); } });
    }} /> {pending ? "Saving…" : enabled ? "On" : "Off"}</label>
  </div>;
}
