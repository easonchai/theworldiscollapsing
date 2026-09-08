import { describe, expect, it } from "vitest";
import type { EventPublic } from "./public";
import { sourceFor } from "./playback";

const event = (over: Partial<EventPublic>): EventPublic =>
  ({
    state: "BETTING",
    firstHalfUrl: "http://media/first.mp4",
    winningBranchUrl: null,
    startTime: "2026-09-09T10:00:00.000Z",
    revealTime: null,
    ...over,
  }) as EventPublic;

describe("sourceFor", () => {
  it("syncs a live first half to the on-chain start time", () => {
    expect(sourceFor(event({}))).toEqual({
      src: "http://media/first.mp4",
      t0: Date.parse("2026-09-09T10:00:00.000Z"),
      archive: false,
    });
  });

  it("syncs the winning branch to the reveal time", () => {
    const e = event({ state: "REVEAL", winningBranchUrl: "http://media/branch-1.mp4", revealTime: "2026-09-09T10:01:00.000Z" });
    expect(sourceFor(e)).toEqual({
      src: "http://media/branch-1.mp4",
      t0: Date.parse("2026-09-09T10:01:00.000Z"),
      archive: false,
    });
  });

  it("replays a DONE event from the top instead of seeking past its end", () => {
    const e = event({ state: "DONE", winningBranchUrl: "http://media/branch-1.mp4", revealTime: "2026-09-09T10:01:00.000Z" });
    expect(sourceFor(e)).toEqual({ src: "http://media/branch-1.mp4", t0: null, archive: true });
  });

  it("has no clock to follow when the time is missing", () => {
    expect(sourceFor(event({ startTime: null })).t0).toBeNull();
    expect(sourceFor(event({ state: "REVEAL", winningBranchUrl: "http://media/branch-0.mp4" })).t0).toBeNull();
  });
});
