import { describe, expect, it } from "vitest";
import type { EventPublic } from "./public";
import { tickerLines } from "./ticker";

const event = (over: Partial<EventPublic> = {}): EventPublic =>
  ({
    state: "BETTING",
    ticker: ["SPORTS DESK LIVE"],
    outcomes: ["United win", "Chelsea win", "Draw"],
    ...over,
  }) as EventPublic;

describe("tickerLines", () => {
  it("adds the countdown and the implied odds to the authored straps", () => {
    const lines = tickerLines(
      event(),
      [
        [30n, 70n],
        [50n, 50n],
        [0n, 0n],
      ],
      "0:12",
    );
    expect(lines).toEqual([
      "SPORTS DESK LIVE",
      "BETTING CLOSES IN 0:12",
      "United win — YES 70%",
      "Chelsea win — YES 50%",
      "Draw — YES NO BETS YET",
    ]);
  });

  it("falls back to the authored straps before the first chain poll lands", () => {
    expect(tickerLines(event(), null, null)).toEqual(["SPORTS DESK LIVE"]);
  });
});
