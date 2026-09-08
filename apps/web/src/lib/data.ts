import { prisma } from "./prisma";
import { toPublic, type EventPublic } from "./public";

export type ChannelPublic = { id: string; name: string; current: EventPublic | null; canon: string[] };

/** States where an event is on air. Anything else is either unborn or archive. */
const LIVE = ["BETTING", "LOCKED", "RESOLVE", "REVEAL", "CANON", "PAUSE"];

// Broadcast order of the wall; anything the engine adds later lands after these.
const ORDER = ["sports", "politics", "culture", "region"];
const rank = (id: string) => (ORDER.indexOf(id) + 1 || ORDER.length + 1) - 1;

export async function getChannels(): Promise<ChannelPublic[]> {
  const channels = await prisma.channel.findMany();
  const out = await Promise.all(
    channels.map(async (c) => {
      // Nothing live: the wall replays the last finished event so the world never looks dead.
      const current =
        (await prisma.event.findFirst({
          where: { channelId: c.id, state: { in: LIVE } },
          orderBy: { seq: "desc" },
        })) ??
        (await prisma.event.findFirst({ where: { channelId: c.id, state: "DONE" }, orderBy: { seq: "desc" } }));
      const canon = await prisma.canon.findMany({
        where: { channelId: c.id },
        orderBy: { createdAt: "desc" },
        take: 5,
      });
      return {
        id: c.id,
        name: c.name,
        current: current ? toPublic(current) : null,
        canon: canon.reverse().map((l) => l.text),
      };
    }),
  );
  return out.sort((a, b) => rank(a.id) - rank(b.id));
}

export async function getEvent(id: string): Promise<EventPublic | null> {
  const row = await prisma.event.findUnique({ where: { id } });
  return row ? toPublic(row) : null;
}

export async function getEvents(opts: { channel?: string; limit?: number }): Promise<EventPublic[]> {
  const rows = await prisma.event.findMany({
    where: {
      ...(opts.channel ? { channelId: opts.channel } : {}),
      state: { notIn: ["RENDER", "READY", "SKIPPED"] },
    },
    orderBy: [{ createdAt: "desc" }],
    take: Math.min(Math.max(opts.limit ?? 20, 1), 100),
  });
  return rows.map(toPublic);
}

/** Viewer presence: the engine only authors new events while somebody is watching. */
export async function heartbeat(): Promise<void> {
  const lastSeenAt = new Date();
  await prisma.world.upsert({ where: { id: 1 }, create: { id: 1, doc: {}, lastSeenAt }, update: { lastSeenAt } });
}
