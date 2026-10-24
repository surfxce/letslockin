/**
 * Cards from a spreadsheet or an Anki export: comma-, tab-, semicolon- or
 * pipe-separated text, quoted the usual way, optionally with Anki's `#separator:` /
 * `#html:` / `#columns:` lines at the top. Runs in the browser, for the preview,
 * and nowhere else needs it.
 */

export const MAX_IMPORT_CARDS = 5000;

export interface CardFile {
  rows: string[][];
  delimiter: string;
  /** Column names, from the file's first row or Anki's `#columns:`. */
  header: string[] | null;
  /** True when cells are HTML (Anki's default) and are converted on import. */
  html: boolean;
  /** The column of tags, 0-based, from Anki's `#tags column:`; -1 when there is none. */
  tagsColumn: number;
}

const SEPARATORS: Record<string, string> = { tab: "\t", comma: ",", semicolon: ";", pipe: "|", space: " ", colon: ":" };
const HEADER_WORDS = /^(front|back|question|answer|term|definition|prompt|response|text|extra|notes?|tags?|deck|word|meaning|side ?[12])$/i;

/** Splits delimited text into rows, honouring quotes ("" is a quote; newlines may be quoted). */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let started = false; // anything in this row yet
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell.trim() === "") {
      quoted = true;
      cell = "";
      started = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
      started = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      if (started || cell) {
        row.push(cell);
        rows.push(row);
      }
      row = [];
      cell = "";
      started = false;
    } else {
      cell += ch;
      started = true;
    }
  }
  if (started || cell) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** The separator that splits the first lines into the same number of columns most often. */
export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#")).slice(0, 20).join("\n");
  let best = ",";
  let bestScore = -1;
  for (const d of ["\t", ",", ";", "|"]) {
    const rows = parseDelimited(sample, d).filter((r) => r.length > 1);
    if (!rows.length) continue;
    const counts = new Map<number, number>();
    for (const r of rows) counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
    const agree = Math.max(...counts.values());
    // Rows that agree on a column count, then a tab over a comma (commas turn up in sentences).
    const score = agree * 10 + (d === "\t" ? 2 : d === "," ? 1 : 0);
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

export function parseCardFile(raw: string): CardFile {
  const text = raw.replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  let delimiter: string | null = null;
  let html: boolean | null = null;
  let columns: string | null = null;
  let tagsColumn = -1;
  let skip = 0;
  // Anki's file headers come first, one per line.
  while (skip < lines.length && lines[skip].startsWith("#")) {
    const m = /^#([a-z ]+):(.*)$/i.exec(lines[skip].trim());
    if (m) {
      const key = m[1].trim().toLowerCase();
      const value = m[2].trim();
      if (key === "separator") delimiter = SEPARATORS[value.toLowerCase()] ?? (value.length === 1 ? value : null);
      else if (key === "html") html = value.toLowerCase() === "true";
      else if (key === "columns") columns = value;
      else if (key === "tags column") tagsColumn = Math.max(-1, Number(value) - 1 || -1);
    }
    skip++;
  }
  const body = lines.slice(skip).join("\n");
  const sep = delimiter ?? detectDelimiter(body);
  let header = columns ? (parseDelimited(columns, sep)[0] ?? null) : null;
  let rows = parseDelimited(body, sep).filter((r) => r.some((c) => c.trim()));
  if (!header && rows.length > 1 && rows[0].some((c) => HEADER_WORDS.test(c.trim())) && rows[0].every((c) => c.trim().length < 40)) {
    header = rows[0].map((c) => c.trim());
    rows = rows.slice(1);
  }
  if (tagsColumn < 0 && header) tagsColumn = header.findIndex((h) => /^tags?$/i.test(h.trim()));
  return {
    rows,
    delimiter: sep,
    header,
    tagsColumn,
    html: html ?? rows.slice(0, 50).some((r) => r.some((c) => /<(br|div|p|b|i|u|span|img|strong|em|sup|sub|ul|ol|li)\b[^>]*>/i.test(c))),
  };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rarr: "→", larr: "←", deg: "°", micro: "µ", times: "×", plusmn: "±" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** One cell as card Markdown. Anki's HTML keeps its line breaks, bold and italics; pictures (not in the file) are dropped. */
export function cellToMarkdown(cell: string, html: boolean): string {
  let s = cell;
  if (html) {
    s = s
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(div|p|li|h[1-6])>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, inner: string) => (inner.trim() ? `**${inner.trim()}**` : inner))
      .replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, inner: string) => (inner.trim() ? `*${inner.trim()}*` : inner))
      .replace(/<sup\b[^>]*>([\s\S]*?)<\/sup>/gi, "^$1")
      .replace(/<sub\b[^>]*>([\s\S]*?)<\/sub>/gi, "_$1")
      .replace(/<[^>]+>/g, "");
    s = decodeEntities(s);
  }
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const CLOZE = /\{\{c\d+::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;
const HAS_CLOZE = /\{\{c\d+::/;

/**
 * Rows to cards, from the chosen columns. Anki cloze text ({{c1::answer}}) becomes a
 * card asking for the hidden part, with the full sentence on the back.
 */
export function cardsFromRows(
  rows: string[][],
  front: number,
  back: number,
  html: boolean,
  tags = -1,
): Array<{ front: string; back: string; tags?: string }> {
  const cards: Array<{ front: string; back: string; tags?: string }> = [];
  for (const row of rows) {
    let f = cellToMarkdown(row[front] ?? "", html);
    let b = back >= 0 ? cellToMarkdown(row[back] ?? "", html) : "";
    if (HAS_CLOZE.test(f)) {
      const full = f.replace(CLOZE, (_, answer: string) => `**${answer}**`);
      f = f.replace(CLOZE, (_, _a: string, hint?: string) => `[${hint?.trim() || "…"}]`);
      b = [full, b].filter(Boolean).join("\n\n");
    }
    if (!f || !b) continue;
    cards.push({ front: f.slice(0, 20_000), back: b.slice(0, 20_000), ...(tags >= 0 && row[tags]?.trim() ? { tags: row[tags].trim() } : {}) });
    if (cards.length >= MAX_IMPORT_CARDS) break;
  }
  return cards;
}
