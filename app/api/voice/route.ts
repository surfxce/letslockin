import { fromLockin } from "@/lib/same-origin";
import { readModel } from "@/lib/voice/choice";
import { naturalStatus, startNaturalDownload } from "@/lib/voice/natural";

export const dynamic = "force-dynamic";

/** Which Qwen models are here, and how their downloads are going. */
export async function GET() {
  return Response.json(naturalStatus());
}

/** Starts downloading a Qwen model ({ model: "1.7b" | "0.6b" }). */
export async function POST(request: Request) {
  if (!fromLockin(request)) return Response.json({ error: "Not allowed." }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { model?: unknown };
  try {
    return Response.json(startNaturalDownload(readModel(body.model)));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
