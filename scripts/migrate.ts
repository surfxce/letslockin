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
  const where = process.env.DATABASE_URL ?? databaseFile();
  console.log(
    applied.length === 0
      ? `database current at ${where} (${alreadyCurrent} migrations)`
      : `applied ${applied.length} migration(s) to ${where}: ${applied.join(", ")}`,
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
