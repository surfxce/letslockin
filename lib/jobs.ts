import { prisma } from "@/lib/db";
import { readHeartbeat } from "@/lib/settings";
import { STAGES, type JobKind, type Stage } from "@/lib/types";

/** Marking jumps the queue: someone is sitting there waiting for their score. */
export const PRIORITY = { PREPARE: 0, GENERATE: 0, MARK: 10 } as const satisfies Record<JobKind, number>;

export interface Step {
  stage: Stage;
  startedAt: string;
  finishedAt: string | null;
}

export function readSteps(json: string | null): Step[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as Step[]) : [];
  } catch {
    return [];
  }
}

export async function enqueue(
  kind: JobKind,
  payload: Record<string, unknown>,
  lectureId: string | null,
) {
  return prisma.job.create({
    data: { kind, payload: JSON.stringify(payload), lectureId, priority: PRIORITY[kind] },
  });
}

/**
 * Queues lectures to be prepared one at a time, in the order given. A lecture that
 * is already waiting or running is not queued twice.
 */
export async function queuePrepare(lectureIds: string[], opts: { redo?: boolean } = {}) {
  const busy = new Set(
    (
      await prisma.job.findMany({
        where: { lectureId: { in: lectureIds }, kind: "PREPARE", status: { in: ["PENDING", "RUNNING"] } },
        select: { lectureId: true },
      })
    ).map((j) => j.lectureId),
  );
  let queued = 0;
  for (const lectureId of lectureIds) {
    if (busy.has(lectureId)) continue;
    await enqueue("PREPARE", { lectureId, redo: !!opts.redo }, lectureId);
    queued++;
  }
  return queued;
}

/** Drops work that has not started. A running job finishes its current lecture. */
export async function clearQueue(lectureId?: string) {
  const { count } = await prisma.job.deleteMany({
    where: { status: "PENDING", kind: { in: ["PREPARE", "GENERATE"] }, ...(lectureId ? { lectureId } : {}) },
  });
  return count;
}

export async function retryJob(jobId: string) {
  await prisma.job.update({
    where: { id: jobId },
    data: { status: "PENDING", attempts: 0, error: null, finishedAt: null, stage: null, steps: null },
  });
}

/** Called by the worker as it moves through a job, so the UI can say what it is doing and since when. */
export async function enterStage(jobId: string, stage: Stage) {
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId }, select: { steps: true } });
  const now = new Date().toISOString();
  const steps = readSteps(job.steps).map((s) => (s.finishedAt ? s : { ...s, finishedAt: now }));
  steps.push({ stage, startedAt: now, finishedAt: null });
  await prisma.job.update({ where: { id: jobId }, data: { stage, steps: JSON.stringify(steps) } });
}

export function closeSteps(json: string | null): string {
  const now = new Date().toISOString();
  return JSON.stringify(readSteps(json).map((s) => (s.finishedAt ? s : { ...s, finishedAt: now })));
}

// ---------------------------------------------------------------------------
// What the app is doing right now — the header indicator and lecture pages read this.

export interface ActivityJob {
  id: string;
  kind: string;
  status: string;
  lectureId: string | null;
  lectureTitle: string | null;
  courseCode: string | null;
  stage: Stage | null;
  stageLabel: string | null;
  steps: Step[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
}

export interface Activity {
  worker: { alive: boolean; at: string } | null;
  running: ActivityJob | null;
  queued: ActivityJob[];
  recent: ActivityJob[];
  /** Changes whenever anything above does, so a page knows when to refresh. */
  version: string;
}

type JobRow = Awaited<ReturnType<typeof loadJobs>>[number];

function loadJobs(where: Parameters<typeof prisma.job.findMany>[0]) {
  return prisma.job.findMany({
    ...where,
    select: {
      id: true,
      kind: true,
      status: true,
      lectureId: true,
      stage: true,
      steps: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      durationMs: true,
      error: true,
      lecture: { select: { title: true, course: { select: { code: true } } } },
    },
  });
}

function toActivity(j: JobRow): ActivityJob {
  const stage = (j.stage as Stage | null) ?? null;
  return {
    id: j.id,
    kind: j.kind,
    status: j.status,
    lectureId: j.lectureId,
    lectureTitle: j.lecture?.title ?? null,
    courseCode: j.lecture?.course.code ?? null,
    stage,
    stageLabel: stage ? (STAGES[stage] ?? stage) : null,
    steps: readSteps(j.steps),
    createdAt: j.createdAt.toISOString(),
    startedAt: j.startedAt?.toISOString() ?? null,
    finishedAt: j.finishedAt?.toISOString() ?? null,
    durationMs: j.durationMs,
    error: j.error,
  };
}

export async function activity(): Promise<Activity> {
  const [running, queued, recent, beat] = await Promise.all([
    loadJobs({ where: { status: "RUNNING" }, orderBy: { startedAt: "asc" }, take: 1 }),
    loadJobs({ where: { status: "PENDING" }, orderBy: [{ priority: "desc" }, { createdAt: "asc" }], take: 50 }),
    loadJobs({
      where: { status: { in: ["DONE", "FAILED"] }, finishedAt: { gte: new Date(Date.now() - 86_400_000) } },
      orderBy: { finishedAt: "desc" },
      take: 12,
    }),
    readHeartbeat(),
  ]);
  const out = {
    worker: beat ? { alive: beat.alive, at: beat.at } : null,
    running: running[0] ? toActivity(running[0]) : null,
    queued: queued.map(toActivity),
    recent: recent.map(toActivity),
  };
  const version = [
    out.running ? `${out.running.id}:${out.running.stage}` : "-",
    out.queued.length,
    out.recent[0]?.id ?? "-",
    out.recent[0]?.status ?? "-",
    out.worker?.alive ? 1 : 0,
  ].join("|");
  return { ...out, version };
}
