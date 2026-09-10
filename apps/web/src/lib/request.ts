const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

/**
 * Is this request the station's own page talking to itself? `Sec-Fetch-Site` is set by the browser
 * and cannot be forged from script; `Origin` is the fallback for clients that do not send it. A
 * request carrying neither is not a page of ours, so it is refused.
 */
export function sameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("host") ?? hostOf(request.url);
  return !!host && hostOf(origin) === host;
}

/** Who is calling, as well as a proxied deployment can say. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
}
