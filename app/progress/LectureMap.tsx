"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import type { MapNode } from "@/lib/progress/data";
import { MAP_H, MAP_W } from "@/lib/progress/layout";

type Link_ = { a: string; b: string; score: number; shared: string[] };

/**
 * Lectures as dots, linked by the distinctive words they share: the thicker the line,
 * the more they overlap. Hover or tap a lecture to see what it shares with which.
 */
export function LectureMap({
  nodes,
  links,
  courses,
}: {
  nodes: MapNode[];
  links: Link_[];
  /** Course ids in a fixed order (colour follows the course), with their codes. */
  courses: Array<{ id: string; code: string }>;
}) {
  const [focus, setFocus] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const active = focus ?? pinned;
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const slot = (courseId: string) => {
    const i = courses.findIndex((c) => c.id === courseId);
    return i >= 0 && i < 3 ? `var(--course-${i + 1})` : "var(--course-other)";
  };
  const multi = new Set(nodes.map((n) => n.courseId)).size > 1;
  const label = (n: MapNode) => `${multi ? `${n.courseCode} ` : ""}L${n.ordinal}`;
  const neighbours = useMemo(() => {
    if (!active) return [];
    return links
      .filter((l) => l.a === active || l.b === active)
      .map((l) => ({ node: byId.get(l.a === active ? l.b : l.a)!, score: l.score, shared: l.shared }))
      .filter((n) => n.node)
      .sort((x, y) => y.score - x.score);
  }, [active, links, byId]);
  const near = new Set(neighbours.map((n) => n.node.id));

  if (nodes.length < 2) return <div className="pg-empty">The map appears once two or more lectures are prepared.</div>;
  const strongest = Math.max(...links.map((l) => l.score), 0.01);
  const shown = courses.filter((c) => nodes.some((n) => n.courseId === c.id));
  const selected = active ? byId.get(active) : null;

  return (
    <div className="pg-map viz">
      <div className="pg-map-canvas">
        <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} role="img" aria-label={`Map of ${nodes.length} lectures and how they relate`} onClick={() => setPinned(null)}>
          {links.map((l) => {
            const a = byId.get(l.a);
            const b = byId.get(l.b);
            if (!a || !b) return null;
            const on = active && (l.a === active || l.b === active);
            return (
              <line
                key={`${l.a}|${l.b}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={on ? "var(--link-on)" : "var(--link)"}
                strokeWidth={1 + (l.score / strongest) * 4}
                strokeOpacity={active && !on ? 0.35 : 1}
                strokeLinecap="round"
              />
            );
          })}
          {nodes.map((n) => {
            const dim = active && n.id !== active && !near.has(n.id);
            return (
              <g key={n.id} opacity={dim ? 0.3 : 1}>
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={n.id === active ? 11 : 8}
                  fill={slot(n.courseId)}
                  tabIndex={0}
                  role="button"
                  aria-label={`${label(n)} ${n.title}${n.score === null ? "" : `, drill score ${n.score.toFixed(1)}`}`}
                  onMouseEnter={() => setFocus(n.id)}
                  onMouseLeave={() => setFocus(null)}
                  onFocus={() => setFocus(n.id)}
                  onBlur={() => setFocus(null)}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPinned(n.id === pinned ? null : n.id);
                  }}
                />
                <text x={n.x + 13} y={n.y + 4} className={dim ? "dim" : undefined}>
                  {n.id === active || near.has(n.id) ? `${label(n)} · ${n.title.length > 28 ? `${n.title.slice(0, 27)}…` : n.title}` : label(n)}
                </text>
              </g>
            );
          })}
        </svg>
        {shown.length > 1 && (
          <p className="pg-legend" style={{ padding: "0 12px 10px" }}>
            {shown.map((c) => (
              <span key={c.id}>
                <i className="dot" style={{ background: slot(c.id) }} />
                {c.code}
              </span>
            ))}
            <span>Line thickness: how much two lectures share</span>
          </p>
        )}
      </div>
      <aside className="pg-side">
        {selected ? (
          <>
            <h3>{selected.title}</h3>
            <div className="small muted">
              {label(selected)}
              {selected.score === null ? " · not drilled yet" : ` · drill score ${selected.score.toFixed(1)}`} ·{" "}
              <Link href={`/lectures/${selected.id}`} className="link">
                Open
              </Link>
            </div>
            {neighbours.length ? (
              <ol>
                {neighbours.map((n) => (
                  <li key={n.node.id}>
                    <Link href={`/lectures/${n.node.id}`}>{n.node.title}</Link>
                    <span className="why">Shares: {n.shared.join(", ")}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="small muted">Nothing distinctive in common with your other lectures.</p>
            )}
          </>
        ) : (
          <>
            <h3>Closest lectures</h3>
            <p className="small muted" style={{ margin: 0 }}>
              Hover or tap a dot to see what it shares. Revising a weak lecture? Its neighbours are worth a look too.
            </p>
            <ol>
              {links.slice(0, 6).map((l) => (
                <li key={`${l.a}|${l.b}`}>
                  <b>{byId.get(l.a)?.title}</b> and <b>{byId.get(l.b)?.title}</b>
                  <span className="why">Shares: {l.shared.join(", ")}</span>
                </li>
              ))}
            </ol>
          </>
        )}
      </aside>
    </div>
  );
}
