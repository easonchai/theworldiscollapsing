import { describe, expect, it } from "vitest";
import type { EventPublic, StudioCard } from "./public";
import { CARD_MS, cardAt, sourceFor } from "./playback";

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

describe("cardAt", () => {
  const cards: StudioCard[] = [
    { at: 13, title: "Half time", stats: ["Possession 51-49"] },
    { at: 28, title: "Form guide", stats: ["W W D"] },
  ];

  it("shows nothing before the first cue", () => {
    expect(cardAt(cards, 0)).toBeNull();
    expect(cardAt(cards, 12_999)).toBeNull();
  });

  it("holds a card from its cue for CARD_MS, then clears it", () => {
    expect(cardAt(cards, 13_000)?.title).toBe("Half time");
    expect(cardAt(cards, 13_000 + CARD_MS - 1)?.title).toBe("Half time");
    expect(cardAt(cards, 13_000 + CARD_MS)).toBeNull();
  });

  it("cues each card off its own shot boundary", () => {
    expect(cardAt(cards, 28_100)?.title).toBe("Form guide");
    expect(cardAt([], 28_100)).toBeNull();
  });
});
