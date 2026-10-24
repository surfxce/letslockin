"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import type { Result } from "@/app/actions";
import { cardsFromLesson, markLessonDone } from "@/app/lessons/actions";
import { ResultLine } from "@/app/ui/forms";
import { Icon } from "@/app/ui/Icon";
import type { LessonCheck } from "@/lib/lessons/schema";

/** The quick questions: try each in your head, then look. */
export function LessonChecks({ lessonId, checks, done, canCard }: { lessonId: string; checks: LessonCheck[]; done: boolean; canCard: boolean }) {
  const router = useRouter();
  const [shown, setShown] = useState<boolean[]>(() => checks.map(() => false));
  const [result, setResult] = useState<Result>(null);
  const [pending, start] = useTransition();
  const allShown = shown.every(Boolean);

  return (
    <>
      <ol className="lesson-checks">
        {checks.map((c, i) => (
          <li key={i}>
            <div className="lesson-q">{c.question}</div>
            {shown[i] ? (
              <div className="lesson-a">{c.answer}</div>
            ) : (
              <button type="button" className="btn sm" onClick={() => setShown((s) => s.map((v, k) => (k === i ? true : v)))}>
                Show answer
              </button>
            )}
          </li>
        ))}
      </ol>
      <div className="row lesson-actions">
        {!done && (
          <button
            type="button"
            className={`btn${allShown ? " primary" : ""}`}
            disabled={pending}
            onClick={() =>
              start(async () => {
                await markLessonDone(lessonId);
                router.push("/today");
              })
            }
          >
            <Icon name="check" size={14} /> Done
          </button>
        )}
        {canCard && (
          <button type="button" className="btn" disabled={pending} onClick={() => start(async () => setResult(await cardsFromLesson(lessonId)))}>
            <Icon name="layers" size={14} /> Keep these as AK cards
          </button>
        )}
      </div>
      <ResultLine result={result} />
    </>
  );
}
