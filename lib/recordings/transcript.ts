/**
 * Transcripts made from recordings, in the same shape as one from a caption file:
 * paragraphs that each start with a time, "[12:34]" or "[1:02:03]".
 */

export interface Segment {
  /** Seconds from the start of the recording. */
  start: number;
  text: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A time as transcripts write it: "[07:05]", "[1:02:03]". */
export function stamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `[${h}:${pad(m)}:${pad(s % 60)}]` : `[${pad(m)}:${pad(s % 60)}]`;
}

/**
 * Lines of "[mm:ss] what was said" from an AI that listened to one part of a recording,
 * with times moved on by where the part starts. A line without a time continues the
 * one before it; the AI's own preamble or code fences are dropped.
 */
export function parseTimedLines(text: string, offset = 0): Segment[] {
  const out: Segment[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || /^```/.test(line)) continue;
    const m = line.match(/^\**\[?\(?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,]\d+)?\)?\]?\**\s*[-–—:]?\s*(.*)$/);
    if (m) {
      const seconds = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      const said = m[4].trim();
      if (said) out.push({ start: offset + seconds, text: said });
      continue;
    }
    // Before the first time, it's the AI talking about the transcript, not the lecture.
    if (out.length) out[out.length - 1].text += ` ${line}`;
  }
  return out;
}

/** Segments as paragraphs of about `every` seconds, each with its starting time. */
export function formatTranscript(segments: Segment[], every = 40): string {
  const paragraphs: string[] = [];
  let start = -Infinity;
  let words: string[] = [];
  const flush = () => {
    const text = words.join(" ").replace(/\s+/g, " ").trim();
    if (text) paragraphs.push(`${stamp(start)} ${text}`);
    words = [];
  };
  for (const s of [...segments].sort((a, b) => a.start - b.start)) {
    if (s.start - start >= every) {
      flush();
      start = s.start;
    }
    words.push(s.text.trim());
  }
  flush();
  return paragraphs.join("\n\n");
}

const COMMON = new Set(
  `about above after again against because before being below between could doing during further having other ought
  their theirs there these those through under until where which while would yourself yourselves should within without
  lecture slide slides today learning outcomes objectives module university introduction summary questions question
  example examples important different following another however therefore something number figure table also level
  using based first second third people point points thing things which whose years really right going since every`.split(/\s+/),
);

/**
 * Words a recording is likely to contain that a speech model could mishear: the slides'
 * technical terms — long words, ones with capitals or digits inside, abbreviations —
 * most used first.
 */
export function vocabulary(texts: string[], limit = 300): string[] {
  const counts = new Map<string, { word: string; n: number }>();
  for (const text of texts) {
    for (const word of text.match(/[A-Za-z][A-Za-z0-9'-]*[A-Za-z0-9]/g) ?? []) {
      const lower = word.toLowerCase();
      if (COMMON.has(lower)) continue;
      const technical =
        word.length >= 8 || /[A-Z]{2,}/.test(word) || /\d/.test(word) || /[a-z][A-Z]/.test(word) || /^[A-Z][a-z]+-[A-Za-z]/.test(word);
      if (!technical || word.length > 40) continue;
      const seen = counts.get(lower);
      if (seen) seen.n++;
      else counts.set(lower, { word, n: 1 });
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n || a.word.localeCompare(b.word))
    .slice(0, limit)
    .map((c) => c.word);
}

export interface Fix {
  heard: string;
  correct: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Corrections to misheard words, applied as whole words or phrases wherever they occur.
 * A fix that would change nothing, or that is far longer than what it replaces, is
 * skipped: a correction, not a rewrite.
 */
export function applyFixes(text: string, fixes: Fix[]): { text: string; applied: number } {
  let out = text;
  let applied = 0;
  // Longer phrases first, so "glow Merula" is fixed before "glow" alone could be.
  for (const fix of [...fixes].sort((a, b) => b.heard.length - a.heard.length)) {
    const heard = fix.heard.trim();
    const correct = fix.correct.trim();
    if (!heard || !correct || heard === correct || heard.length > 80 || correct.length > heard.length * 3 + 20) continue;
    if (/\d:\d|^\[|\]$/.test(heard)) continue; // never a time
    const pattern = new RegExp(`(?<![A-Za-z0-9])${escape(heard).replace(/\s+/g, "\\s+")}(?![A-Za-z0-9])`, "gi");
    let changed = false;
    out = out.replace(pattern, (match) => {
      changed = true;
      // Keep a capital at the start of a sentence.
      return /^[A-Z]/.test(match) && /^[a-z]/.test(correct) ? correct[0].toUpperCase() + correct.slice(1) : correct;
    });
    if (changed) applied++;
  }
  return { text: out, applied };
}

/** A long transcript in pieces of about `size` characters, split between paragraphs. */
export function pieces(text: string, size: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}/)) {
    if (current && current.length + paragraph.length > size) {
      out.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) out.push(current);
  return out;
}
