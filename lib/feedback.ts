import type { FeedbackKind } from "@/lib/paste";

export interface FeedbackItem {
  kind: FeedbackKind;
  text: string;
}

/**
 * One feedback list for every way an answer gets marked: by the worker against the
 * frozen rubric (criteria + concept-tagged gaps), pasted from an AI chat, or left
 * blank. The UI never has to care which.
 */
export function feedbackFor(response: {
  rawMarkingJson: string | null;
  gaps: Array<{ type: string; text: string; concept: { name: string } }>;
}): { raw: string | null; items: FeedbackItem[] } {
  let data: Record<string, unknown> = {};
  try {
    data = response.rawMarkingJson ? JSON.parse(response.rawMarkingJson) : {};
  } catch {
    // Unreadable marking: show the gaps alone.
  }

  if (data.source === "pasted" || data.source === "blank") {
    const items = Array.isArray(data.feedback) ? (data.feedback as FeedbackItem[]) : [];
    return { raw: typeof data.raw === "string" ? data.raw : null, items };
  }

  const items: FeedbackItem[] = [];
  const criteria = Array.isArray(data.criteria)
    ? (data.criteria as Array<{ point: string; awarded: number; outOf: number; note: string | null }>)
    : [];
  for (const c of criteria) {
    if (c.outOf > 0 && c.awarded >= c.outOf) items.push({ kind: "good", text: c.point });
  }
  for (const g of response.gaps.filter((g) => g.type === "WRONG")) {
    items.push({ kind: "wrong", text: g.text });
  }
  for (const g of response.gaps.filter((g) => g.type === "MISSED")) {
    items.push({ kind: "missed", text: g.text });
  }
  // Partly-earned points the marker commented on, when no gap already says it.
  for (const c of criteria) {
    if (c.awarded > 0 && c.awarded < c.outOf && c.note) {
      items.push({ kind: "note", text: `${c.point} (${c.awarded}/${c.outOf}): ${c.note}` });
    }
  }
  return { raw: null, items };
}

/** A rubric as stored on a question, tolerant of both generated and pasted shapes. */
export function readRubric(json: string): {
  modelAnswer: string | null;
  criteria: Array<{ point: string; marks: number | null }>;
  marks: number | null;
} {
  try {
    const r = JSON.parse(json);
    return {
      modelAnswer: typeof r.modelAnswer === "string" && r.modelAnswer.trim() ? r.modelAnswer : null,
      criteria: Array.isArray(r.criteria)
        ? r.criteria.map((c: { point?: string; marks?: number | null }) => ({
            point: String(c.point ?? ""),
            marks: typeof c.marks === "number" ? c.marks : null,
          }))
        : [],
      marks: typeof r.totalMarks === "number" ? r.totalMarks : null,
    };
  } catch {
    return { modelAnswer: null, criteria: [], marks: null };
  }
}
