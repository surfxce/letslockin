import { revalidatePath } from "next/cache";

import { handleHello, handleSlide, handleSync, type PhoneReply } from "@/lib/phone/handlers";
import { isPhoneOp, openRequest, sealJson, sealReply } from "@/lib/phone/protocol";

export const dynamic = "force-dynamic";

/** The largest request a phone sends: a sync with many sittings and reviews. */
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * Requests from a paired iPhone, passed on by the desktop app's gateway. Each is sealed
 * with the pairing's key (lib/phone/protocol.ts); anything else gets a bare refusal.
 */
export async function POST(request: Request, ctx: { params: Promise<{ op: string }> }) {
  const { op } = await ctx.params;
  if (!isPhoneOp(op)) return new Response("Not found.", { status: 404 });
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) return new Response("Too large.", { status: 413 });
  const body = Buffer.from(await request.arrayBuffer());
  if (body.length > MAX_BYTES) return new Response("Too large.", { status: 413 });

  const opened = await openRequest(op, request.headers.get("x-lockin-pairing"), body);
  if (!opened.ok) return new Response(opened.message, { status: opened.status });

  let reply: PhoneReply;
  try {
    reply =
      op === "hello"
        ? await handleHello(opened.pairing, opened.body)
        : op === "sync"
          ? await handleSync(opened.pairing, opened.body)
          : await handleSlide(opened.pairing, opened.body);
  } catch (err) {
    console.error(`phone ${op} failed:`, err);
    reply = { kind: "json", value: { ok: false, error: "Something went wrong on the computer. Try again." } };
  }
  // New sittings and reviews show on the computer straight away.
  if (op === "sync") revalidatePath("/", "layout");
  return reply.kind === "image"
    ? sealReply(opened.key, op, opened.requestId, reply.bytes, "image/jpeg")
    : sealJson(opened.key, op, opened.requestId, reply.value);
}
