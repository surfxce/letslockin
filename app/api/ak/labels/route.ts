import { findLabels } from "@/lib/labels";
import { MAX_CARD_IMAGE_BYTES, sniffImage } from "@/lib/flashcards/images";
import { fromLockin } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/** Where the labels are on any picture, sent as the raw request body. */
export async function POST(request: Request) {
  if (!fromLockin(request)) return Response.json({ error: "Not allowed." }, { status: 403 });
  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.length > MAX_CARD_IMAGE_BYTES || !sniffImage(bytes)) return Response.json({ error: "That isn't a picture Lockin can read." }, { status: 400 });
  try {
    return Response.json({ labels: await findLabels(bytes) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Couldn't read that picture." }, { status: 500 });
  }
}
