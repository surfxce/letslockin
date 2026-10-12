/**
 * How Lockin gets its summaries, LAQs and marks. Client-safe.
 *  - auto: Claude Code on this computer, through the worker.
 *  - local: a model downloaded to this computer, through the worker. Fully offline.
 *  - manual: copy a prompt into any AI chat and paste the reply back. Nothing runs here.
 */
export type Mode = "auto" | "local" | "manual";

export const MODE_LABEL: Record<Mode, string> = {
  auto: "Claude Code",
  local: "On this computer",
  manual: "Copy & paste",
};

/** Whether the worker does the AI part, so "Prepare with AI" and marking apply. */
export function usesAi(mode: Mode): boolean {
  return mode !== "manual";
}
