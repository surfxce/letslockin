import { fromLockin } from "@/lib/same-origin";
import { NATURAL_VOICES } from "@/lib/voice/choice";
import { speakNatural } from "@/lib/voice/natural";

export const dynamic = "force-dynamic";

/** A line said in the natural voice, as WAV. */
export async function POST(request: Request) {
  if (!fromLockin(request)) return Response.json({ error: "Not allowed." }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { text?: unknown; voice?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const voice = NATURAL_VOICES.some((v) => v.id === body.voice) ? String(body.voice) : NATURAL_VOICES[0].id;
  if (!text) return Response.json({ error: "Nothing to say." }, { status: 400 });
  try {
    const wav = await speakNatural(text, voice);
    return new Response(new Uint8Array(wav), { headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 503 });
  }
}
