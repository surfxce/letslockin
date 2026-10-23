import { fromLockin } from "@/lib/same-origin";
import { naturalStatus, startNaturalDownload } from "@/lib/voice/natural";

export const dynamic = "force-dynamic";

/** Whether the natural voice is here, and how its download is going. */
export async function GET() {
  return Response.json(naturalStatus());
}

/** Starts downloading the natural voice. */
export async function POST(request: Request) {
  if (!fromLockin(request)) return Response.json({ error: "Not allowed." }, { status: 403 });
  try {
    return Response.json(startNaturalDownload());
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
