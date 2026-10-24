import { parseCrop } from "@/lib/markdown";
import { cropPng, slidePng } from "@/lib/slides";

export const dynamic = "force-dynamic";

/** One slide of a lecture as a picture, for the summary. Rendered on first request. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string; n: string }> }) {
  const { id, n } = await ctx.params;
  const slide = Number(n);
  if (!Number.isInteger(slide) || slide < 1) return new Response("No such slide.", { status: 404 });
  let png: Buffer | null;
  try {
    png = await slidePng(id, slide);
    // ?crop=x,y,w,h — the part the student cropped it to, as fractions of the slide.
    const crop = parseCrop(new URL(request.url).searchParams.get("crop"));
    if (png && crop) png = await cropPng(png, crop);
  } catch (err) {
    console.error(`slide ${slide} of lecture ${id} could not be drawn:`, err);
    return new Response("That slide could not be drawn.", { status: 500 });
  }
  if (!png) return new Response("No picture of that slide.", { status: 404 });
  return new Response(new Uint8Array(png), {
    // A slide never changes under the same lecture and number unless decks are
    // added, so a day's caching is safe and makes a long summary scroll smoothly.
    headers: { "content-type": "image/png", "cache-control": "private, max-age=86400" },
  });
}
