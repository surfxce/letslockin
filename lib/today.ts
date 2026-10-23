/**
 * The Today plan: what to study today, in order, to fit the time there is — LAQs that
 * are due (sooner exams first), AK cards that are due, the weakest lectures, some new
 * cards, and a practice exam when one is close. Built from what Lockin already knows;
 * nothing new is stored but how long the day is.
 */

/** Minutes a closed-book LAQ takes to write. */
export const MINUTES_PER_LAQ = 8;
/** Seconds a due card takes; a new card takes longer to learn. */
export const SECONDS_PER_REVIEW = 10;
export const SECONDS_PER_NEW_CARD = 25;
/** New cards suggested a day, across every deck. */
export const NEW_CARDS_PER_DAY = 20;

export type PlanKind = "cards" | "laq" | "weak" | "new-cards" | "exam";

export interface PlanItem {
  id: string;
  kind: PlanKind;
  title: string;
  detail: string;
  minutes: number;
  href: string;
  /** Overdue, or its exam is close. */
  urgent: boolean;
}

export interface Plan {
  budget: number;
  minutes: number;
  items: PlanItem[];
  /** Worth doing too, if there's time. */
  later: PlanItem[];
  exams: Array<{ courseId: string; code: string; days: number }>;
  /** Lectures that can't be studied yet because they aren't prepared. */
  unprepared: number;
}

export interface PlanLecture {
  id: string;
  title: string;
  courseId: string;
  courseCode: string;
  hasSummary: boolean;
  laqCount: number;
  lastScore: number | null;
  dueAt: string | null;
  /** Questions a sitting of it asks. */
  sittingSize: number;
}

export interface PlanInput {
  now: Date;
  budget: number;
  lectures: PlanLecture[];
  /** Days to each course's exam; absent when there's no date. */
  examDays: Map<string, number>;
  courseCodes: Map<string, string>;
  cardsDue: number;
  cardsNew: number;
  /** When an exam was last sat, if ever. */
  lastExamAt: Date | null;
}

const DAY = 86_400_000;

/** Exams soon make a lecture matter more: 1 with none in sight, up to 3 for one this week. */
function examWeight(days: number | undefined): number {
  if (days === undefined || days < 0) return 1;
  if (days <= 7) return 3;
  if (days <= 21) return 2;
  return 1;
}

