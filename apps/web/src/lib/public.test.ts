import { describe, expect, it } from "vitest";
import type { Event } from "db";
import { toPublic } from "./public";

const row = (over: Partial<Event> = {}): Event =>
  ({
    id: "0xfeed",
    channelId: "sports",
    seq: 3,
    state: "BETTING",
    title: "Matchday 3",
    premise: "Level at half time.",
    outcomes: ["United win", "Chelsea win", "Draw"],
    script: { ticker: ["Old Trafford sold out"], firstHalf: [{ prompt: "kickoff", seconds: 6 }] },
    reasoning: "thinking",
    firstHalfUrl: "http://media/first.mp4",
    branchUrls: ["http://media/branch-0.mp4", "http://media/branch-1.mp4", "http://media/branch-2.mp4"],
    lockTime: new Date("2026-09-09T10:00:00.000Z"),
    drandRound: 32027892n,
    startTime: new Date("2026-09-09T09:59:00.000Z"),
    revealTime: null,
    outcome: null,
    signature: null,
    createTx: "0xcreate",
    resolveTx: null,
    costUsd: 2.4,
    renderAttempts: 0,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as Event;

describe("toPublic", () => {
  it("never leaks branch urls before reveal", () => {
    for (const state of ["RENDER", "READY", "BETTING", "LOCKED", "RESOLVE"]) {
      // outcome set too: a race between resolve and the state write must still not leak.
      const pub = toPublic(row({ state, outcome: 1 }));
      expect(pub.winningBranchUrl).toBeNull();
      expect(JSON.stringify(pub)).not.toContain("branch-");
    }
  });

  it("serves only the winning branch once resolved", () => {
    for (const state of ["REVEAL", "CANON", "PAUSE", "DONE"]) {
      const pub = toPublic(row({ state, outcome: 2, revealTime: new Date("2026-09-09T10:00:20.000Z") }));
      expect(pub.winningBranchUrl).toBe("http://media/branch-2.mp4");
      expect(JSON.stringify(pub)).not.toContain("branch-0");
      expect(JSON.stringify(pub)).not.toContain("branch-1");
    }
  });

  it("withholds the branch when the outcome is not known yet", () => {
    expect(toPublic(row({ state: "REVEAL", outcome: null })).winningBranchUrl).toBeNull();
  });

  it("exposes ticker from the script and serialises chain-shaped fields as strings", () => {
    const pub = toPublic(row());
    expect(pub.ticker).toEqual(["Old Trafford sold out"]);
    expect(pub.drandRound).toBe("32027892");
    expect(pub.lockTime).toBe("2026-09-09T10:00:00.000Z");
    expect(Object.keys(pub)).not.toContain("script");
    expect(Object.keys(pub)).not.toContain("branchUrls");
    expect(Object.keys(pub)).not.toContain("error");
  });
});
