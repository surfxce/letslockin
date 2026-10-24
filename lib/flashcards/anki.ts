import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import Database from "better-sqlite3";
import JSZip from "jszip";

import { cellToMarkdown } from "@/lib/flashcards/csv";

/**
 * Reads an Anki package (.apkg): its notes as cards, their tags and decks, and the
 * pictures they show. Handles the older format (collection.anki2/.anki21, a JSON media
 * list) and the newer one (collection.anki21b, zstd-compressed, a protobuf media list).
 * Scheduling isn't carried over: the cards come in new.
 */

export interface AnkiCard {
  /** Stable across re-imports: the note's guid, plus the cloze number for cloze notes. */
  key: string;
  front: string;
  back: string;
  tags: string[];
  deck: string;
}

export interface AnkiPackage {
  cards: AnkiCard[];
  decks: Array<{ name: string; cards: number }>;
  /** Notes that couldn't become cards: Anki's own image occlusion, or with nothing on one side. */
  skipped: number;
  /** A media file's bytes by its name, when the package has it. */
  media: (name: string) => Promise<Buffer | null>;
}

export const MEDIA_SCHEME = "anki-media:";

const isZstd = (b: Uint8Array) => b.length > 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd;
/** In Node 22.15+ and Electron's Node; the type definitions here predate it. */
const zstdDecompressSync = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
function unzstd(b: Buffer): Buffer {
  if (!isZstd(b)) return b;
  if (!zstdDecompressSync) throw new Error("This Anki package needs a newer Lockin to open.");
  return zstdDecompressSync(b);
}

function varint(buf: Uint8Array, pos: number): [number, number] {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error("bad varint");
    const byte = buf[pos++];
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return [value, pos];
    shift += 7;
  }
}

/** Fields of one protobuf message: [field number, wire type, bytes or number]. */
function protoFields(buf: Uint8Array): Array<[number, number, Uint8Array | number]> {
  const out: Array<[number, number, Uint8Array | number]> = [];
  let pos = 0;
  while (pos < buf.length) {
    const [tag, p1] = varint(buf, pos);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    pos = p1;
    if (wire === 0) {
      const [v, p2] = varint(buf, pos);
      out.push([field, wire, v]);
      pos = p2;
    } else if (wire === 2) {
      const [len, p2] = varint(buf, pos);
      out.push([field, wire, buf.subarray(p2, p2 + len)]);
      pos = p2 + len;
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      throw new Error("bad protobuf");
    }
  }
  return out;
}

/** The media list: which zip entry holds which file name. */
export function mediaIndex(raw: Buffer): Map<string, string> {
  const index = new Map<string, string>();
  try {
    const json = JSON.parse(raw.toString("utf8")) as Record<string, string>;
    for (const [entry, name] of Object.entries(json)) if (typeof name === "string") index.set(name, entry);
    return index;
  } catch {
    // The newer format: MediaEntries { repeated MediaEntry entries = 1 }, MediaEntry { string name = 1; … uint32 legacy_zip_filename = 255 }.
  }
  try {
    const entries = protoFields(unzstd(raw)).filter(([f, w]) => f === 1 && w === 2);
    entries.forEach(([, , body], i) => {
      let name = "";
      let entry = String(i);
      for (const [f, w, v] of protoFields(body as Uint8Array)) {
        if (f === 1 && w === 2) name = Buffer.from(v as Uint8Array).toString("utf8");
        if (f === 255 && w === 0) entry = String(v);
      }
      if (name) index.set(name, entry);
    });
  } catch {
    // No readable media list: the cards come in without pictures.
  }
  return index;
}

const CLOZE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

