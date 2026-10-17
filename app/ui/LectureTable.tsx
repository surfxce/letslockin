"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { DueTag, ScoreTag, StatusTag, Tag } from "@/app/ui/bits";
import { Icon, type IconName } from "@/app/ui/Icon";
import { Menu } from "@/app/ui/Menu";
import { exportHref, NO_MODULE } from "@/lib/export";
import { formatScore, scoreTone, shortDate, tagTone } from "@/lib/format";
import { STATUS_LABEL, STATUS_ORDER, type LectureRow } from "@/lib/status";

type SortKey = "date" | "name" | "score" | "due" | "status" | "laqs" | "module" | "course";
type Dir = "asc" | "desc";
type GroupKey = "none" | "module" | "status" | "course";

interface View {
  sort: SortKey;
  dir: Dir;
  group: GroupKey;
}

const DEFAULT_VIEW: View = { sort: "date", dir: "asc", group: "none" };

/** The sorts people actually reach for, named the way they think of them. */
const PRESETS: Array<{ label: string; sort: SortKey; dir: Dir; icon: IconName }> = [
  { label: "Lecture date — first to last", sort: "date", dir: "asc", icon: "calendar" },
  { label: "Lecture date — latest first", sort: "date", dir: "desc", icon: "calendar" },
  { label: "Weakest first", sort: "score", dir: "asc", icon: "trend" },
  { label: "Strongest first", sort: "score", dir: "desc", icon: "trend" },
  { label: "Due soonest", sort: "due", dir: "asc", icon: "bell" },
  { label: "Name A–Z", sort: "name", dir: "asc", icon: "text" },
];

const GROUPS: Array<{ key: GroupKey; label: string }> = [
  { key: "none", label: "No grouping" },
  { key: "module", label: "Module" },
  { key: "status", label: "Status" },
  { key: "course", label: "Course" },
];

/** Nulls always sink, whichever way the column is sorted. */
function compare(a: LectureRow, b: LectureRow, key: SortKey, dir: Dir): number {
  const sign = dir === "asc" ? 1 : -1;
  const nullsLast = (x: number | string | null, y: number | string | null) => {
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * sign;
  };
  switch (key) {
    case "date":
      return nullsLast(a.deliveredOn, b.deliveredOn) || a.ordinal - b.ordinal;
    case "name":
      return a.title.localeCompare(b.title) * sign;
    case "score":
      return nullsLast(a.lastScore, b.lastScore) || nullsLast(a.deliveredOn, b.deliveredOn);
    case "due":
      return nullsLast(a.dueAt, b.dueAt) || nullsLast(a.lastScore, b.lastScore);
    case "status":
      return (STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)) * sign;
    case "laqs":
      return (a.laqCount - b.laqCount) * sign;
    case "module":
      return nullsLast(a.moduleTitle, b.moduleTitle) || a.ordinal - b.ordinal;
    case "course":
      return a.courseCode.localeCompare(b.courseCode) * sign || a.ordinal - b.ordinal;
  }
}

function groupOf(row: LectureRow, key: GroupKey): string {
  if (key === "module") return row.moduleTitle ?? "No module";
  if (key === "status") return STATUS_LABEL[row.status];
  if (key === "course") return row.courseCode;
  return "";
}

function average(rows: LectureRow[]): number | null {
  const scored = rows.map((r) => r.lastScore).filter((s): s is number => s !== null);
  return scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null;
}

