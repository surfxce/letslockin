"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  addLeftOutToSummary,
  addToSummary,
  startAsk,
  type AskRequest,
  type EditResult,
  type Placement,
} from "@/app/study-actions";
import type { AskResult } from "@/lib/ask";
import { leftOutInsert } from "@/lib/summary-edit";

/**
 * Asking the AI something from a lecture page and waiting for the answer. The worker
 * answers in a lane of its own (lib/ask.ts); this queues the question and polls the
 * job until it is done, saying so if the worker isn't running to answer it.
 */

export type AskState =
  | { status: "idle" }
  | { status: "waiting"; startedAt: number; workerAlive: boolean }
  | { status: "done"; result: AskResult }
  | { status: "error"; message: string };

const POLL_MS = 700;
/** Longer than a slow answer on a small offline model, short of forever. */
const GIVE_UP_MS = 5 * 60_000;

/** A failure in words the student can act on. */
export function explainError(raw: string): string {
  if (/authenticat|oauth|not logged in|log in|login|\b401\b/i.test(raw)) {
    return `${raw} — Claude Code needs signing in again: run \`claude auth login\` in a terminal, then try again.`;
  }
  if (/rate.?limit|usage limit|\b429\b|overloaded/i.test(raw)) {
    return `${raw} — Claude is busy or you've hit your usage limit. Try again in a little while.`;
  }
  return raw;
}

export function useAsk() {
  const [state, setState] = useState<AskState>({ status: "idle" });
  // Each ask gets a number; an answer arriving for an older one is ignored.
  const current = useRef(0);

  useEffect(
    () => () => {
      current.current++;
    },
    [],
  );

  const reset = useCallback(() => {
    current.current++;
    setState({ status: "idle" });
  }, []);

  const ask = useCallback(async (req: AskRequest) => {
    const mine = ++current.current;
    const live = () => current.current === mine;
    const startedAt = Date.now();
    setState({ status: "waiting", startedAt, workerAlive: true });

    let start;
    try {
      start = await startAsk(req);
    } catch (err) {
      if (live()) setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!live()) return;
    if ("error" in start) return setState({ status: "error", message: start.error });
    if ("done" in start) return setState({ status: "done", result: start.done });

    while (live()) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (!live()) return;
      try {
        const res = await fetch(`/api/jobs/${start.jobId}`, { cache: "no-store" });
        if (!live()) return;
        if (res.status === 404) return setState({ status: "error", message: "The question was lost — ask it again." });
        const job = (await res.json()) as {
          status: string;
          error: string | null;
          result: AskResult | null;
          workerAlive: boolean;
        };
        if (!live()) return;
        if (job.status === "DONE" && job.result) return setState({ status: "done", result: job.result });
        if (job.status === "FAILED") {
          return setState({ status: "error", message: explainError(job.error ?? "The AI couldn't answer that.") });
        }
        if (Date.now() - startedAt > GIVE_UP_MS) {
          return setState({ status: "error", message: "No answer after five minutes. Try again in a moment." });
        }
        setState((s) => (s.status === "waiting" && s.workerAlive !== job.workerAlive ? { ...s, workerAlive: job.workerAlive } : s));
      } catch {
        // A dropped poll: the next one tries again.
      }
    }
  }, []);

  return { state, ask, reset };
}

// ---------------------------------------------------------------------------
// Adding to the summary — into the editor when it is open, so an unsaved edit and an
// added answer never overwrite each other; straight into the saved summary otherwise.

type Inserter = (markdown: string, place: Placement) => void;
let inserter: Inserter | null = null;

/** Called by the summary editor while it is open. Returns the function that unregisters it. */
export function registerSummaryInserter(fn: Inserter): () => void {
  inserter = fn;
  return () => {
    if (inserter === fn) inserter = null;
  };
}

export async function addToLectureSummary(lectureId: string, markdown: string, place: Placement): Promise<EditResult> {
  if (inserter) {
    inserter(markdown, place);
    return { ok: true, message: "Added to the summary you're editing — save it to keep it." };
  }
  try {
    return await addToSummary({ lectureId, markdown, place });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Puts a left-out part back. Into the open editor when there is one — the part is then
 * only in the summary once the edit is saved, so it is not marked as added here.
 */
export async function addLeftOutPart(lectureId: string, part: { what: string; about: string }): Promise<EditResult> {
  if (inserter) {
    const { block, atStart } = leftOutInsert(part.what, part.about);
    inserter(block, atStart ? { start: true } : { section: null });
    return { ok: true, message: "Added to the summary you're editing — save it to keep it." };
  }
  try {
    return await addLeftOutToSummary({ lectureId, what: part.what });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
