"use client";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { gradeCard, nextCard, suspendCards } from "@/app/ak/actions";
import { LEECH_LAPSES, RATINGS, RATING_LABELS, type Rating } from "@/lib/flashcards/schedule";
import type { ReviewScope } from "@/lib/flashcards/review";
import { Icon } from "@/app/ui/Icon";

type ReviewState = Awaited<ReturnType<typeof nextCard>>;

/** Reviews one deck, or across decks (a course, a tag, everything, or only hard cards). */
export function Review({ scope, initial, across = false, done = "No cards due in this deck right now." }: {
  scope: ReviewScope;
  initial: ReviewState;
  /** Cards come from several lectures: each shows which. */
  across?: boolean;
  done?: string;
}) {
  const [data, setData] = useState(initial);
  const [revealed, setRevealed] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const busy = useRef(false);
  // A hard-cards session shows each card once, unless it comes due again.
  const seen = useRef<string[]>([]);
  const card = data.card;

  function reload() {
    start(async () => {
      try { setData(await nextCard(scope, seen.current)); setError(null); setRevealed(false); }
      catch { setError("Couldn't load your cards. Try again."); }
    });
  }
  function grade(rating: Rating) {
    if (!card || !revealed || pending || busy.current) return;
    busy.current = true;
    start(async () => {
      try {
        const result = await gradeCard(card.id, card.version, rating, !!scope.hard && !card.due);
        if (!result.saved) { setError(result.reason); return; }
        seen.current.push(card.id);
        setCompleted(n => n + 1);
        setRevealed(false);
        setNote(rating === 1 && card.lapses + 1 >= LEECH_LAPSES && card.state === "review"
          ? "You keep forgetting that one. Rewording it or splitting it into smaller cards usually helps — or suspend it for now."
          : null);
        setData(await nextCard(scope, seen.current));
        setError(null);
      } catch { setError("Couldn't load the next card. Your saved reviews are kept. Reload to continue."); }
      finally { busy.current = false; }
    });
  }
  function suspend() {
    if (!card) return;
    start(async () => {
      await suspendCards([card.id], true);
      seen.current.push(card.id);
      setRevealed(false);
      setNote("Suspended. It won't come up until you unsuspend it in the deck's cards.");
      setData(await nextCard(scope, seen.current));
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
      try { setData(await nextCard(scope, seen.current)); } catch { setError("Couldn't refresh due cards. Try again."); }
    }), Math.max(1000, wait + 250));
    return () => clearTimeout(timer);
  }, [data.card, data.nextDue, scope]);

  return <section className="ak-review">
    <div className="ak-review-top"><span>{completed} reviewed this session</span><span>{data.remaining} {scope.hard ? "to go" : "ready now"}</span></div>
    {error && <div className="callout" role="alert">{error} <button className="btn sm" onClick={reload} disabled={pending}>Reload</button></div>}
    {note && <div className="callout yellow" role="status">{note}</div>}
    {card ? <>
      <article className="ak-card" aria-busy={pending}>
        <div className="ak-card-top">
          <span className="ak-eyebrow">{card.state === "new" ? "New card" : card.state === "learning" ? "Learning" : "Review"} · Question</span>
          {card.problem && <span className="tag t-red" title={`Forgotten ${card.lapses} times`}>Problem card</span>}
          {across && card.lecture && <Link href={`/ak/${card.lectureId}`} className="ak-from">{card.lecture}</Link>}
        </div>
        <div className="prose ak-card-content" dangerouslySetInnerHTML={{ __html: card.front }} />
        {revealed && <div className="ak-answer"><span className="ak-eyebrow">Answer</span><div className="prose ak-card-content" dangerouslySetInnerHTML={{ __html: card.back }} /></div>}
        <div className="ak-card-tools">
          {card.tags.map(t => <span key={t} className="ak-tag">#{t}</span>)}
          <span className="spacer" />
          <Link href={`/ak/${card.lectureId}/cards?edit=${card.id}`} className="btn quiet sm"><Icon name="pen" size={13} /> Edit</Link>
          <button className="btn quiet sm" onClick={suspend} disabled={pending}>Suspend</button>
        </div>
      </article>
      {!revealed ? <div className="ak-reveal"><button className="btn primary lg" disabled={pending} onClick={() => setRevealed(true)}>Show answer</button><span className="small muted">Think of your answer first · Space to reveal</span></div> :
        <div><p className="small muted ak-rating-hint">How well did you remember? Your next review is shown below.</p><div className="ak-ratings">
          {RATINGS.map((rating, index) => <button key={rating} className={`btn ak-rating ak-rating-${rating}`} disabled={pending} onClick={() => grade(rating)}>
            <span>{RATING_LABELS[rating]}</span><small>{card.intervals[index]} <span className="ak-key">{rating}</span></small>
          </button>)}
        </div></div>}
    </> : <div className="ak-done"><Icon name="check" size={34} /><h2>You’re caught up</h2><p>{done}</p>
      {data.nextDue && <p className="muted">Next review: {new Date(data.nextDue).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })}.</p>}
      <div className="row"><Link href="/ak" className="btn primary">Back to decks</Link><button className="btn" onClick={reload} disabled={pending}>Check for due cards</button></div>
    </div>}
  </section>;
}