export function LectureTable({
  rows,
  showCourse,
  storageKey,
  newLectureHref,
}: {
  rows: LectureRow[];
  showCourse: boolean;
  storageKey: string;
  newLectureHref: string | null;
}) {
  const router = useRouter();
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [query, setQuery] = useState("");

  // The view is remembered per course, the way a database view keeps its sort.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`lockin.view.${storageKey}`);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after mount
      setView(saved ? { ...DEFAULT_VIEW, ...JSON.parse(saved) } : DEFAULT_VIEW);
    } catch {
      setView(DEFAULT_VIEW);
    }
  }, [storageKey]);

  const update = (next: Partial<View>) => {
    setView((v) => {
      const merged = { ...v, ...next };
      try {
        localStorage.setItem(`lockin.view.${storageKey}`, JSON.stringify(merged));
      } catch {
        // Private windows can refuse storage; the view still works for this visit.
      }
      return merged;
    });
  };

  const sortBy = (key: SortKey) =>
    update(view.sort === key ? { dir: view.dir === "asc" ? "desc" : "asc" } : { sort: key, dir: key === "laqs" ? "desc" : "asc" });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hits = q
      ? rows.filter((r) =>
          [r.title, r.moduleTitle ?? "", r.courseCode, `l${r.ordinal}`].some((s) => s.toLowerCase().includes(q)),
        )
      : rows;
    return [...hits].sort((a, b) => compare(a, b, view.sort, view.dir));
  }, [rows, query, view.sort, view.dir]);

  const groups = useMemo(() => {
    if (view.group === "none") return [{ name: "", rows: filtered }];
    const map = new Map<string, LectureRow[]>();
    for (const r of filtered) {
      const g = groupOf(r, view.group);
      map.set(g, [...(map.get(g) ?? []), r]);
    }
    const list = [...map].map(([name, rows]) => ({ name, rows, avg: average(rows) }));
    if (view.group === "status") {
      list.sort((a, b) => STATUS_ORDER.indexOf(a.rows[0].status) - STATUS_ORDER.indexOf(b.rows[0].status));
    } else if (view.sort === "score") {
      // Grouped and sorted by score: the weakest module comes first, so "where am I
      // weakest" is answered at the module level, not just lecture by lecture.
      const sign = view.dir === "asc" ? 1 : -1;
      list.sort((a, b) => (a.avg === null ? 1 : b.avg === null ? -1 : (a.avg - b.avg) * sign));
    }
    return list;
  }, [filtered, view.group, view.sort, view.dir]);

  const preset = PRESETS.find((p) => p.sort === view.sort && p.dir === view.dir);
  const cols = showCourse ? 8 : 7;

  const header = (key: SortKey, label: string, icon: IconName, className?: string) => (
    <th className={className} aria-sort={view.sort === key ? (view.dir === "asc" ? "ascending" : "descending") : undefined}>
      <button type="button" onClick={() => sortBy(key)}>
        <span className="th-icon">
          <Icon name={icon} size={14} />
        </span>
        <span className={view.sort === key ? "sorted" : undefined}>{label}</span>
        {view.sort === key && <span className="sorted">{view.dir === "asc" ? "↑" : "↓"}</span>}
      </button>
    </th>
  );

  return (
    <>
      <div className="toolbar">
        <Menu
          label={
            <>
              <Icon name="sort" size={14} /> {preset?.label ?? "Sort"}
            </>
          }
          buttonClassName={`chip-btn ${view.sort !== "date" || view.dir !== "asc" ? "set" : ""}`}
        >
          {(close) => (
            <>
              <div className="menu-label">Sort lectures by</div>
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className="item"
                  onClick={() => {
                    update({ sort: p.sort, dir: p.dir });
                    close();
                  }}
                >
                  <Icon name={p.icon} size={15} /> {p.label}
                  {p === preset && <Icon name="check" size={15} className="check-mark" />}
                </button>
              ))}
            </>
          )}
        </Menu>
        <Menu
          label={
            <>
              <Icon name="group" size={14} /> {view.group === "none" ? "Group" : `Grouped by ${GROUPS.find((g) => g.key === view.group)!.label.toLowerCase()}`}
            </>
          }
          buttonClassName={`chip-btn ${view.group !== "none" ? "set" : ""}`}
        >
          {(close) => (
            <>
              <div className="menu-label">Group lectures by</div>
              {GROUPS.filter((g) => showCourse || g.key !== "course").map((g) => (
                <button
                  key={g.key}
                  type="button"
                  className="item"
                  onClick={() => {
                    update({ group: g.key });
                    close();
                  }}
                >
                  {g.label}
                  {view.group === g.key && <Icon name="check" size={15} className="check-mark" />}
                </button>
              ))}
            </>
          )}
        </Menu>
        <label className="search">
          <Icon name="search" size={14} />
          <span className="sr-only">Search lectures</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" />
        </label>
        <span className="spacer" />
      </div>

      <div className="db-wrap">
        <table className="db">
          <thead>
            <tr>
              {header("name", "Lecture", "text", "c-name")}
              {showCourse && header("course", "Course", "book")}
              {header("module", "Module", "layers")}
              {header("date", "Date", "calendar")}
              {header("status", "Status", "status")}
              {header("laqs", "LAQs", "hash", "c-num")}
              {header("score", "Score", "target")}
              {header("due", "Next review", "bell")}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Group
                key={g.name || "all"}
                group={g}
                grouped={view.group !== "none"}
                cols={cols}
                exportLink={view.group === "module" ? moduleExport(g.rows) : null}
              >
                {g.rows.map((r) => (
                  <tr key={r.id} onClick={() => router.push(`/lectures/${r.id}`)}>
                    <td className="c-name">
                      <div className="name-cell">
                        <span className="ord">L{r.ordinal}</span>
                        <Link href={`/lectures/${r.id}`} className="title" onClick={(e) => e.stopPropagation()}>
                          {r.title}
                        </Link>
                        <span className="open">Open</span>
                      </div>
                    </td>
                    {showCourse && (
                      <td>
                        <Tag tone={tagTone(r.courseCode)}>{r.courseCode}</Tag>
                      </td>
                    )}
                    <td>{r.moduleTitle ? <Tag tone={tagTone(r.moduleTitle)}>{r.moduleTitle}</Tag> : <span className="faint">—</span>}</td>
                    <td className="muted">{shortDate(r.deliveredOn)}</td>
                    <td>
                      <StatusTag status={r.status} stageLabel={r.stageLabel} queuePosition={r.queuePosition} error={r.error} />
                    </td>
                    <td className="c-num">{r.laqCount || <span className="faint">—</span>}</td>
                    <td>
                      <ScoreTag score={r.lastScore} prev={r.prevScore} />
                    </td>
                    <td>
                      <DueTag dueAt={r.dueAt} />
                    </td>
                  </tr>
                ))}
              </Group>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={cols} className="muted" style={{ textAlign: "center", height: 64 }}>
                  {query ? `Nothing matches “${query}”.` : "No lectures yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="db-foot">
        {newLectureHref && (
          <Link href={newLectureHref}>
            <Icon name="plus" size={14} /> New lecture
          </Link>
        )}
        <span>
          {filtered.length} of {rows.length} lecture{rows.length === 1 ? "" : "s"}
        </span>
      </div>
    </>
  );
}

