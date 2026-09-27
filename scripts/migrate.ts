/**
 * Brings the database up to date, then exits. Electron runs this before it starts
 * the server, so a first launch on a machine with no database still works.
 */
import "dotenv/config";
import { applyMigrations } from "@/lib/migrate";
import { databaseFile } from "@/lib/paths";
import { prisma } from "@/lib/db";

async function main() {
  const { applied, alreadyCurrent } = await applyMigrations();
  console.log(
    applied.length === 0
      ? `database current at ${databaseFile()} (${alreadyCurrent} migrations)`
      : `applied ${applied.length} migration(s): ${applied.join(", ")}`,
  );
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
