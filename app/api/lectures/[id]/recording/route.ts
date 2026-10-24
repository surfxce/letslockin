import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db";
import { queuePrepare } from "@/lib/jobs";
import { usesAi } from "@/lib/modes";
import { isRecording, MAX_RECORDING_BYTES } from "@/lib/recordings/media";
import { queueTranscribe } from "@/lib/recordings/service";
import { storeRecording } from "@/lib/recordings/store";
import { fromLockin } from "@/lib/same-origin";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * A lecture recording, sent as the raw request body and streamed to disk — a filmed
 * lecture can be a gigabyte, too big to pass through a form. It's then transcribed:
 * as the first step of preparing a lecture that hasn't been, or on its own.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!fromLockin(request)) return Response.json({ error: "Not allowed." }, { status: 403 });
  const { id } = await ctx.params;
  const lecture = await prisma.lecture.findUnique({ where: { id }, select: { id: true, summaryMd: true } });
  if (!lecture) return Response.json({ error: "That lecture isn't here any more." }, { status: 404 });
  const name = decodeURIComponent(request.headers.get("x-file-name") ?? "");
  if (!isRecording(name)) return Response.json({ error: "That isn't a recording Lockin can read (.mp4 .m4a .mp3 .wav .mov…)." }, { status: 400 });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_RECORDING_BYTES) {
    return Response.json({ error: "That recording is larger than 6GB." }, { status: 413 });
  }
  if (!request.body) return Response.json({ error: "The recording didn't arrive." }, { status: 400 });
  try {
    const { added } = await storeRecording({ lectureId: id, name, from: request.body });
    if (added) {
      if (!lecture.summaryMd && usesAi((await getSettings()).mode)) await queuePrepare([id]);
      else await queueTranscribe(id);
    }
    revalidatePath("/", "layout");
    return Response.json({ ok: true, added });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Couldn't keep that recording." }, { status: 500 });
  }
}
