import type { NextRequest } from "next/server";
import { getEvents } from "@/lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const channel = request.nextUrl.searchParams.get("channel") ?? undefined;
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? "20");
  return Response.json(await getEvents({ channel, limit: Number.isFinite(limit) ? limit : 20 }));
}
