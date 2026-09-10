import { describe, expect, it } from "vitest";
import { USDC, emptyCoverage, makeRng, planBet, seedFor, type PlannedBet } from "./bettor-plan.js";

const base = {
  nOutcomes: 3,
  minUsdc: 1,
  maxUsdc: 50,
  intervalMs: 1000,
  marginMs: 3000,
  yesBias: 0.5,
};

/** Drive the planner the way scripts/bettor.ts does: plan, mark covered, advance the clock. */
function run(seed: number, opts: Partial<typeof base> & { windowMs?: number; balances?: bigint[] } = {}) {
  const cfg = { ...base, ...opts };
  const rng = makeRng(seed);
  const covered = emptyCoverage(cfg.nOutcomes);
  const balances = opts.balances ?? Array.from({ length: 4 }, () => 1000n * USDC);
  const lockMs = 1_000_000 + (opts.windowMs ?? 60_000);
  let nowMs = 1_000_000;
  const bets: (PlannedBet & { atMs: number })[] = [];
  for (let guard = 0; guard < 5000; guard++) {
    const p = planBet({ ...cfg, rng, covered, balances, nowMs, lockMs });
    if (!p) {
      if (nowMs >= lockMs - cfg.marginMs) break;
      nowMs += cfg.intervalMs;
      continue;
    }
    bets.push({ ...p, atMs: nowMs });
    covered[p.outcomeIdx]![p.yes ? 1 : 0] = true;
    balances[p.bettor]! -= p.amount;
    nowMs += p.delayMs;
  }
  return { bets, covered, lockMs, cfg };
}

describe("planBet", () => {
  it("keeps amounts inside [max(BET_MIN, 1 USDC), min(BET_MAX, balance)]", () => {
    const { bets } = run(7, { minUsdc: 5, maxUsdc: 20 });
    expect(bets.length).toBeGreaterThan(10);
    for (const b of bets) {
      expect(b.amount).toBeGreaterThanOrEqual(5n * USDC);
      expect(b.amount).toBeLessThanOrEqual(20n * USDC);
      expect(b.amount % USDC).toBe(0n);
    }
  });

  it("never bets below Arena's 1 USDC floor even when BET_MIN_USDC is silly", () => {
    const { bets } = run(11, { minUsdc: 0 });
    for (const b of bets) expect(b.amount).toBeGreaterThanOrEqual(1n * USDC);
  });

  it("never bets more than the bettor holds, and sits a broke bettor out", () => {
    const balances = [3n * USDC, 1000n * USDC];
    const { bets } = run(3, { balances, minUsdc: 10, maxUsdc: 50 });
    expect(bets.length).toBeGreaterThan(0);
    // the 3 USDC account cannot meet the 10 USDC floor, so it is never picked
    expect(bets.some((b) => b.bettor === 0)).toBe(false);
  });

  it("covers YES and NO of every market when there are ticks to spare", () => {
    for (const seed of [1, 2, 3, 42, 999]) {
      const { covered } = run(seed, { nOutcomes: 5, windowMs: 120_000 });
      expect(covered.every((m) => m[0] && m[1])).toBe(true);
    }
  });

  it("schedules nothing at or after lockTime minus the margin", () => {
    const { bets, lockMs, cfg } = run(5, { windowMs: 20_000 });
    expect(bets.length).toBeGreaterThan(0);
    for (const b of bets) expect(b.atMs).toBeLessThan(lockMs - cfg.marginMs);
    expect(
      planBet({ ...base, rng: makeRng(1), covered: emptyCoverage(3), balances: [1000n * USDC], nowMs: lockMs - cfg.marginMs, lockMs }),
    ).toBeNull();
  });

  it("replays identically from the same seed and differs on another", () => {
    const a = run(1234).bets;
    const b = run(1234).bets;
    const c = run(1235).bets;
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("gives every event id its own stream", () => {
    expect(seedFor(1, "0xaa")).not.toBe(seedFor(1, "0xab"));
    expect(seedFor(1, "0xaa")).toBe(seedFor(1, "0xaa"));
  });
});
