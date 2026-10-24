import { prisma } from "@/lib/db";
import { wordsFor } from "@/lib/recordings/service";
import { fromLockin } from "@/lib/same-origin";
import { getSettings } from "@/lib/settings";
import { feedLive, finishLive, startLive } from "@/lib/viva/live";
import { readPlan } from "@/lib/viva/schema";
import { SPEECH_RATE } from "@/lib/viva/wav";

export const dynamic = "force-dynamic";

/** A minute of sound at most in one piece. */
const MAX_PIECE = 60 * SPEECH_RATE * 2;

/**
 * A spoken answer heard while it's said. The viva page posts its sound a piece at a time
 * (16 kHz mono 16-bit PCM, no header) with ?answer=<id> — the first piece with &start=1,
 * the last with &end=1. Each reply is what's been heard so far; the last, the whole text.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!fromLockin(request)) return Response.json({ error: "Not allowed." }, { status: 403 });
  const { id } = await ctx.params;
  const query = new URL(request.url).searchParams;
  const answer = query.get("answer") ?? "";
  if (!/^[\w-]{6,64}$/.test(answer)) return Response.json({ error: "Which answer?" }, { status: 400 });
  const pcm = new Uint8Array(await request.arrayBuffer());
  if (pcm.length > MAX_PIECE || pcm.length % 2) return Response.json({ error: "That sound couldn't be read." }, { status: 400 });
  try {
    if (query.get("start")) {
      const viva = await prisma.viva.findUnique({ where: { id }, select: { plan: true, current: true } });
      const item = viva ? readPlan(viva.plan)[viva.current] : null;
      if (!item) return Response.json({ error: "This viva is over." }, { status: 404 });
      // The lecture's technical words help Whisper spell them.
      const { words } = await wordsFor(item.lectureId);
      startLive(answer, { model: (await getSettings()).whisperModel, prompt: words.slice(0, 40).join(", ") });
    }
    if (query.get("end")) return Response.json({ text: await finishLive(answer, pcm), via: "Whisper" });
    return Response.json(feedLive(answer, pcm));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Couldn't hear that." }, { status: 500 });
  }
}
