import { prisma } from "@/lib/db";
import { parseCrop } from "@/lib/markdown";
import { ingestReviews, ingestSitting, type SittingOutcome } from "@/lib/phone/ingest";
import { computerName, touchPairing, type Pairing } from "@/lib/phone/pairing";
import { HelloRequestSchema, SlideRequestSchema, SyncRequestSchema } from "@/lib/phone/schema";
import { buildSnapshot } from "@/lib/phone/snapshot";
import { cropPng, phoneJpeg, slidePng } from "@/lib/slides";

/** What a request from the phone gets back, before it is sealed. */
export type PhoneReply =
  | { kind: "json"; value: unknown }
  | { kind: "image"; bytes: Buffer };

const fail = (error: string): PhoneReply => ({ kind: "json", value: { ok: false, error } });

/** Hello: the phone checks it can reach this computer, and says what it is called. */
export async function handleHello(pairing: Pairing, body: unknown): Promise<PhoneReply> {
  const parsed = HelloRequestSchema.safeParse(body);
  if (parsed.success) await touchPairing(pairing.id, { deviceName: parsed.data.device.name });
  return { kind: "json", value: { ok: true, computer: computerName(), protocol: 1 } };
}

/**
 * Sync: take in what the phone did, then send back everything as it now stands.
 * Only what was taken in is acknowledged; the phone keeps the rest to send again.
 */
export async function handleSync(pairing: Pairing, body: unknown): Promise<PhoneReply> {
  const parsed = SyncRequestSchema.safeParse(body);
  if (!parsed.success) return fail("The phone sent something this computer can't read. Update both apps.");
  const { device, sittings, reviews } = parsed.data;

  const outcomes: SittingOutcome[] = [];
  const problems: string[] = [];
  for (const s of sittings) {
    try {
      outcomes.push(await ingestSitting(s));
    } catch (err) {
      // Not acknowledged: the phone sends it again next time.
      problems.push(`A sitting couldn't be saved: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const reviewOutcomes = await ingestReviews(reviews);
  await touchPairing(pairing.id, { deviceName: device?.name, synced: true });

  return {
    kind: "json",
    value: {
      ok: true,
      accepted: { sittings: outcomes.map((o) => o.id), reviews: reviewOutcomes.map((r) => r.id) },
      sittings: outcomes,
      reviews: reviewOutcomes.filter((r) => !r.saved),
      problems,
      snapshot: await buildSnapshot(),
    },
  };
}

/** One slide picture, as listed in the snapshot, sized for the phone. */
export async function handleSlide(_pairing: Pairing, body: unknown): Promise<PhoneReply> {
  const parsed = SlideRequestSchema.safeParse(body);
  if (!parsed.success) return fail("That picture request couldn't be read.");
  const { lectureId, ref } = parsed.data;
  const m = ref.match(/^(\d{1,4})(?:\?crop=([0-9.,]+))?$/);
  if (!m) return fail("That picture request couldn't be read.");
  const lecture = await prisma.lecture.findUnique({ where: { id: lectureId }, select: { id: true } });
  if (!lecture) return fail("That lecture is no longer on the computer.");
  let png = await slidePng(lecture.id, Number(m[1]));
  if (!png) return fail("There's no picture of that slide.");
  const crop = m[2] ? parseCrop(m[2]) : null;
  if (crop) png = await cropPng(png, crop);
  return { kind: "image", bytes: await phoneJpeg(png) };
}
