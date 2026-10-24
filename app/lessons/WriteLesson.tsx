"use client";

import { useState, useTransition } from "react";

import type { Result } from "@/app/actions";
import { askForLesson } from "@/app/lessons/actions";
import { ResultLine } from "@/app/ui/forms";
import { Icon } from "@/app/ui/Icon";

export function WriteLesson({ conceptId, busy }: { conceptId: string; busy: boolean }) {
  const [result, setResult] = useState<Result>(null);
  const [pending, start] = useTransition();
  const writing = busy || (result?.ok ?? false);
  return (
    <>
      <button type="button" className="btn sm" disabled={pending || writing} onClick={() => start(async () => setResult(await askForLesson(conceptId)))}>
        <Icon name="sparkles" size={14} /> {writing ? "Writing…" : "Write a lesson"}
      </button>
      {result && !result.ok && <ResultLine result={result} />}
    </>
  );
}
