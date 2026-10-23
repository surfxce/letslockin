"use client";

import { useState, useTransition } from "react";

import type { Result } from "@/app/actions";
import { makeExamCards, makeSittingCards } from "@/app/ak/mistake-actions";
import { ResultLine } from "@/app/ui/forms";
import { Icon } from "@/app/ui/Icon";

/** "Make AK cards from my mistakes", for a marked sitting or an exam's results. */
export function MistakeCards({ attemptId, examId, left, made }: { attemptId?: string; examId?: string; left: number; made: number }) {
  const [result, setResult] = useState<Result>(null);
  const [pending, start] = useTransition();
  if (!left && !made) return null;
  return (
    <div className="mistake-cards">
      <Icon name="layers" size={16} />
      <span className="mistake-cards-text">
        {left
          ? `${left} thing${left === 1 ? "" : "s"} you missed or got wrong can become AK cards, so you drill them until they stick.`
          : "Your mistakes from here are in AK."}
      </span>
      {left > 0 && (
        <button
          type="button"
          className="btn sm primary"
          disabled={pending}
          onClick={() => start(async () => setResult(await (examId ? makeExamCards(examId) : makeSittingCards(attemptId!))))}
        >
          {pending ? "Making cards…" : `Make ${left} card${left === 1 ? "" : "s"}`}
        </button>
      )}
      <ResultLine result={result} />
    </div>
  );
}
