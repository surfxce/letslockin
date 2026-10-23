import { revalidatePath } from "next/cache";

import { readApkg } from "@/lib/flashcards/anki";
import { importAnki } from "@/lib/flashcards/manual";
import { fromLockin } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

const MAX_BYTES = 400 * 1024 * 1024;

/** An Anki package (.apkg) as the raw request body, into the deck of ?lecture=<id>. */
export async function POST(request: Request) {
  if (!fromLockin(request)) return Response.json({ error: "Not allowed." }, { status: 403 });
  const lectureId = new URL(request.url).searchParams.get("lecture") ?? "";
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES) {
    return Response.json({ error: "That package is too big (400 MB at most)." }, { status: 413 });
  }
  try {
    const pkg = await readApkg(new Uint8Array(await request.arrayBuffer()));
    const result = await importAnki(lectureId, pkg);
    revalidatePath("/ak", "layout");
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Couldn't import that package." }, { status: 400 });
  }
}
