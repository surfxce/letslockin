"use client";

import { useMemo, useState } from "react";

import type { ScorePoint } from "@/lib/progress/data";

const W = 760;
const H = 240;
const PAD = { l: 34, r: 12, t: 12, b: 26 };
/** The trend line averages this many sittings. */
const WINDOW = 5;

/** Every marked sitting's score over time, with the running average as a line. */
export function ScoreChart({ scores }: { scores: ScorePoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const geo = useMemo(() => {
    const times = scores.map((s) => Date.parse(s.at));
    const t0 = Math.min(...times);
    const t1 = Math.max(...times);
    const span = Math.max(t1 - t0, 86_400_000);
    const x = (t: number) => PAD.l + ((t - t0) / span) * (W - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - v / 10) * (H - PAD.t - PAD.b);
    const points = scores.map((s, i) => ({ ...s, x: scores.length === 1 ? W / 2 : x(times[i]), y: y(s.score) }));
    const avg = points.map((p, i) => {
      const from = Math.max(0, i - WINDOW + 1);
      const slice = scores.slice(from, i + 1);
      return { x: p.x, y: y(slice.reduce((n, s) => n + s.score, 0) / slice.length) };
    });
    const ticks = Array.from({ length: 5 }, (_, i) => t0 + (span * i) / 4);
    return { points, avg, ticks: scores.length > 1 ? ticks.map((t) => ({ x: x(t), label: new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" }) })) : [], y };
  }, [scores]);

  if (!scores.length) return <div className="pg-empty">Scores appear here once your first sitting is marked.</div>;
  const p = hover === null ? null : geo.points[hover];
  return (
    <div className="pg-chart viz">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Sitting scores over time: ${scores.length} sittings, latest ${scores[scores.length - 1].score.toFixed(1)} out of 10`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const mx = ((e.clientX - box.left) / box.width) * W;
          let best = 0;
          geo.points.forEach((q, i) => {
            if (Math.abs(q.x - mx) < Math.abs(geo.points[best].x - mx)) best = i;
          });
          setHover(best);
        }}
      >
        {[0, 2.5, 5, 7.5, 10].map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={geo.y(v)} y2={geo.y(v)} stroke="var(--grid)" strokeWidth={1} />
            <text x={PAD.l - 8} y={geo.y(v) + 4} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {geo.ticks.map((t, i) => (
          <text key={i} x={t.x} y={H - 6} textAnchor={i === 0 ? "start" : i === geo.ticks.length - 1 ? "end" : "middle"}>
            {t.label}
          </text>
        ))}
        {p && <line x1={p.x} x2={p.x} y1={PAD.t} y2={H - PAD.b} stroke="var(--axis)" strokeWidth={1} strokeDasharray="3 3" />}
        {geo.avg.length > 1 && (
          <polyline points={geo.avg.map((q) => `${q.x},${q.y}`).join(" ")} fill="none" stroke="var(--series)" strokeWidth={2} strokeLinejoin="round" />
        )}
        {geo.points.map((q, i) => (
          <circle key={i} cx={q.x} cy={q.y} r={hover === i ? 5.5 : 4} fill={hover === i ? "var(--series)" : "var(--series-soft)"} stroke="var(--bg)" strokeWidth={2} />
        ))}
      </svg>
      {p && (
        <div className="pg-tip" style={{ left: `${(p.x / W) * 100}%`, top: `${(p.y / H) * 100}%` }}>
          <b>{p.score.toFixed(1)} / 10</b>
          {p.lecture}
          <div className="muted">
            {new Date(p.at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
            {p.source === "EXAM" ? " · in an exam" : p.source === "VIVA" ? " · in a viva" : p.source === "CASE" ? " · in a clinical case" : p.source === "PASTED" ? " · marked in an AI chat" : ""}
          </div>
        </div>
      )}
      <p className="pg-legend">
        <span>
          <i className="dot" style={{ background: "var(--series-soft)" }} />
          Each sitting
        </span>
        <span>
          <i style={{ background: "var(--series)", height: 2, borderRadius: 1 }} />
          Average of the last {WINDOW}
        </span>
      </p>
    </div>
  );
}
