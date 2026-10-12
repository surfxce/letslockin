/**
 * Display helpers shared by server and client components. Dates are formatted by
 * hand rather than with toLocaleDateString, so the server's render and the
 * browser's hydration always agree.
 */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type Tone = "gray" | "brown" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink" | "red";

function asDate(d: Date | string): Date {
  return typeof d === "string" ? new Date(d) : d;
}

/** "Tue 3 Mar", with the year only when it is not this year. */
export function shortDate(d: Date | string, now = new Date()): string {
  const date = asDate(d);
  const year = date.getFullYear() === now.getFullYear() ? "" : ` ${date.getFullYear()}`;
  return `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}${year}`;
}

/** "Tuesday 3 March 2026" style, for page headers. */
export function longDate(d: Date | string): string {
  const date = asDate(d);
  return `${DAYS_LONG[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

export function clockTime(d: Date | string): string {
  const date = asDate(d);
  const h = date.getHours();
  return `${((h + 11) % 12) + 1}:${String(date.getMinutes()).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
}

/** YYYY-MM-DD in local time, for <input type="date">. */
export function dateInput(d: Date | string): string {
  const date = asDate(d);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Parses <input type="date"> as local midnight, not UTC — "3 March" stays 3 March. */
export function fromDateInput(value: string): Date | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** "42s", "3m 05s", "1h 02m". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Whole days from now until a date, rounded up — "exam in 12 days". */
export function daysUntil(d: Date | string, now = new Date()): number {
  return Math.ceil((asDate(d).getTime() - now.getTime()) / 86_400_000);
}

export function hours(h: number): string {
  return h === 1 ? "1 hour" : `${h} hours`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Scores are out of ten; colour carries the meaning before the number is read. */
export function scoreTone(score: number | null): Tone {
  if (score === null) return "gray";
  if (score < 4) return "red";
  if (score < 6) return "orange";
  if (score < 8) return "yellow";
  return "green";
}

export function formatScore(score: number): string {
  return score.toFixed(1);
}

/** When the next sitting is due, in words, with a colour for urgency. */
export function dueLabel(dueAt: string | Date | null, now = new Date()): { text: string; tone: Tone } {
  if (!dueAt) return { text: "—", tone: "gray" };
  const due = asDate(dueAt);
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(due) - start(now)) / 86_400_000);
  if (days < 0) return { text: days === -1 ? "Overdue 1 day" : `Overdue ${-days} days`, tone: "red" };
  if (days === 0) return { text: "Today", tone: "orange" };
  if (days === 1) return { text: "Tomorrow", tone: "yellow" };
  if (days < 7) return { text: `In ${days} days`, tone: "gray" };
  return { text: shortDate(due, now), tone: "gray" };
}

/** Red, orange, yellow and green are kept for scores and due dates, so a module's
 *  colour never reads as a judgement. */
const TAG_TONES: Tone[] = ["blue", "purple", "pink", "brown", "gray"];

/** A stable colour for a module or course name, the way a Notion select gets one. */
export function tagTone(name: string): Tone {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TAG_TONES[h % TAG_TONES.length];
}
