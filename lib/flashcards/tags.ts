/** Card tags, Anki-style: single words (no spaces), stored padded as " a b " so a tag can be matched whole. */

export const MAX_TAGS = 20;

export function cleanTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#/, "")
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}_\-:/.]/gu, "")
    .slice(0, 60);
}

/** From what someone typed ("renal, drugs #week3") or a list, to the stored form. */
export function storeTags(input: string | string[]): string {
  const parts = (Array.isArray(input) ? input : input.split(/[\s,]+/)).map(cleanTag).filter(Boolean);
  const seen = new Map<string, string>();
  for (const t of parts) if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  const tags = [...seen.values()].slice(0, MAX_TAGS);
  return tags.length ? ` ${tags.join(" ")} ` : "";
}

export function tagList(stored: string): string[] {
  return stored.split(" ").filter(Boolean);
}

/** The stored form with some tags added. */
export function addTags(stored: string, more: string[]): string {
  return storeTags([...tagList(stored), ...more]);
}

export function removeTag(stored: string, tag: string): string {
  return storeTags(tagList(stored).filter((t) => t.toLowerCase() !== tag.toLowerCase()));
}
