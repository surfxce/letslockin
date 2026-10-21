"use client";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { gradeCard, nextCard } from "@/app/ak/actions";
import { RATINGS, RATING_LABELS, type Rating } from "@/lib/flashcards/schedule";
import { Icon } from "@/app/ui/Icon";

type ReviewState = Awaited<ReturnType<typeof nextCard>>;
export function Review({ lectureId, initial }: { lectureId: string; initial: ReviewState }) {
  const [data, setData] = useState(initial);
  const [revealed, setRevealed] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const busy = useRef(false);
  const card = data.card;

  function reload() {
    start(async () => {
      try { setData(await nextCard(lectureId)); setError(null); setRevealed(false); }
      catch { setError("Couldn't load your cards. Try again."); }
    });
  }
  function grade(rating: Rating) {
    if (!card || !revealed || pending || busy.current) return;
    busy.current = true;
    start(async () => {
      try {
        const result = await gradeCard(card.id, card.version, rating);
        if (!result.saved) { setError(result.reason); return; }
        setCompleted(n => n + 1);
        setRevealed(false);
        setData(await nextCard(lectureId));
        setError(null);
      } catch { setError("Couldn't load the next card. Your saved reviews are kept. Reload to continue."); }
      finally { busy.current = false; }
    });
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || target.closest("input,textarea,select,a,button,[contenteditable=true]")) return;
      if (event.code === "Space" && card && !pending) { event.preventDefault(); setRevealed(true); }
      const rating = Number(event.key) as Rating;
      if (revealed && RATINGS.includes(rating)) { event.preventDefault(); grade(rating); }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  });
  useEffect(() => {
    if (data.card || !data.nextDue) return;
    // Only wait for short learning steps, not a timer lasting several days.
    const wait = new Date(data.nextDue).getTime() - Date.now();
    if (wait > 5 * 60_000) return;
    const timer = setTimeout(() => start(async () => {
      try { setData(await nextCard(lectureId)); } catch { setError("Couldn't refresh due cards. Try again."); }
    }), Math.max(1000, wait + 250));
    return () => clearTimeout(timer);
  }, [data.card, data.nextDue, lectureId]);

  return <section className="ak-review">
    <div className="ak-review-top"><span>{completed} reviewed this session</span><span>{data.remaining} ready now</span></div>
    {error && <div className="callout" role="alert">{error} <button className="btn sm" onClick={reload} disabled={pending}>Reload</button></div>}
    {card ? <>
      <article className="ak-card" aria-busy={pending}>
        <span className="ak-eyebrow">{card.state === "new" ? "New card" : card.state === "learning" ? "Learning" : "Review"} · Question</span>
        <div className="prose ak-card-content" dangerouslySetInnerHTML={{ __html: card.front }} />
        {revealed && <div className="ak-answer"><span className="ak-eyebrow">Answer</span><div className="prose ak-card-content" dangerouslySetInnerHTML={{ __html: card.back }} /></div>}
      </article>
      {!revealed ? <div className="ak-reveal"><button className="btn primary lg" disabled={pending} onClick={() => setRevealed(true)}>Show answer</button><span className="small muted">Think of your answer first · Space to reveal</span></div> :
        <div><p className="small muted ak-rating-hint">How well did you remember? Your next review is shown below.</p><div className="ak-ratings">
          {RATINGS.map((rating, index) => <button key={rating} className={`btn ak-rating ak-rating-${rating}`} disabled={pending} onClick={() => grade(rating)}>
            <span>{RATING_LABELS[rating]}</span><small>{card.intervals[index]} <span className="ak-key">{rating}</span></small>
          </button>)}
        </div></div>}
    </> : <div className="ak-done"><Icon name="check" size={34} /><h2>You’re caught up</h2><p>No cards due in this deck right now.</p>
      {data.nextDue && <p className="muted">Next review: {new Date(data.nextDue).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })}.</p>}
      <div className="row"><Link href="/ak" className="btn primary">Back to decks</Link><button className="btn" onClick={reload} disabled={pending}>Check for due cards</button></div>
    </div>}
  </section>;
}
