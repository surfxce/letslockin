import path from "node:path";

/**
 * Where Lockin keeps things.
 *
 * Running from the repo, everything sits beside the source. Inside a packaged .app
 * the bundle is read-only and code-signed, so writable state has to live in the
 * user's Application Support directory instead; Electron sets these before it starts
 * the server or the worker. Nothing else in the app should join paths to cwd.
 */
export function dataDir(): string {
  return process.env.LOCKIN_DATA_DIR ?? process.cwd();
}

/** Uploaded transcripts, slides and figures. The database stores paths into here. */
export function materialsDir(): string {
  return path.join(dataDir(), "materials");
}

/** Versioned prompt files — read-only, so they ship inside the bundle's resources. */
export function promptsDir(): string {
  return process.env.LOCKIN_PROMPTS_DIR ?? path.join(process.cwd(), "prompts");
}

/** Prisma migration SQL, applied on launch. Read-only, ships with the bundle. */
export function migrationsDir(): string {
  return process.env.LOCKIN_MIGRATIONS_DIR ?? path.join(process.cwd(), "prisma", "migrations");
}

export function databaseFile(): string {
  return path.join(dataDir(), "lockin.db");
}
