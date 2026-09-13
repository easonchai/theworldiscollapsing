import { heartbeat } from "@/lib/data";
import { heartbeatLimit, presenceCeiling } from "@/lib/limits";
import { clientIp, sameOrigin } from "@/lib/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Presence. This boolean is the only thing standing between an idle station and a machine that
 * spends money on video, so it is accepted only from our own pages and only once per client per
 * 10 s. `clientIp` reads a header the caller sends, so `heartbeatLimit` alone caps nothing against a
 * client that rotates it; `presenceCeiling` caps the total writes regardless of key. A throttled or
 * capped beat still answers 204: the browser beats on a 30 s timer and must not learn to retry, and
 * a caller must not be able to measure either limit.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  if (heartbeatLimit.take(clientIp(request)) && presenceCeiling.take()) await heartbeat();
  return new Response(null, { status: 204 });
}
