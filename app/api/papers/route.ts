import { revalidatePath } from "next/cache";

import { addPaper } from "@/lib/papers/service";
import { fromLockin } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/** A past paper (PDF, Word or text) as the raw request body, for ?course=<id>; its name in x-file-name. */
export async function POST(request: Request) {
  if (!fromLockin(request)) return Response.json({ error: "Not allowed." }, { status: 403 });
  if (Number(request.headers.get("content-length") ?? 0) > 80 * 1024 * 1024) {
    return Response.json({ error: "That file is too big (80 MB at most)." }, { status: 413 });
  }
  const courseId = new URL(request.url).searchParams.get("course") ?? "";
  const name = decodeURIComponent(request.headers.get("x-file-name") ?? "paper.pdf").slice(0, 200) || "paper.pdf";
  try {
    const bytes = await request.arrayBuffer();
    const id = await addPaper(courseId, new File([bytes], name));
    revalidatePath("/", "layout");
    return Response.json({ id });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Couldn't add that paper." }, { status: 400 });
  }
}
