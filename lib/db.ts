import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { databaseFile } from "@/lib/paths";

// Prisma 7 requires a driver adapter; the connection string lives in .env and
// prisma.config.ts rather than in schema.prisma.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function create() {
  const url = process.env.DATABASE_URL ?? `file:${databaseFile()}`;
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
}

export const prisma = globalForPrisma.prisma ?? create();

// Next dev reloads modules on every edit; without this each reload opens a new handle.
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
