import { PrismaPg } from "@prisma/adapter-pg";
import type { Hex } from "viem";
import { Prisma, PrismaClient } from "./generated/prisma/client.js";
import type { Event as EventModel } from "./generated/prisma/client.js";
import type { Authored } from "./authored.js";
import type { EventRow, State, Store } from "./machine.js";

export const CHANNELS: Record<string, string> = {
  sports: "Sports",
  politics: "Politics",
  culture: "Culture",
  region: "Region",
};

export function makePrisma(url: string) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

const toRow = (e: EventModel): EventRow => ({
  ...e,
  id: e.id as Hex,
  state: e.state as State,
  outcomes: e.outcomes as string[],
  script: e.script as Authored,
  branchUrls: e.branchUrls as string[] | null,
  signature: e.signature as Hex | null,
  createTx: e.createTx as Hex | null,
  resolveTx: e.resolveTx as Hex | null,
});

// Prisma wants DbNull, not null, for nullable Json columns.
const data = (r: Partial<EventRow>) =>
  ({ ...r, branchUrls: r.branchUrls === null ? Prisma.DbNull : r.branchUrls }) as never;

export function makeStore(prisma: PrismaClient): Store & { ensureChannels(): Promise<void> } {
  return {
    async ensureChannels() {
      for (const [id, name] of Object.entries(CHANNELS)) {
        await prisma.channel.upsert({ where: { id }, create: { id, name }, update: {} });
      }
      await prisma.world.upsert({ where: { id: 1 }, create: { id: 1, doc: {} }, update: {} });
    },
    async openEvents(channelId) {
      const rows = await prisma.event.findMany({
        where: { channelId, state: { notIn: ["DONE", "SKIPPED"] } },
        orderBy: { seq: "asc" },
      });
      return rows.map(toRow);
    },
    async nextSeq(channelId) {
      const c = await prisma.channel.update({ where: { id: channelId }, data: { nextSeq: { increment: 1 } } });
      return c.nextSeq - 1;
    },
    async insert(row) {
      return toRow(await prisma.event.create({ data: data(row) }));
    },
    async update(id, patch) {
      return toRow(await prisma.event.update({ where: { id }, data: data(patch) }));
    },
    async canon(channelId, limit) {
      const rows = await prisma.canon.findMany({ where: { channelId }, orderBy: { createdAt: "desc" }, take: limit });
      return rows.reverse().map((r) => r.text);
    },
    async appendCanon(channelId, eventId, lines) {
      if (lines.length) await prisma.canon.createMany({ data: lines.map((text) => ({ channelId, eventId, text })) });
    },
    async lastSeenAt() {
      return (await prisma.world.findUnique({ where: { id: 1 } }))?.lastSeenAt ?? null;
    },
  };
}
