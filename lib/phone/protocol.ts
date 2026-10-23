import { findPairing, type Pairing } from "@/lib/phone/pairing";
import { fromBase64Url, open, replyAad, requestAad, seal } from "@/lib/phone/crypto";

/**
 * A request from the phone: POST /v1/<op> with the pairing id in a header and, as the
 * body, sealed JSON { t: sent at (ms), r: request id, body }. The reply is sealed to
 * that request id, so it can't be swapped for another.
 */
export const PHONE_OPS = ["hello", "sync", "slide"] as const;
export type PhoneOp = (typeof PHONE_OPS)[number];

export function isPhoneOp(op: string): op is PhoneOp {
  return (PHONE_OPS as readonly string[]).includes(op);
}

/** How far the phone's clock may be from this computer's. */
const CLOCK_SKEW_MS = 10 * 60_000;

/** Request ids seen recently: a copied request is refused the second time. */
const seen = (globalThis as unknown as { __lockinPhoneSeen?: Map<string, number> }).__lockinPhoneSeen ?? new Map<string, number>();
(globalThis as unknown as { __lockinPhoneSeen?: Map<string, number> }).__lockinPhoneSeen = seen;

export type Opened =
  | { ok: true; pairing: Pairing; key: Buffer; requestId: string; body: unknown }
  | { ok: false; status: number; message: string };

export async function openRequest(op: PhoneOp, pairingId: string | null, sealed: Buffer, now = Date.now()): Promise<Opened> {
  const pairing = await findPairing(pairingId);
  // Nothing about why: an unpaired phone and a stranger get the same answer.
  if (!pairing) return { ok: false, status: 401, message: "This phone isn't paired with this computer." };
  const key = fromBase64Url(pairing.key);
  const plain = open(key, sealed, requestAad(op, pairing.id));
  if (!plain) return { ok: false, status: 401, message: "This phone isn't paired with this computer." };
  let envelope: { t?: unknown; r?: unknown; body?: unknown };
  try {
    envelope = JSON.parse(plain.toString("utf8"));
  } catch {
    return { ok: false, status: 400, message: "That request couldn't be read." };
  }
  const sentAt = Number(envelope.t);
  const requestId = typeof envelope.r === "string" ? envelope.r : "";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) return { ok: false, status: 400, message: "That request couldn't be read." };
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > CLOCK_SKEW_MS) {
    return { ok: false, status: 400, message: "The phone's clock and this computer's are more than 10 minutes apart." };
  }
  for (const [id, expires] of seen) if (expires < now) seen.delete(id);
  const replayKey = `${pairing.id}:${requestId}`;
  if (seen.has(replayKey)) return { ok: false, status: 409, message: "That request was already received." };
  seen.set(replayKey, now + 2 * CLOCK_SKEW_MS);
  return { ok: true, pairing, key, requestId, body: envelope.body ?? null };
}

/** A reply sealed to its request: JSON, or a picture's bytes. */
export function sealReply(key: Buffer, op: PhoneOp, requestId: string, payload: Buffer, type: "json" | "image/jpeg"): Response {
  return new Response(new Uint8Array(seal(key, payload, replyAad(op, requestId))), {
    status: 200,
    headers: { "content-type": "application/octet-stream", "x-lockin-type": type, "cache-control": "no-store" },
  });
}

export function sealJson(key: Buffer, op: PhoneOp, requestId: string, value: unknown): Response {
  return sealReply(key, op, requestId, Buffer.from(JSON.stringify(value), "utf8"), "json");
}
