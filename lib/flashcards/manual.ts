import { createHash, randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";

import { prisma } from "@/lib/db";
import { MAX_IMPORT_CARDS } from "@/lib/flashcards/csv";
import { MEDIA_SCHEME, type AnkiPackage } from "@/lib/flashcards/anki";
import { CARD_IMAGE_NAME, CARD_IMAGE_PATH, cardImagesDir, saveCardImage } from "@/lib/flashcards/images";
import { storeTags } from "@/lib/flashcards/tags";

/** Cards the student makes: written by hand, imported from a file, or cover-up cards from a picture. */
export type CardOrigin = "manual" | "csv" | "occlusion";

export const MAX_CARD_TEXT = 20_000;

/** Every card picture a card's Markdown shows. */
export function cardImageNames(md: string): string[] {
  const names: string[] = [];
  for (const m of md.matchAll(/\/api\/ak\/images\/([a-f0-9]{24}\.(?:png|jpg|webp|gif))/g)) names.push(m[1]);
  return names;
}

function clean(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim().slice(0, MAX_CARD_TEXT);
}

export async function saveCard(lectureId: string, card: { id?: string; front: string; back: string; tags?: string }) {
  const front = clean(card.front);
  const back = clean(card.back);
  const tags = card.tags === undefined ? undefined : storeTags(card.tags);
  if (!front) throw new Error("Write the front of the card.");
  if (!back) throw new Error("Write the back of the card.");
  if (card.id) {
    const before = await prisma.flashcard.findFirst({ where: { id: card.id, lectureId }, select: { front: true, back: true } });
    if (!before) throw new Error("That card isn't here any more.");
    // Rewording a card keeps its schedule: it is still the same thing to remember.
    await prisma.flashcard.update({ where: { id: card.id }, data: { front, back, ...(tags === undefined ? {} : { tags }) } });
    await forgetImages(cardImageNames(before.front + before.back));
    return card.id;
  }
  await prisma.lecture.findUniqueOrThrow({ where: { id: lectureId }, select: { id: true } });
  const created = await prisma.flashcard.create({
    data: { lectureId, front, back, tags: tags ?? "", origin: "manual", sourceKey: `manual:${randomBytes(9).toString("hex")}` },
  });
  return created.id;
}

/** Imports cards, skipping any this lecture already has word for word. */
export async function importCards(lectureId: string, cards: Array<{ front: string; back: string; tags?: string }>) {
  await prisma.lecture.findUniqueOrThrow({ where: { id: lectureId }, select: { id: true } });
  const rows = cards
    .slice(0, MAX_IMPORT_CARDS)
    .map((c) => ({ front: clean(String(c.front ?? "")), back: clean(String(c.back ?? "")), tags: storeTags(String(c.tags ?? "")) }))
    .filter((c) => c.front && c.back)
    .map((c) => ({ ...c, sourceKey: `csv:${createHash("sha1").update(`${c.front}\u0000${c.back}`).digest("hex")}` }));
  const keys = [...new Set(rows.map((r) => r.sourceKey))];
  const existing = new Set(
    (await prisma.flashcard.findMany({ where: { lectureId, sourceKey: { in: keys } }, select: { sourceKey: true } })).map((c) => c.sourceKey),
  );
  const fresh = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!existing.has(r.sourceKey) && !fresh.has(r.sourceKey)) fresh.set(r.sourceKey, r);
  // Spread a little in time so they come up in the file's order, as new cards do by creation.
  const start = Date.now();
  await prisma.flashcard.createMany({
    data: [...fresh.values()].map((r, i) => ({ lectureId, origin: "csv", createdAt: new Date(start + i), ...r })),
  });
  return { added: fresh.size, skipped: cards.length - fresh.size };
}

/**
 * Cover-up cards: one per box, each a pair of pictures already drawn in the browser —
 * the front with the box covered, the back with it shown.
 */
