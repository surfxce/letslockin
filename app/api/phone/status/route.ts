import { reportGateway } from "@/lib/phone/gateway-state";
import { listPairings } from "@/lib/phone/pairing";

export const dynamic = "force-dynamic";

/**
 * Asked every few seconds by the desktop app's phone gateway, from this computer only:
 * it says how it is doing, and learns whether to listen — only while a phone is paired.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const port = Number(url.searchParams.get("port"));
  reportGateway(url.searchParams.get("gateway") ?? "off", Number.isInteger(port) && port > 0 ? port : null);
  return Response.json({ enabled: (await listPairings()).length > 0 });
}
