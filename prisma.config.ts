import "dotenv/config"; // Prisma 7 no longer loads .env on its own
import path from "node:path";
import { defineConfig } from "prisma/config";

import { databaseFile } from "./lib/paths";

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: { path: path.join("prisma", "migrations") },
  // Without a .env, the file the app itself falls back to — and `prisma generate`,
  // which never opens the database, still runs (it is the postinstall step).
  datasource: { url: process.env.DATABASE_URL ?? `file:${databaseFile()}` },
});
