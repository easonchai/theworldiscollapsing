import { getEvent } from "@/lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: RouteContext<"/api/events/[id]">) {
  const { id } = await ctx.params;
  const event = await getEvent(id);
  return event ? Response.json(event) : new Response("unknown event", { status: 404 });
}
