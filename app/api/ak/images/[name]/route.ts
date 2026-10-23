import { readCardImage } from "@/lib/flashcards/images";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const image = await readCardImage(name);
  if (!image) return new Response("No such picture.", { status: 404 });
  return new Response(new Uint8Array(image.bytes), {
    // Every picture gets a new name, so one name never changes what it shows.
    headers: { "content-type": image.type, "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
  });
}
