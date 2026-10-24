import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebStream } from "node:stream/web";

import { prisma } from "@/lib/db";
import { materialsDir } from "@/lib/paths";

/** The same 16-character fingerprint ingestFile gives a file, read in a stream. */
async function fingerprint(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex").slice(0, 16);
}

/**
 * Keeps a lecture recording, copied from a path or streamed in from an upload, without
 * ever holding it in memory: a filmed lecture can be a gigabyte. It is transcribed when
 * the lecture is prepared. The same recording twice is kept once.
 */
export async function storeRecording(opts: {
  lectureId: string;
  name: string;
  from: string | ReadableStream<Uint8Array>;
}): Promise<{ materialId: string; added: boolean }> {
  const dir = path.join(materialsDir(), opts.lectureId);
  await mkdir(dir, { recursive: true });
  const incoming = path.join(dir, `.incoming-${randomUUID()}`);
  try {
    if (typeof opts.from === "string") await copyFile(opts.from, incoming);
    else await pipeline(Readable.fromWeb(opts.from as WebStream<Uint8Array>), createWriteStream(incoming));
    const checksum = await fingerprint(incoming);
    const existing = await prisma.material.findFirst({ where: { lectureId: opts.lectureId, checksum }, select: { id: true } });
    if (existing) {
      await rm(incoming, { force: true });
      return { materialId: existing.id, added: false };
    }
    const safeName = opts.name.replace(/[^\w.\-]+/g, "_");
    const relPath = path.join(opts.lectureId, `${checksum}_${safeName}`);
    await rename(incoming, path.join(materialsDir(), relPath));
    const material = await prisma.material.create({
      data: { lectureId: opts.lectureId, kind: "RECORDING", path: relPath, originalName: opts.name, checksum },
    });
    return { materialId: material.id, added: true };
  } catch (err) {
    await rm(incoming, { force: true });
    throw err;
  }
}
