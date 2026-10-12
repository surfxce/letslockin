import { execFile } from "node:child_process";

import { cliConfigFromEnv } from "@/lib/llm/cli";

export interface CliStatus {
  found: boolean;
  version: string | null;
  binary: string;
}

let cache: { at: number; status: CliStatus } | null = null;

/**
 * Whether the Claude Code CLI can be run from here, so the app can recommend
 * copy-and-paste mode instead of queueing work that will never run. Cached for a
 * minute: it spawns a process, and pages ask on every render.
 */
export async function detectCli(): Promise<CliStatus> {
  if (cache && Date.now() - cache.at < 60_000) return cache.status;
  if ((process.env.LOCKIN_PROVIDER ?? "cli") === "fake") {
    return { found: true, version: "fake provider", binary: "fake" };
  }
  const { binary } = cliConfigFromEnv();
  const status = await new Promise<CliStatus>((resolve) => {
    execFile(binary, ["--version"], { timeout: 8000 }, (err, stdout) => {
      resolve(
        err
          ? { found: false, version: null, binary }
          : { found: true, version: stdout.trim().split("\n")[0] || null, binary },
      );
    });
  });
  cache = { at: Date.now(), status };
  return status;
}
