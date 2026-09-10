import { describe, expect, it } from "vitest";
import { BaseError, ContractFunctionRevertedError, encodeErrorResult } from "viem";
import { arenaAbi } from "contracts/abi/Arena";
import { USDC, emptyCoverage, makeRng, planBet, revertReason, seedFor, type PlannedBet } from "./bettor-plan.js";

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

  // V1-01: a short window used to leave markets one-sided, i.e. void under Arena.claim.
  it("still covers every side in a window far shorter than BET_INTERVAL_MS x slots", () => {
    for (const seed of [1, 2, 3, 42, 999]) {
      const { bets, covered } = run(seed, { nOutcomes: 5, windowMs: 9_000, intervalMs: 3000 });
      expect(covered.every((m) => m[0] && m[1])).toBe(true);
      // 10 slots at the configured 3 s interval would need 30 s; the plan fits them in 6 s.
      expect(bets.slice(0, 10).every((b) => b.delayMs < 3000)).toBe(true);
    }
  });

  it("spends the first bets on coverage, not on volume", () => {
    const { bets } = run(77, { nOutcomes: 4, windowMs: 300_000 });
    const slots = new Set(bets.slice(0, 8).map((b) => `${b.outcomeIdx}${b.yes}`));
    expect(slots.size).toBe(8); // all 8 slots, no repeats
    for (const b of bets.slice(0, 8)) expect(b.amount).toBe(1n * USDC);
    expect(bets.slice(8).some((b) => b.amount > 1n * USDC)).toBe(true); // then volume
  });

  it("never schedules faster than 200 ms", () => {
    const { bets } = run(9, { nOutcomes: 5, windowMs: 3_100, intervalMs: 3000 });
    for (const b of bets) expect(b.delayMs).toBeGreaterThanOrEqual(200);
  });
});

describe("revertReason", () => {
  // V1-06: viem's shortMessage alone cannot tell an expected NothingToClaim from a real failure.
  const reverted = (errorName: "NothingToClaim" | "BettingClosed") =>
    new BaseError("The contract function \"claim\" reverted.", {
      cause: new ContractFunctionRevertedError({
        abi: arenaAbi,
        functionName: "claim",
        data: encodeErrorResult({ abi: arenaAbi, errorName }),
      }),
    });

  it("names the custom error", () => {
    expect(revertReason(reverted("NothingToClaim"))).toBe("NothingToClaim");
    expect(revertReason(reverted("BettingClosed"))).toBe("BettingClosed");
  });

  it("falls back to shortMessage, then to the string", () => {
    expect(revertReason(new BaseError("boom"))).toBe("boom");
    expect(revertReason(new Error("plain"))).toBe("Error: plain");
    expect(revertReason("nope")).toBe("nope");
  });
});