export async function saveOcclusionCards(
  lectureId: string,
  input: { prompt: string; extra: string; cards: Array<{ front: string; back: string }> },
) {
  await prisma.lecture.findUniqueOrThrow({ where: { id: lectureId }, select: { id: true } });
  if (!input.cards.length) throw new Error("Draw at least one cover-up box.");
  if (input.cards.length > 200) throw new Error("That's more boxes than one picture can use (200 at most).");
  const picture = (name: string) => {
    if (!CARD_IMAGE_NAME.test(name)) throw new Error("A cover-up picture went missing. Try again.");
    return CARD_IMAGE_PATH + name;
  };
  const group = randomBytes(6).toString("hex");
  const prompt = clean(input.prompt).slice(0, 2000) || "What's under the box?";
  const extra = clean(input.extra).slice(0, 5000);
  const n = input.cards.length;
  const start = Date.now();
  await prisma.flashcard.createMany({
    data: input.cards.map((c, i) => ({
      lectureId,
      origin: "occlusion",
      sourceKey: `occlusion:${group}:${i}`,
      createdAt: new Date(start + i),
      front: `${prompt}${n > 1 ? ` *(${i + 1} of ${n})*` : ""}\n\n![Covered](${picture(c.front)})`,
      back: `![Uncovered](${picture(c.back)})${extra ? `\n\n${extra}` : ""}`,
    })),
  });
  return { added: n, group };
}

/** Deletes cards of a lecture, and the pictures no other card shows. */
export async function deleteCards(lectureId: string, ids: string[]) {
  const cards = await prisma.flashcard.findMany({ where: { lectureId, id: { in: ids } }, select: { id: true, front: true, back: true } });
  if (!cards.length) return 0;
  await prisma.flashcard.deleteMany({ where: { id: { in: cards.map((c) => c.id) } } });
  await forgetImages(cards.flatMap((c) => cardImageNames(c.front + c.back)));
  return cards.length;
}

/** Removes card pictures that no card shows any more. */
export async function forgetImages(names: string[]) {
  for (const name of new Set(names)) {
    if (!CARD_IMAGE_NAME.test(name)) continue;
    const used = await prisma.flashcard.count({ where: { OR: [{ front: { contains: name } }, { back: { contains: name } }] } });
    if (!used) await unlink(path.join(cardImagesDir(), name)).catch(() => undefined);
  }
}

/**
 * Cards from an Anki package, into one lecture's deck. Notes already imported are
 * skipped; only the pictures new cards show are saved.
 */
export async function importAnki(lectureId: string, pkg: AnkiPackage) {
  await prisma.lecture.findUniqueOrThrow({ where: { id: lectureId }, select: { id: true } });
  const rows = pkg.cards.slice(0, MAX_IMPORT_CARDS * 4).map((c) => ({ ...c, sourceKey: `anki:${c.key}` }));
  const existing = new Set<string>();
  for (let i = 0; i < rows.length; i += 500) {
    const keys = rows.slice(i, i + 500).map((r) => r.sourceKey);
    for (const c of await prisma.flashcard.findMany({ where: { lectureId, sourceKey: { in: keys } }, select: { sourceKey: true } })) existing.add(c.sourceKey);
  }
  const fresh = rows.filter((r) => !existing.has(r.sourceKey));

  // Pictures: saved once each, whatever number of cards show them.
  const urls = new Map<string, string | null>();
  let pictures = 0;
  const placeholder = new RegExp(`!\\[([^\\]]*)\\]\\(${MEDIA_SCHEME}([^)\\s]+)\\)`, "g");
  for (const r of fresh) {
    for (const m of `${r.front}\n${r.back}`.matchAll(placeholder)) {
      const name = decodeURIComponent(m[2]);
      if (urls.has(name)) continue;
      const bytes = await pkg.media(name);
      let url: string | null = null;
      if (bytes) {
        try {
          url = (await saveCardImage(bytes)).url;
          pictures++;
        } catch {
          // Not a picture Lockin shows (an SVG, say): left out.
        }
      }
      urls.set(name, url);
    }
  }
  const withPictures = (md: string) =>
    clean(md.replace(placeholder, (_, alt: string, enc: string) => {
      const url = urls.get(decodeURIComponent(enc));
      return url ? `![${alt}](${url})` : "";
    }));

  const start = Date.now();
  const data = fresh
    .map((r, i) => ({
      lectureId,
      origin: "anki",
      sourceKey: r.sourceKey,
      front: withPictures(r.front),
      back: withPictures(r.back),
      tags: storeTags([...r.tags, r.deck.replace(/\s+/g, "_")]),
      createdAt: new Date(start + i),
    }))
    .filter((c) => c.front && c.back);
  for (let i = 0; i < data.length; i += 500) await prisma.flashcard.createMany({ data: data.slice(i, i + 500) });
  return { added: data.length, skipped: rows.length - data.length + pkg.skipped, pictures, decks: pkg.decks };
}
