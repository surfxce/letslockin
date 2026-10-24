import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import Database from "better-sqlite3";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { clozeCards, fieldToMarkdown, mediaIndex, MEDIA_SCHEME, readApkg } from "@/lib/flashcards/anki";

const zstd = (zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer }).zstdCompressSync;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** A collection database, in the old (JSON in `col`) or new (notetypes/decks tables) layout. */
function collection(layout: "old" | "new"): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), "apkg-test-"));
  const file = path.join(dir, "c.db");
  const db = new Database(file);
  db.exec("create table notes (id integer primary key, guid text, mid integer, flds text, tags text)");
  db.exec("create table cards (id integer primary key, nid integer, did integer, ord integer)");
  if (layout === "old") {
    db.exec("create table col (models text, decks text)");
    db.prepare("insert into col values (?, ?)").run(
      JSON.stringify({ "1": { name: "Basic", type: 0 }, "2": { name: "Cloze", type: 1 } }),
      JSON.stringify({ "10": { name: "Renal::Glomerulus" } }),
    );
  } else {
    db.exec("create table notetypes (id integer primary key, name text)");
    db.exec("create table decks (id integer primary key, name text)");
    db.prepare("insert into notetypes values (?, ?), (?, ?), (?, ?)").run(1, "Basic", 2, "Cloze", 3, "Image Occlusion");
    db.prepare("insert into decks values (?, ?)").run(10, "Renal\x1fGlomerulus");
  }
  const note = db.prepare("insert into notes values (?, ?, ?, ?, ?)");
  note.run(100, "g-basic", 1, `What filters blood?<br><img src="glom erulus.png">\x1fThe <b>glomerulus</b>[sound:a.mp3]`, " renal anatomy ");
  note.run(101, "g-cloze", 2, "{{c1::IgA}} deposits in the {{c2::mesangium::where}}\x1fExtra note", "");
  note.run(102, "g-empty", 1, "Front only\x1f", "");
  if (layout === "new") note.run(103, "g-io", 3, "{{c1::image-occlusion:rect:left=.1:top=.1}}\x1f<img src=\"x.png\">", "");
  const card = db.prepare("insert into cards values (?, ?, ?, ?)");
  card.run(1, 100, 10, 0);
  card.run(2, 101, 10, 0);
  card.run(3, 101, 10, 1);
  card.run(4, 102, 10, 0);
  db.close();
  const bytes = readFileSync(file);
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}

/** MediaEntries { repeated MediaEntry entries = 1 { string name = 1 } }. */
function protoMedia(names: string[]): Buffer {
  const parts = names.map((n) => {
    const name = Buffer.from(n);
    const entry = Buffer.concat([Buffer.from([0x0a, name.length]), name]);
    return Buffer.concat([Buffer.from([0x0a, entry.length]), entry]);
  });
  return Buffer.concat(parts);
}

async function apkg(layout: "old" | "new"): Promise<Uint8Array> {
  const zip = new JSZip();
  if (layout === "old") {
    zip.file("collection.anki2", collection("old"));
    zip.file("media", JSON.stringify({ "0": "glom erulus.png" }));
    zip.file("0", PNG);
  } else {
    zip.file("collection.anki2", collection("old")); // the "please update Anki" stand-in, ignored
    zip.file("collection.anki21b", zstd(collection("new")));
    zip.file("media", zstd(protoMedia(["glom erulus.png"])));
    zip.file("0", zstd(PNG));
  }
  return zip.generateAsync({ type: "uint8array" });
}

describe("readApkg", () => {
  for (const layout of ["old", "new"] as const) {
    it(`reads a ${layout}-format package`, async () => {
      const pkg = await readApkg(await apkg(layout));
      expect(pkg.cards.map((c) => c.key)).toEqual(["g-basic", "g-cloze:c1", "g-cloze:c2"]);
      const basic = pkg.cards[0];
      expect(basic.front).toBe(`What filters blood?\n\n![Picture](${MEDIA_SCHEME}glom%20erulus.png)`);
      expect(basic.back).toBe("The **glomerulus**");
      expect(basic.tags).toEqual(["renal", "anatomy"]);
      expect(basic.deck).toBe("Renal::Glomerulus");
      expect(pkg.cards[2].front).toBe("IgA deposits in the [where]");
      expect(pkg.skipped).toBe(layout === "new" ? 2 : 1);
      expect(pkg.decks).toEqual([{ name: "Renal::Glomerulus", cards: 3 }]);
      expect((await pkg.media("glom erulus.png"))?.equals(PNG)).toBe(true);
      expect(await pkg.media("missing.png")).toBeNull();
    });
  }

  it("refuses something that isn't a package", async () => {
    await expect(readApkg(new Uint8Array([1, 2, 3]))).rejects.toThrow(/isn't an Anki package/);
  });
});

describe("helpers", () => {
  it("makes one card per cloze number", () => {
    expect(clozeCards("{{c1::A}} and {{c2::B}} and {{c1::C}}", "")).toEqual([
      { n: 1, front: "[…] and B and […]", back: "**A** and B and **C**" },
      { n: 2, front: "A and […] and C", back: "A and **B** and C" },
    ]);
  });
  it("keeps pictures and drops sounds", () => {
    expect(fieldToMarkdown('<div>x</div><img src="a.jpg"><img src="https://e.com/b.png">[sound:s.mp3]')).toEqual({
      text: `x\n\n![Picture](${MEDIA_SCHEME}a.jpg)`,
      images: ["a.jpg"],
    });
  });
  it("reads both media lists", () => {
    expect([...mediaIndex(Buffer.from('{"3":"x.png"}'))]).toEqual([["x.png", "3"]]);
    expect([...mediaIndex(protoMedia(["a.png", "b.png"]))]).toEqual([["a.png", "0"], ["b.png", "1"]]);
  });
});
