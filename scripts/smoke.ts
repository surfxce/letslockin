/**
 * Phase 0 end-to-end check: prompt file -> Claude Code CLI -> JSON -> Zod -> database.
 * Run with `npm run smoke`. Costs one real model call.
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { prisma } from "@/lib/db";
import { getProvider } from "@/lib/llm";

async function main() {
  const transcript = await readFile(
    path.join(process.cwd(), "scripts/fixtures/lecture-transcript.txt"),
    "utf8",
  );

  const courses = await prisma.course.count();
  console.log(`database reachable (${courses} course${courses === 1 ? "" : "s"})`);

  const provider = getProvider();
  console.log(`provider: ${provider.name}`);
  console.log("digesting the fixture lecture…");

  const started = Date.now();
  const digest = await provider.digest({
    currentTitle: "lecture-transcript",
    titleIsPlaceholder: true,
    durationHours: 1,
    transcript,
    alreadySkipped: [],
    existingConcepts: [],
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\n--- ${digest.title} (${elapsed}s) ---\n`);
  console.log(digest.summaryMd);
  console.log(`\n--- ${digest.concepts.length} concepts, ${digest.skipped.length} sections set aside ---`);
  for (const c of digest.concepts) console.log(`  ${c.name}: ${c.definition}`);
  for (const s of digest.skipped) console.log(`  skipped ${s.what} (${s.where})`);
  console.log("\nschema-valid. pipeline works.");
}

main()
  .catch((err) => {
    console.error("\nsmoke test failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
