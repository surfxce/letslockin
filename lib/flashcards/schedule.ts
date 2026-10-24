/** Four-grade, SM-2-style scheduling. Learning steps use elapsed time; reviews use days. */
export type Rating = 1 | 2 | 3 | 4;
export const RATINGS = [1, 2, 3, 4] as const;
export const RATING_LABELS = { 1: "Didn't get this", 2: "Got this a little", 3: "Got this a bit", 4: "Got it" } as const;
export interface Schedule {
  state: string;
  intervalDays: number;
  ease: number;
  repetitions: number;
  lapses: number;
}
const DAY = 86_400_000;
/** Forgotten this many times after being learnt: a problem card, worth rewording or splitting. */
export const LEECH_LAPSES = 4;
export function scheduleCard(card: Schedule, rating: Rating, now = new Date()) {
  if (!RATINGS.includes(rating)) throw new Error("Choose one of the four ratings.");
  const learning = card.state !== "review";
  const ease = Math.max(1.3, Math.min(3, card.ease + (rating === 1 ? -0.2 : rating === 2 ? -0.15 : rating === 4 ? 0.15 : 0)));
  let intervalDays: number;
  let state: string;
  if (rating === 1 || (learning && rating === 2)) {
    intervalDays = (rating === 1 ? 1 : 5) / 1440;
    state = "learning";
  } else {
    const previous = Math.max(1, card.intervalDays);
    intervalDays = learning ? (rating === 4 ? 4 : 1)
      : Math.max(previous + 1, Math.round(previous * (rating === 2 ? 1.2 : rating === 4 ? ease * 1.3 : ease)));
    intervalDays = Math.min(3650, intervalDays);
    state = "review";
  }
  return {
    state, intervalDays, ease,
    repetitions: card.repetitions + 1,
    lapses: card.lapses + (rating === 1 && card.state === "review" ? 1 : 0),
    dueAt: new Date(now.getTime() + intervalDays * DAY),
  };
}
export function intervalLabel(days: number) {
  return days < 1 ? `${Math.round(days * 1440)} min` : `${Math.round(days)} ${days === 1 ? "day" : "days"}`;
}
