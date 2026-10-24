import { fromLockin } from "@/lib/same-origin";
import { getSettings } from "@/lib/settings";
import { readModel, readStyle, readVoice, usableModel } from "@/lib/voice/choice";
import { naturalStatus, speakNatural } from "@/lib/voice/natural";

export const dynamic = "force-dynamic";

/**
 * A line said in a Qwen voice, as WAV. Voice, model and style come with the request
 * (Settings tries them before they're saved), else from Settings.
 */
export async function POST(request: Request) {
  if (!fromLockin(request)) return Response.json({ error: "Not allowed." }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { text?: unknown; voice?: unknown; model?: unknown; style?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return Response.json({ error: "Nothing to say." }, { status: 400 });
  const settings = await getSettings();
  const model = usableModel(readModel(body.model ?? settings.voiceModel), naturalStatus().ready);
  if (!model) return Response.json({ error: "No Qwen voice is downloaded yet — download one in Settings → Viva voice." }, { status: 409 });
  try {
    const wav = await speakNatural(text, {
      voice: readVoice(body.voice ?? settings.vivaVoice),
      model,
      style: readStyle(body.style ?? settings.voiceStyle),
    });
    return new Response(new Uint8Array(wav), { headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 503 });
  }
}