export function buildPlan(input: PlanInput): Plan {
  const { now, budget, lectures, examDays } = input;
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const candidates: Array<PlanItem & { rank: number }> = [];

  if (input.cardsDue > 0) {
    candidates.push({
      id: "cards",
      kind: "cards",
      title: `Review ${input.cardsDue} AK card${input.cardsDue === 1 ? "" : "s"}`,
      detail: "Everything due across your decks. Little and often keeps them stuck.",
      minutes: Math.max(1, Math.ceil((input.cardsDue * SECONDS_PER_REVIEW) / 60)),
      href: "/ak/review",
      urgent: input.cardsDue >= 50,
      rank: 1000,
    });
  }

  const ready = lectures.filter((l) => l.hasSummary && l.laqCount > 0);
  for (const l of ready) {
    if (!l.dueAt || new Date(l.dueAt).getTime() >= endOfToday) continue;
    const overdueDays = Math.max(0, Math.floor((now.getTime() - new Date(l.dueAt).getTime()) / DAY));
    const weight = examWeight(examDays.get(l.courseId));
    candidates.push({
      id: `laq:${l.id}`,
      kind: "laq",
      title: `LAQs: ${l.title}`,
      detail: [
        l.courseCode,
        overdueDays ? `${overdueDays} day${overdueDays === 1 ? "" : "s"} overdue` : "due today",
        l.lastScore !== null ? `drill score ${l.lastScore.toFixed(1)}` : "first sitting",
      ].join(" · "),
      minutes: l.sittingSize * MINUTES_PER_LAQ,
      href: `/lectures/${l.id}?tab=laqs`,
      urgent: overdueDays > 0 || weight > 1,
      // Sooner exams first, then the longest overdue, then the weakest.
      rank: 900 + weight * 20 + Math.min(overdueDays, 30) - (l.lastScore ?? 0),
    });
  }

  const weak = ready
    .filter((l) => l.lastScore !== null && l.lastScore < 6 && !(l.dueAt && new Date(l.dueAt).getTime() < endOfToday))
    .sort((a, b) => examWeight(examDays.get(b.courseId)) - examWeight(examDays.get(a.courseId)) || a.lastScore! - b.lastScore!)
    .slice(0, 3);
  for (const l of weak) {
    candidates.push({
      id: `weak:${l.id}`,
      kind: "weak",
      title: `Drill a weak area: ${l.title}`,
      detail: `${l.courseCode} · drill score ${l.lastScore!.toFixed(1)}, not due yet — a sitting now lifts it sooner`,
      minutes: l.sittingSize * MINUTES_PER_LAQ,
      href: `/lectures/${l.id}?tab=laqs`,
      urgent: false,
      rank: 600 + examWeight(examDays.get(l.courseId)) * 20 - l.lastScore!,
    });
  }

  const fresh = Math.min(input.cardsNew, NEW_CARDS_PER_DAY);
  if (fresh > 0) {
    candidates.push({
      id: "new-cards",
      kind: "new-cards",
      title: `Learn ${fresh} new AK card${fresh === 1 ? "" : "s"}`,
      detail: input.cardsNew > fresh ? `${input.cardsNew} waiting — ${NEW_CARDS_PER_DAY} a day is plenty` : "They come after your due cards in a review",
      minutes: Math.max(1, Math.ceil((fresh * SECONDS_PER_NEW_CARD) / 60)),
      href: "/ak/review",
      urgent: false,
      rank: 500,
    });
  }

  // A practice exam a week while an exam is within four weeks.
  const soon = [...examDays].filter(([, d]) => d >= 0 && d <= 28).sort((a, b) => a[1] - b[1]);
  const examLately = input.lastExamAt && now.getTime() - input.lastExamAt.getTime() < 7 * DAY;
  if (soon.length && !examLately) {
    const [courseId, days] = soon[0];
    const code = input.courseCodes.get(courseId) ?? "";
    candidates.push({
      id: `exam:${courseId}`,
      kind: "exam",
      title: `Sit a practice exam for ${code}`,
      detail: `Your exam is in ${days} day${days === 1 ? "" : "s"}. Mixed questions, timed, across the course.`,
      minutes: 30,
      href: `/exam?course=${courseId}`,
      urgent: days <= 7,
      // In the last week it comes right after that course's own due LAQs.
      rank: 700 + (days <= 7 ? 250 : days <= 14 ? 120 : 0),
    });
  }

  candidates.sort((a, b) => b.rank - a.rank);
  const items: PlanItem[] = [];
  const later: PlanItem[] = [];
  let minutes = 0;
  for (const { rank: _rank, ...item } of candidates) {
    void _rank;
    // The first thing always goes in, even when it's longer than the day.
    if (items.length === 0 || minutes + item.minutes <= budget) {
      items.push(item);
      minutes += item.minutes;
    } else {
      later.push(item);
    }
  }

  return {
    budget,
    minutes,
    items,
    later,
    exams: [...examDays]
      .filter(([, d]) => d >= 0)
      .sort((a, b) => a[1] - b[1])
      .map(([courseId, days]) => ({ courseId, code: input.courseCodes.get(courseId) ?? "", days })),
    unprepared: lectures.filter((l) => !l.hasSummary || l.laqCount === 0).length,
  };
}

/** Today's plan from the database, as it is now. */
export async function todayPlan(now = new Date()): Promise<Plan> {
  const [{ prisma }, { lectureRows }, { getSettings }, { questionBudget }] = await Promise.all([
    import("@/lib/db"),
    import("@/lib/views"),
    import("@/lib/settings"),
    import("@/lib/engines/mastery"),
  ]);
  const [settings, rows, courses, cardsDue, cardsNew, lastExam] = await Promise.all([
    getSettings(),
    lectureRows(),
    prisma.course.findMany({ select: { id: true, code: true, examDate: true } }),
    prisma.flashcard.count({ where: { suspended: false, state: { not: "new" }, dueAt: { lte: now } } }),
    prisma.flashcard.count({ where: { suspended: false, state: "new" } }),
    prisma.exam.findFirst({ where: { submittedAt: { not: null } }, orderBy: { submittedAt: "desc" }, select: { submittedAt: true } }),
  ]);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const examDays = new Map<string, number>();
  for (const c of courses) {
    if (!c.examDate) continue;
    const d = c.examDate;
    examDays.set(c.id, Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - today) / DAY));
  }
  return buildPlan({
    now,
    budget: settings.dailyMinutes,
    lectures: rows.map((r) => ({
      id: r.id,
      title: r.title,
      courseId: r.courseId,
      courseCode: r.courseCode,
      hasSummary: r.hasSummary,
      laqCount: r.laqCount,
      lastScore: r.lastScore,
      dueAt: r.dueAt,
      sittingSize: Math.max(1, Math.min(r.laqCount, questionBudget(r.durationHours, settings.sittingPerHour))),
    })),
    examDays,
    courseCodes: new Map(courses.map((c) => [c.id, c.code])),
    cardsDue,
    cardsNew,
    lastExamAt: lastExam?.submittedAt ?? null,
  });
}
