import { describe, expect, it } from "vitest";
import { marketPayout, previewPayout } from "./chain";

// The numbers are lifted from packages/contracts/test/Arena.t.sol: this file exists to keep the
// mirror honest, so if Arena.claim's void rule moves, one of these fails before a viewer is quoted
// a payout the chain will not pay.

describe("marketPayout", () => {
  it("voids a market whose winning side is under its 1/nOutcomes share (the MIN_BET sweep)", () => {
    const pool = [25_000_000n, 1_000_000n] as const; // 25 NO from the crowd, 1 YES from the sweep
    // Winning market: 1 of 26 USDC is under a fifth, so both sides take their own stake back.
    expect(marketPayout([0n, 1_000_000n], pool, true, 5)).toBe(1_000_000n);
    expect(marketPayout([25_000_000n, 0n], pool, true, 5)).toBe(25_000_000n);
    // The four the sweep missed pay the crowd normally, and pay the sweep nothing.
    expect(marketPayout([25_000_000n, 0n], pool, false, 5)).toBe(25_480_000n);
    expect(marketPayout([0n, 1_000_000n], pool, false, 5)).toBe(0n);
  });

  it("pays a winning side holding exactly its share, and voids it a hair below", () => {
    expect(marketPayout([0n, 10_000_000n], [30_000_000n, 10_000_000n], true, 4)).toBe(39_200_000n);
    expect(marketPayout([0n, 10_000_000n], [30_000_004n, 10_000_000n], true, 4)).toBe(10_000_000n);
  });

  it("pays nothing to a loser and nothing on a market nobody staked", () => {
    expect(marketPayout([7_000_000n, 0n], [7_000_000n, 10_000_000n], true, 2)).toBe(0n);
    expect(marketPayout([0n, 0n], [0n, 0n], true, 3)).toBe(0n);
  });
});

describe("previewPayout", () => {
  it("quotes the stake back when the bet would leave the side under its share", () => {
    expect(previewPayout(1_000_000n, true, [25_000_000n, 0n], 5)).toBe(1_000_000n);
  });

  it("quotes winner-take-all once the bet is big enough to carry the market", () => {
    expect(previewPayout(10_000_000n, true, [25_000_000n, 0n], 5)).toBe(34_300_000n);
  });
});
