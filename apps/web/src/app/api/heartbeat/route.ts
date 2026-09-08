import { heartbeat } from "@/lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  await heartbeat();
  return new Response(null, { status: 204 });
}
