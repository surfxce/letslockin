import { modelsPayload } from "@/lib/payloads";

export const dynamic = "force-dynamic";

/** What the model picker shows, polled while a download runs. */
export async function GET() {
  return Response.json(await modelsPayload(), { headers: { "Cache-Control": "no-store" } });
}