/** Where a module group's summaries export from — when its lectures are one module of one course. */
function moduleExport(rows: LectureRow[]): string | null {
  if (!rows.some((r) => r.hasSummary)) return null;
  if (new Set(rows.map((r) => r.courseId)).size !== 1 || new Set(rows.map((r) => r.moduleId)).size !== 1) return null;
  return exportHref({ courseId: rows[0].courseId, moduleId: rows[0].moduleId ?? NO_MODULE });
}

function Group({
  group,
  grouped,
  cols,
  exportLink,
  children,
}: {
  group: { name: string; rows: LectureRow[]; avg?: number | null };
  grouped: boolean;
  cols: number;
  exportLink?: string | null;
  children: React.ReactNode;
}) {
  if (!grouped) return <>{children}</>;
  return (
    <>
      <tr className="group-head">
        <td colSpan={cols}>
          <div className="g">
            <Tag tone={tagTone(group.name)}>{group.name}</Tag>
            <span className="count">{group.rows.length}</span>
            {group.avg != null && (
              <span className="small muted">
                average <span className={`tag score t-${scoreTone(group.avg)}`}>{formatScore(group.avg)}</span>
              </span>
            )}
            {exportLink && (
              <Link href={exportLink} className="group-export" title={`Export ${group.name} as a PDF`}>
                <Icon name="download" size={13} /> Export PDF
              </Link>
            )}
          </div>
        </td>
      </tr>
      {children}
    </>
  );
}
