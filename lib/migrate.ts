import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { prisma } from "@/lib/db";
import { databaseFile, migrationsDir } from "@/lib/paths";

/**
 * Applies pending migrations without the Prisma CLI, which does not ship inside a
 * packaged app. It writes the same `_prisma_migrations` bookkeeping the CLI does, so
 * a database created here is still one `prisma migrate dev` understands later.
 *
 * This deliberately goes through the Prisma client rather than opening the file with
 * better-sqlite3: that keeps the native module a detail of the adapter, so there is
 * exactly one copy of it to rebuild for Electron instead of two that can disagree.
 */
export async function applyMigrations(): Promise<{ applied: string[]; alreadyCurrent: number }> {
  mkdirSync(path.dirname(databaseFile()), { recursive: true });

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "checksum" TEXT NOT NULL,
      "finished_at" DATETIME,
      "migration_name" TEXT NOT NULL,
      "logs" TEXT,
      "rolled_back_at" DATETIME,
      "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
      "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
    )
  `);

  const rows = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(
    `SELECT migration_name FROM "_prisma_migrations" WHERE rolled_back_at IS NULL`,
  );
  const done = new Set(rows.map((r) => r.migration_name));

  const dir = migrationsDir();
  const pending = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !done.has(e.name))
    .map((e) => e.name)
    .sort(); // timestamp-prefixed, so lexical order is chronological

  const applied: string[] = [];
  for (const name of pending) {
    const sql = readFileSync(path.join(dir, name, "migration.sql"), "utf8");
    // One transaction per migration: a failure leaves the database on the last
    // migration that fully succeeded rather than half-way through this one.
    await prisma.$transaction([
      ...statementsIn(sql).map((s) => prisma.$executeRawUnsafe(s)),
      prisma.$executeRawUnsafe(
        `INSERT INTO "_prisma_migrations"
           (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
         VALUES (?, ?, ?, current_timestamp, current_timestamp, 1)`,
        randomUUID(),
        createHash("sha256").update(sql).digest("hex"),
        name,
      ),
    ]);
    applied.push(name);
  }

  return { applied, alreadyCurrent: done.size };
}

/**
 * Splits a migration into statements. Prisma-generated DDL is plain CREATE TABLE and
 * CREATE INDEX with no semicolons inside string literals, which is what makes this
 * safe here; it is not a general-purpose SQL splitter.
 */
export function statementsIn(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}
