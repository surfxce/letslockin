/**
 * Module aims and learning objectives describe a whole module, and lecturers paste
 * the same slide at the front of every lecture in it. Left in, they leak into the
 * title, pad the summary and earn questions of their own. This drops them from
 * slide text before any model sees it, and says what it dropped.
 *
 * Transcripts are left alone: a lecturer reading the aims aloud is not separable
 * from the lecture by pattern alone, so the prompts handle that case instead.
 */

export interface Skipped {
  what: string;
  where: string;
}

/** Labels that only ever mean "the aims of this module/lecture". */
const STRONG_LABEL = new RegExp(
  "^(?:" +
    [
      // "Module 3 aims", "Week 2 objectives", "Today's outcomes"
      "(?:(?:module|lecture|course|session|unit|week|topic|block)\\s*\\d*|today'?s?)\\s*[:.\\-–—]?\\s*(?:aims?|objectives?|outcomes?|goals?)",
      "(?:intended\\s+)?learning\\s+(?:objectives?|outcomes?|goals?|aims?)",
      "ilos?",
      "aims?\\s*(?:and|&)\\s*(?:objectives|outcomes)",
    ].join("|") +
    ")\\b",
  "i",
);

/** Labels that are aims only when the slide reads like an aims list. "Aim: to test
 *  whether…" on an experiment slide is content, not boilerplate. */
const WEAK_LABEL = /^(?:aims?|objectives?|outcomes?)\b/i;

const BY_THE_END =
  /^by\s+the\s+end\s+of\s+(?:this|today'?s?|the)\s+(?:module|lecture|session|week|course|topic|class)/i;

/** What may follow a label for it to be a heading rather than the start of a sentence
 *  ("Objectives of antibiotic therapy" is a topic, not a list of aims). */
const HEADING_END =
  /^\s*(?:$|[:.\-–—•·*▪●○(]|(?:by|for\s+(?:this|today)|of\s+(?:this|today)|this|today|in\s+this|students?|you|on|upon|at\s+the\s+end|after\s+this|\d)\b)/i;

const ABLE_TO = /\b(?:be able to|should be able|will be able|students will|you will learn)\b/i;

const LEARNING_VERBS =
  /\b(?:understand|describe|explain|identify|outline|discuss|list|define|compare|contrast|apply|recogni[sz]e|appreciate|evaluate|analy[sz]e|summari[sz]e|demonstrate)\b/gi;

/** Whether one slide or section is module aims / learning objectives. */
export function isAimsSection(body: string): boolean {
  const head = body.trim().replace(/^[#*_>\s]+/, "").slice(0, 240);
  if (BY_THE_END.test(head)) return true;

  const strong = head.match(STRONG_LABEL);
  if (strong) {
    return HEADING_END.test(head.slice(strong[0].length)) || ABLE_TO.test(body.slice(0, 800));
  }

  const weak = head.match(WEAK_LABEL);
  if (weak && HEADING_END.test(head.slice(weak[0].length))) {
    const sample = body.slice(0, 800);
    return ABLE_TO.test(sample) || (sample.match(LEARNING_VERBS)?.length ?? 0) >= 2;
  }
  return false;
}

/** The label to show for a dropped section: "Module 3 aims", "Learning objectives". */
function labelOf(body: string): string {
  const head = body.trim().replace(/^[#*_>\s]+/, "");
  const match = head.match(STRONG_LABEL) ?? head.match(WEAK_LABEL) ?? head.match(BY_THE_END);
  const label = (match?.[0] ?? "Learning objectives").replace(/\s+/g, " ").trim();
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** "--- Slide 3 ---", "--- Page 2 ---" (our own parsers) or "Slide 3:" (exported notes). */
const SECTION_MARKER = /^(?:---\s*(Slide|Page)\s+(\d+)\s*---|(Slide)\s+(\d+)\s*[:.])/im;

/**
 * Removes aims sections from slide or page text. Text with no recognisable sections
 * falls back to Markdown headings; anything else is returned untouched.
 */
export function stripAims(text: string): { text: string; skipped: Skipped[] } {
  if (SECTION_MARKER.test(text)) return stripMarkedSections(text);
  if (/^#{1,6}\s/m.test(text)) return stripHeadingSections(text);
  return { text, skipped: [] };
}

function stripMarkedSections(text: string): { text: string; skipped: Skipped[] } {
  const marker = new RegExp(SECTION_MARKER.source, "gim");
  const starts = [...text.matchAll(marker)];
  const kept: string[] = [];
  const skipped: Skipped[] = [];

  const preamble = text.slice(0, starts[0].index).trim();
  if (preamble) kept.push(preamble);

  starts.forEach((m, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : text.length;
    const section = text.slice(m.index, end).trim();
    const body = section.slice(m[0].length);
    if (isAimsSection(body)) {
      const unit = (m[1] ?? m[3]).toLowerCase();
      skipped.push({ what: labelOf(body), where: `${unit} ${m[2] ?? m[4]}` });
    } else {
      kept.push(section);
    }
  });

  return { text: kept.join("\n\n"), skipped: mergeSkipped(skipped) };
}

function stripHeadingSections(text: string): { text: string; skipped: Skipped[] } {
  const lines = text.split("\n");
  const out: string[] = [];
  const skipped: Skipped[] = [];
  let droppingBelow = 0; // heading level being dropped; 0 = keeping

  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      if (droppingBelow && level > droppingBelow) continue;
      droppingBelow = 0;
      const body = [heading[2], ...lines.slice(i + 1, i + 12)].join("\n");
      if (isAimsSection(body)) {
        droppingBelow = level;
        skipped.push({ what: labelOf(heading[2]), where: "section" });
        continue;
      }
    }
    if (!droppingBelow) out.push(lines[i]);
  }
  return { text: out.join("\n").trim(), skipped: mergeSkipped(skipped) };
}

/** "Module aims (slide 2)", "Module aims (slide 3)" → "Module aims (slides 2, 3)". */
export function mergeSkipped(items: Skipped[]): Skipped[] {
  const byWhat = new Map<string, string[]>();
  for (const s of items) {
    const key = s.what;
    byWhat.set(key, [...(byWhat.get(key) ?? []), s.where]);
  }
  return [...byWhat].map(([what, wheres]) => {
    const unique = [...new Set(wheres)];
    const unit = unique[0].split(" ")[0];
    const sameUnit = unique.length > 1 && unique.every((w) => w.startsWith(`${unit} `));
    return {
      what,
      where: sameUnit ? `${unit}s ${unique.map((w) => w.split(" ")[1]).join(", ")}` : unique.join(", "),
    };
  });
}
