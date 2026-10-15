import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

import { CloudError } from "@/lib/llm/base";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Runs an AI command-line tool with the prompt on stdin (a transcript is far past the
 * longest command line allowed), from a neutral folder so it picks up no project's own
 * instructions, and gives up after `timeoutMs` — some tools wait for a sign-in forever.
 */
export function runTool(
  binary: string,
  args: string[],
  input: string,
  opts: { timeoutMs: number; what: string; install: string; cwd?: string },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], cwd: opts.cwd ?? tmpdir() });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new CloudError(`${opts.what} gave no answer after ${Math.round(opts.timeoutMs / 1000)}s`));
    }, opts.timeoutMs);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new CloudError(`could not run "${binary}" (${err.message}). ${opts.install}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.on("error", () => undefined); // a tool that exits early closes stdin; its exit code says why
    child.stdin.end(input);
  });
}

/** The last useful line a failed tool printed, for the error shown to the student. */
export function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return (lines.at(-1) ?? "").slice(0, 400);
}
