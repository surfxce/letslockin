import { prisma } from "@/lib/db";
import { readPlan, readTurns } from "@/lib/viva/schema";

export const dynamic = "force-dynamic";

/** Where a viva is, for the page to follow while the examiner thinks. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const viva = await prisma.viva.findUnique({ where: { id } });
  if (!viva) return Response.json({ error: "That viva isn't here any more." }, { status: 404 });
  const failed =
    viva.waitingOn === "examiner"
      ? await prisma.job.findFirst({
          where: { kind: "VIVA", payload: { contains: id }, status: "FAILED" },
          orderBy: { createdAt: "desc" },
          select: { error: true },
        })
      : null;
  return Response.json({
    waitingOn: viva.waitingOn,
    current: viva.current,
    total: readPlan(viva.plan).length,
    turns: readTurns(viva.turns),
    error: failed?.error ?? null,
  });
}
