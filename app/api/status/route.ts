import { statusPayload } from "@/lib/payloads";

export const dynamic = "force-dynamic";

/**
 * What the app is doing and what is due. Polled by the header in every window, and
 * by the desktop app's main process for notifications while no window is open.
 */
export async function GET() {
  return Response.json(await statusPayload(), { headers: { "Cache-Control": "no-store" } });
}
