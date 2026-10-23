import { prisma } from "@/lib/db";
import { fromLockin } from "@/lib/same-origin";
import { hearAnswer } from "@/lib/viva/listen";
import { readPlan } from "@/lib/viva/schema";
import { looksLikeWav } from "@/lib/viva/wav";

export const dynamic = "force-dynamic";

/** A spoken answer, as WAV in the request body, back as text to check before sending. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!fromLockin(request)) return Response.json({ error: "Not allowed." }, { status: 403 });
  const { id } = await ctx.params;
  const viva = await prisma.viva.findUnique({ where: { id }, select: { plan: true, current: true } });
  const item = viva ? readPlan(viva.plan)[viva.current] : null;
  if (!item) return Response.json({ error: "This viva is over." }, { status: 404 });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!looksLikeWav(bytes)) return Response.json({ error: "That recording couldn't be read — try again, or type it." }, { status: 400 });
  try {
    const heard = await hearAnswer(Buffer.from(bytes), item.lectureId);
    return Response.json(heard);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Couldn't hear that." }, { status: 500 });
  }
}
