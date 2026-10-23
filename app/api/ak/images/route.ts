import { MAX_CARD_IMAGE_BYTES, saveCardImage } from "@/lib/flashcards/images";

export const dynamic = "force-dynamic";

/** A picture for a card, sent as the raw request body. Only from Lockin's own pages. */
export async function POST(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  if ((site && site !== "same-origin") || (origin && new URL(origin).host !== request.headers.get("host"))) {
    return Response.json({ error: "Not allowed." }, { status: 403 });
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_CARD_IMAGE_BYTES) {
    return Response.json({ error: "That picture is too big (15 MB at most)." }, { status: 413 });
  }
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    return Response.json(await saveCardImage(bytes));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Couldn't save that picture." }, { status: 400 });
  }
}
