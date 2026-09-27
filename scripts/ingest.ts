/**
 * Ingest files from the command line: `npm run ingest -- <lectureId> <file>...`
 * Same path as the upload form — parse once, store text, record the material.
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { prisma } from "@/lib/db";
import { ingestFile } from "@/lib/materials";

async function main() {
  const [lectureId, ...files] = process.argv.slice(2);
  if (!lectureId || files.length === 0) {
    throw new Error("usage: npm run ingest -- <lectureId> <file>...");
  }
  const lecture = await prisma.lecture.findUniqueOrThrow({ where: { id: lectureId } });
  console.log(`ingesting into "${lecture.title}"`);

  for (const f of files) {
    const buffer = await readFile(f);
    const file = new File([new Uint8Array(buffer)], path.basename(f));
    const { materialId, warnings } = await ingestFile({ file, lectureId });
    console.log(`  ✓ ${path.basename(f)} → ${materialId}`);
    for (const w of warnings) console.warn(`    ! ${w}`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
