import { prisma } from "@/lib/db";
import { readCardImage } from "@/lib/flashcards/images";
import { parseCrop } from "@/lib/markdown";
import { ingestExam, ingestReviews, ingestSitting, ingestViva, type SittingOutcome } from "@/lib/phone/ingest";
import { computerName, touchPairing, type Pairing } from "@/lib/phone/pairing";
import { HandwritingRequestSchema, HelloRequestSchema, SlideRequestSchema, SyncRequestSchema, VivaTurnRequestSchema } from "@/lib/phone/schema";
import { relayHandwriting } from "@/lib/handwriting/service";
import { buildSnapshot } from "@/lib/phone/snapshot";
import { cropPng, phoneJpeg, slidePng } from "@/lib/slides";
import { relayVivaTurn } from "@/lib/viva/service";

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
  const { device, sittings, reviews, exams, vivas } = parsed.data;

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
  const examsTaken: string[] = [];
  for (const e of exams) {
    try {
      examsTaken.push((await ingestExam(e)).id);
    } catch (err) {
      problems.push(`An exam couldn't be saved: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const vivasTaken: string[] = [];
  for (const v of vivas) {
    try {
      vivasTaken.push((await ingestViva(v)).id);
    } catch (err) {
      problems.push(`A viva couldn't be saved: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await touchPairing(pairing.id, { deviceName: device?.name, synced: true });

  return {
    kind: "json",
    value: {
      ok: true,
      accepted: { sittings: outcomes.map((o) => o.id), reviews: reviewOutcomes.map((r) => r.id), exams: examsTaken, vivas: vivasTaken },
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
  const card = /^card\/([a-f0-9]{24}\.(?:png|jpg|webp|gif))$/.exec(ref);
  if (card) {
    // Only a picture one of this lecture's cards shows.
    const shown = await prisma.flashcard.findFirst({
      where: { lectureId, OR: [{ front: { contains: card[1] } }, { back: { contains: card[1] } }] },
      select: { id: true },
    });
    const image = shown ? await readCardImage(card[1]) : null;
    if (!image) return fail("That card's picture is no longer on the computer.");
    return { kind: "image", bytes: await phoneJpeg(image.bytes) };
  }
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

/** The viva examiner's next line, for a phone holding a viva with this computer's AI. */
export async function handleViva(_pairing: Pairing, body: unknown): Promise<PhoneReply> {
  const parsed = VivaTurnRequestSchema.safeParse(body);
  if (!parsed.success) return fail("That viva request couldn't be read. Update both apps.");
  try {
    return { kind: "json", value: { ok: true, ...(await relayVivaTurn(parsed.data)) } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** A handwritten answer typed out by this computer's AI, for a phone that can't ask one itself. */
export async function handleHandwriting(_pairing: Pairing, body: unknown): Promise<PhoneReply> {
  const parsed = HandwritingRequestSchema.safeParse(body);
  if (!parsed.success) return fail("Those photos couldn't be read. Update both apps.");
  try {
    const photos = parsed.data.photos.map((p) => new Uint8Array(Buffer.from(p, "base64")));
    // Under the gateway's three minutes, so the phone hears why rather than a timeout.
    return { kind: "json", value: { ok: true, ...(await relayHandwriting(parsed.data.questionId, photos, 150_000)) } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
