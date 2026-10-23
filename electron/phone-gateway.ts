/**
 * The door a paired iPhone comes in by. Lockin's own server only listens on this
 * computer (127.0.0.1); this listens on the local network, but only while a phone is
 * paired, and passes on exactly five requests — POST /v1/hello, /v1/sync, /v1/slide, /v1/viva,
 * /v1/handwriting —
 * to the server's /api/phone/v1/… routes, untouched. Everything in them is sealed with
 * the pairing's key (lib/phone/protocol.ts), so this needs no secrets of its own; it
 * never reads the database and holds no keys.
 *
 * Electron's main process runs it; from the repo, `npm run phone` does.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const OPS = new Set(["hello", "sync", "slide", "viva", "handwriting"]);
const MAX_BYTES = 20 * 1024 * 1024;
const POLL_MS = 3000;

export interface PhoneGateway {
  stop(): void;
}

export function startPhoneGateway(opts: {
  /** Where Lockin's own server listens, on 127.0.0.1. */
  serverPort: number;
  /** Where phones reach this computer: LOCKIN_PHONE_PORT, 47821 by default. */
  phonePort: number;
  log?: (message: string) => void;
}): PhoneGateway {
  const log = opts.log ?? ((m: string) => console.log(`[phone] ${m}`));
  let server: Server | null = null;
  let state = "off";
  let stopped = false;
  /** When listening last failed: retried every half minute, not every check. */
  let failedAt = 0;

  function forward(op: string, req: IncomingMessage, res: ServerResponse) {
    const pairing = String(req.headers["x-lockin-pairing"] ?? "");
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(pairing)) {
      res.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      const body = Buffer.concat(chunks);
      const upstream = httpRequest(
        {
          host: "127.0.0.1",
          port: opts.serverPort,
          method: "POST",
          path: `/api/phone/v1/${op}`,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(body.length),
            "x-lockin-pairing": pairing,
          },
          timeout: 180_000,
        },
        (up) => {
          const headers: Record<string, string> = { "content-type": String(up.headers["content-type"] ?? "application/octet-stream") };
          if (up.headers["x-lockin-type"]) headers["x-lockin-type"] = String(up.headers["x-lockin-type"]);
          res.writeHead(up.statusCode ?? 502, headers);
          up.pipe(res);
        },
      );
      upstream.on("timeout", () => upstream.destroy(new Error("timed out")));
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(503, { "content-type": "text/plain" });
        res.end("Lockin is still starting on the computer. Try again in a moment.");
      });
      upstream.end(body);
    });
  }

  function handle(req: IncomingMessage, res: ServerResponse) {
    // Only the exact paths: nothing else of Lockin's server is reachable from the network.
    const match = /^\/v1\/([a-z]+)$/.exec(req.url ?? "");
    if (req.method !== "POST" || !match || !OPS.has(match[1])) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found.");
      return;
    }
    forward(match[1], req, res);
  }

  function listen() {
    const s = createServer(handle);
    s.headersTimeout = 10_000;
    s.requestTimeout = 200_000;
    s.on("error", (err: NodeJS.ErrnoException) => {
      state =
        err.code === "EADDRINUSE"
          ? `error: port ${opts.phonePort} is in use by another app`
          : `error: ${err.message}`;
      log(state);
      failedAt = Date.now();
      server = null;
      s.close();
    });
    s.listen(opts.phonePort, "0.0.0.0", () => {
      state = "listening";
      log(`listening for phones on port ${opts.phonePort}`);
    });
    server = s;
  }

  function close() {
    server?.close();
    server = null;
    state = "off";
    log("stopped listening for phones");
  }

  async function check() {
    if (stopped) return;
    try {
      const query = `gateway=${encodeURIComponent(state)}&port=${opts.phonePort}`;
      const res = await fetch(`http://127.0.0.1:${opts.serverPort}/api/phone/status?${query}`, {
        signal: AbortSignal.timeout(5000),
      });
      const { enabled } = (await res.json()) as { enabled?: boolean };
      // After a failure (port in use), try again on the next check rather than giving up.
      if (enabled && !server && Date.now() - failedAt > 30_000) listen();
      else if (!enabled && server) close();
    } catch {
      // The server isn't up yet, or is restarting: ask again shortly.
    } finally {
      if (!stopped) timer = setTimeout(() => void check(), POLL_MS);
    }
  }

  let timer: NodeJS.Timeout = setTimeout(() => void check(), 500);
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      server?.close();
      server = null;
    },
  };
}
