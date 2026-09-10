import { describe, expect, it } from "vitest";
import type { PrismaClient } from "db";
import type { Hex } from "viem";
import { makeStore } from "./store.js";

const EID = "0xabc" as Hex;

function fakePrisma(existingRows: number) {
  const created: unknown[][] = [];
  const prisma = {
    canon: {
      count: async () => existingRows,
      createMany: async ({ data }: { data: unknown[] }) => void created.push(data),
    },
  } as unknown as PrismaClient;
  return { prisma, created };
}

describe("appendCanon", () => {
  it("writes the event's lines when it has none", async () => {
    const f = fakePrisma(0);
    await makeStore(f.prisma).appendCanon("sports", EID, ["Northgate won.", "The cup stays."]);
    expect(f.created).toEqual([
      [
        { channelId: "sports", eventId: EID, text: "Northgate won." },
        { channelId: "sports", eventId: EID, text: "The cup stays." },
      ],
    ]);
  });

  it("writes nothing when the event already has canon rows — the CANON step re-ran", async () => {
    const f = fakePrisma(2);
    await makeStore(f.prisma).appendCanon("sports", EID, ["Northgate won."]);
    expect(f.created).toEqual([]);
  });
});
