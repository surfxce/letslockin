import { execFile } from "node:child_process";

import { cliConfigFromEnv } from "@/lib/llm/cli";

export interface CliStatus {
  found: boolean;
  version: string | null;
  binary: string;
}

const cache = new Map<string, { at: number; status: CliStatus }>();

/** Whether a command-line tool can be run from here, and its version. Cached for a
 *  minute: it starts a process, and pages ask on every render. */
async function detect(binary: string): Promise<CliStatus> {
  const hit = cache.get(binary);
  if (hit && Date.now() - hit.at < 60_000) return hit.status;
  const status = await new Promise<CliStatus>((resolve) => {
    execFile(binary, ["--version"], { timeout: 8000 }, (err, stdout) => {
      resolve(err ? { found: false, version: null, binary } : { found: true, version: stdout.trim().split("\n")[0] || null, binary });
    });
  });
  cache.set(binary, { at: Date.now(), status });
  return status;
}

const fake = (): CliStatus | null =>
  (process.env.LOCKIN_PROVIDER ?? "cli") === "fake" ? { found: true, version: "fake provider", binary: "fake" } : null;

/**
 * Whether the Claude Code CLI can be run from here, so the app can recommend
 * copy-and-paste mode instead of queueing work that will never run.
 */
export async function detectCli(): Promise<CliStatus> {
  return fake() ?? detect(cliConfigFromEnv().binary);
}

/** ChatGPT's Codex CLI. */
export async function detectCodex(): Promise<CliStatus> {
  return fake() ?? detect(process.env.LOCKIN_CODEX_BIN ?? "codex");
}

/** Google's Antigravity CLI, or the Gemini CLI it replaced when that is all there is. */
export async function detectAntigravity(): Promise<CliStatus> {
  const forced = process.env.LOCKIN_AGY_BIN;
  if (forced) return fake() ?? detect(forced);
  const agy = await detect("agy");
  return fake() ?? (agy.found ? agy : (await detect("gemini")).found ? detect("gemini") : agy);
}
