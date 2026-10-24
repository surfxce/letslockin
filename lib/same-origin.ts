/** For routes that change things: only Lockin's own pages may call them. */
export function fromLockin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  if (site && site !== "same-origin") return false;
  try {
    return !origin || new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}
