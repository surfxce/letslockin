import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { prisma } from "@/lib/db";
import { checksum, guessKind, parseMaterial } from "@/lib/parse";
import { materialsDir } from "@/lib/paths";
import type { MaterialKind } from "@/lib/types";



export interface IngestResult {
  materialId: string;
  warnings: string[];
}

/**
 * Files live on disk under materials/<lectureId>/; the database stores the path
 * and the extracted text, never the blob.
 */
export async function ingestFile(opts: {
  file: File;
  lectureId?: string;
  courseId?: string;
  kind?: MaterialKind;
}): Promise<IngestResult> {
  const buffer = Buffer.from(await opts.file.arrayBuffer());
  const parsed = await parseMaterial(opts.file.name, buffer);
  const kind = opts.kind ?? guessKind(opts.file.name, parsed.text);

  const scope = opts.lectureId ?? opts.courseId ?? "loose";
  const safeName = opts.file.name.replace(/[^\w.\-]+/g, "_");
  const relPath = path.join(scope, `${checksum(buffer)}_${safeName}`);
  await mkdir(path.join(materialsDir(), scope), { recursive: true });
  await writeFile(path.join(materialsDir(), relPath), buffer);

  const material = await prisma.material.create({
    data: {
      lectureId: opts.lectureId ?? null,
      courseId: opts.courseId ?? null,
      kind,
      path: relPath,
      originalName: opts.file.name,
      extractedText: parsed.text,
      checksum: checksum(buffer),
    },
  });

  return { materialId: material.id, warnings: parsed.warnings };
}

export async function enqueue(kind: string, payload: Record<string, unknown>) {
  return prisma.job.create({ data: { kind, payload: JSON.stringify(payload) } });
}