/** One card per cloze number: that one hidden, the others shown. */
export function clozeCards(text: string, extra: string): Array<{ n: number; front: string; back: string }> {
  const numbers = [...new Set([...text.matchAll(CLOZE)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  return numbers.map((n) => ({
    n,
    front: text.replace(CLOZE, (_, k: string, answer: string, hint?: string) => (Number(k) === n ? `[${hint?.trim() || "…"}]` : answer)),
    back: [text.replace(CLOZE, (_, k: string, answer: string) => (Number(k) === n ? `**${answer}**` : answer)), extra].filter((s) => s.trim()).join("\n\n"),
  }));
}

/** A field's HTML as card Markdown, its pictures kept as `anki-media:<encoded name>` links and its sounds dropped. */
export function fieldToMarkdown(html: string): { text: string; images: string[] } {
  const images: string[] = [];
  const withPictures = html
    .replace(/\[sound:[^\]]*\]/g, "")
    .replace(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi, (_, dq?: string, sq?: string, uq?: string) => {
      const name = (dq ?? sq ?? uq ?? "").trim();
      if (!name || /^(?:https?:|data:)/i.test(name)) return "";
      images.push(name);
      return `\n\n![Picture](${MEDIA_SCHEME}${encodeURIComponent(name)})\n\n`;
    });
  return { text: cellToMarkdown(withPictures, true), images };
}

interface NoteType {
  name: string;
  cloze: boolean;
}

export async function readApkg(bytes: Uint8Array): Promise<AnkiPackage> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error("That isn't an Anki package (.apkg).");
  }
  const entry = zip.file("collection.anki21b") ?? zip.file("collection.anki21") ?? zip.file("collection.anki2");
  if (!entry) throw new Error("That Anki package has no collection in it.");
  const collection = unzstd(Buffer.from(await entry.async("uint8array")));
  const mediaFile = zip.file("media");
  const index = mediaFile ? mediaIndex(Buffer.from(await mediaFile.async("uint8array"))) : new Map<string, string>();

  const dir = await mkdtemp(path.join(tmpdir(), "lockin-apkg-"));
  const file = path.join(dir, "collection.db");
  await writeFile(file, collection);
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const tables = new Set((db.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>).map((t) => t.name));
    const types = new Map<number, NoteType>();
    const decks = new Map<number, string>();
    if (tables.has("notetypes")) {
      for (const t of db.prepare("select id, name from notetypes").all() as Array<{ id: number; name: string }>) {
        types.set(Number(t.id), { name: t.name, cloze: /cloze/i.test(t.name) });
      }
      for (const d of db.prepare("select id, name from decks").all() as Array<{ id: number; name: string }>) {
        decks.set(Number(d.id), d.name.replace(/\x1f/g, "::"));
      }
    } else {
      const col = db.prepare("select models, decks from col").get() as { models: string; decks: string } | undefined;
      const models = JSON.parse(col?.models || "{}") as Record<string, { name: string; type: number }>;
      for (const [id, m] of Object.entries(models)) types.set(Number(id), { name: m.name, cloze: m.type === 1 });
      const deckJson = JSON.parse(col?.decks || "{}") as Record<string, { name: string }>;
      for (const [id, d] of Object.entries(deckJson)) decks.set(Number(id), d.name);
    }
    const deckOf = new Map<number, string>();
    for (const c of db.prepare("select nid, did from cards order by nid, ord").all() as Array<{ nid: number; did: number }>) {
      if (!deckOf.has(Number(c.nid))) deckOf.set(Number(c.nid), decks.get(Number(c.did)) ?? "Default");
    }

    const cards: AnkiCard[] = [];
    let skipped = 0;
    const notes = db.prepare("select id, guid, mid, flds, tags from notes order by id").all() as Array<{
      id: number;
      guid: string;
      mid: number;
      flds: string;
      tags: string;
    }>;
    for (const note of notes) {
      const type = types.get(Number(note.mid)) ?? { name: "", cloze: false };
      const fields = note.flds.split("\x1f");
      if (/image occlusion/i.test(type.name) || fields.some((f) => f.includes("image-occlusion:"))) {
        skipped++;
        continue;
      }
      const deck = deckOf.get(Number(note.id)) ?? "Default";
      const tags = note.tags.split(/\s+/).filter(Boolean);
      const md = fields.map(fieldToMarkdown);
      if (type.cloze || /\{\{c\d+::/.test(fields[0] ?? "")) {
        const made = clozeCards(md[0]?.text ?? "", md.slice(1).map((f) => f.text).filter(Boolean).join("\n\n"));
        if (!made.length) skipped++;
        for (const c of made) {
          cards.push({ key: `${note.guid}:c${c.n}`, front: c.front, back: c.back, tags, deck });
        }
        continue;
      }
      const front = md[0]?.text ?? "";
      const back = md.slice(1).map((f) => f.text).filter(Boolean).join("\n\n");
      if (!front || !back) {
        skipped++;
        continue;
      }
      cards.push({ key: note.guid, front, back, tags, deck });
    }

    const perDeck = new Map<string, number>();
    for (const c of cards) perDeck.set(c.deck, (perDeck.get(c.deck) ?? 0) + 1);
    return {
      cards,
      decks: [...perDeck].map(([name, n]) => ({ name, cards: n })).sort((a, b) => b.cards - a.cards),
      skipped,
      media: async (name: string) => {
        const zipName = index.get(name);
        const f = zipName === undefined ? null : zip.file(zipName);
        return f ? unzstd(Buffer.from(await f.async("uint8array"))) : null;
      },
    };
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}
