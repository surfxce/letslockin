import { handwritingState, MAX_PHOTO_BYTES, queueHandwriting } from "@/lib/handwriting/service";
import { MAX_HANDWRITING_PAGES } from "@/lib/handwriting/schema";
import { fromLockin } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/** Photos of a handwritten answer (form fields `photo`, in page order) to one question. */
export async function POST(request: Request) {
  if (!fromLockin(request)) return Response.json({ error: "Not allowed." }, { status: 403 });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_PHOTO_BYTES * MAX_HANDWRITING_PAGES) {
    return Response.json({ error: "Those photos are too big together." }, { status: 413 });
  }
  try {
    const form = await request.formData();
    const questionId = String(form.get("questionId") ?? "");
    const photos = await Promise.all(
      form
        .getAll("photo")
        .filter((f): f is File => typeof f !== "string")
        .map(async (f) => new Uint8Array(await f.arrayBuffer())),
    );
    return Response.json({ jobId: await queueHandwriting(questionId, photos) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Couldn't take those photos." }, { status: 400 });
  }
}

/** How a reading is going: waiting, the text, or why it failed. */
export async function GET(request: Request) {
  if (!fromLockin(request)) return Response.json({ error: "Not allowed." }, { status: 403 });
  const jobId = new URL(request.url).searchParams.get("job") ?? "";
  return Response.json(await handwritingState(jobId));
}
