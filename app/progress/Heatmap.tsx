"use client";

import Link from "next/link";
import { useState } from "react";

import type { HeatRow } from "@/lib/progress/data";

const BINS = [
  { max: 2, label: "0–2", color: "var(--m-0)" },
  { max: 4, label: "2–4", color: "var(--m-1)" },
  { max: 6, label: "4–6", color: "var(--m-2)" },
  { max: 8, label: "6–8", color: "var(--m-3)" },
  { max: 10.01, label: "8–10", color: "var(--m-4)" },
];
const colour = (m: number) => BINS.find((b) => m < b.max)!.color;

/** Every concept of every lecture, coloured by its latest mark. */
export function Heatmap({ rows, multiCourse }: { rows: HeatRow[]; multiCourse: boolean }) {
  const [tip, setTip] = useState<{ x: number; y: number; name: string; lecture: string; mastery: number | null } | null>(null);
  if (!rows.length) return <div className="pg-empty">Concepts appear here once lectures are prepared.</div>;
  return (
    <div className="pg-chart viz" onMouseLeave={() => setTip(null)}>
      <div className="pg-heat">
        {rows.map((r) => (
          <div key={r.lectureId} className="pg-heat-row">
            <Link href={`/lectures/${r.lectureId}`} className="pg-heat-name" title={r.title}>
              <span className="faint">
                {multiCourse ? `${r.courseCode} ` : ""}L{r.ordinal}
              </span>
              {r.title}
            </Link>
            <div className="pg-cells">
              {r.cells.map((c) => {
                const show = (e: React.MouseEvent | React.FocusEvent) => {
                  const cell = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const box = (e.currentTarget as HTMLElement).closest(".pg-chart")!.getBoundingClientRect();
                  setTip({ x: cell.left + cell.width / 2 - box.left, y: cell.top - box.top, name: c.name, lecture: r.title, mastery: c.mastery });
                };
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`pg-cell${c.mastery === null ? " untested" : ""}`}
                    style={c.mastery === null ? undefined : { background: colour(c.mastery) }}
                    aria-label={`${c.name}: ${c.mastery === null ? "not tested yet" : `${c.mastery.toFixed(1)} out of 10`}`}
                    onMouseEnter={show}
                    onFocus={show}
                    onBlur={() => setTip(null)}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {tip && (
        <div className="pg-tip" style={{ left: tip.x, top: tip.y }}>
          <b>{tip.name}</b>
          {tip.mastery === null ? "Not tested yet" : `Latest mark ${tip.mastery.toFixed(1)} / 10`}
          <div className="muted">{tip.lecture}</div>
        </div>
      )}
      <p className="pg-legend">
        <span>Latest mark</span>
        {BINS.map((b) => (
          <span key={b.label}>
            <i style={{ background: b.color }} />
            {b.label}
          </span>
        ))}
        <span>
          <i className="untested" />
          Not tested yet
        </span>
      </p>
    </div>
  );
}
