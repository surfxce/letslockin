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
  console.log("summarising the fixture lecture…");

  const started = Date.now();
  const summary = await provider.summarise({
    lectureTitle: "Gene regulation in prokaryotes: the lac operon",
    durationHours: 1,
    transcript,
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\n--- summary (${elapsed}s) ---\n`);
  console.log(summary.summaryMd);
  console.log(`\n--- figures flagged: ${summary.figures.length} ---`);
  for (const f of summary.figures) console.log(`  [${f.sourceRef}] ${f.description}`);
  console.log("\nschema-valid. phase 0 pipeline works.");
}

main()
  .catch((err) => {
    console.error("\nsmoke test failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
