import { prisma } from "@/lib/db";
import { readHeartbeat } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** One job's state, for a screen waiting on it — the import screen's AI sort. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const [job, beat] = await Promise.all([
    prisma.job.findUnique({
      where: { id },
      select: { kind: true, status: true, error: true, result: true, startedAt: true, durationMs: true },
    }),
    readHeartbeat(),
  ]);
  if (!job) return Response.json({ error: "No such job." }, { status: 404 });
  let result: unknown = null;
  try {
    result = job.result ? JSON.parse(job.result) : null;
  } catch {
    // A half-written result reads as none; the status says whether it is done.
  }
  return Response.json(
    { ...job, result, workerAlive: !!beat?.alive },
    { headers: { "cache-control": "no-store" } },
  );
}
