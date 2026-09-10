import { describe, expect, it } from "vitest";
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, toFunctionSelector } from "viem";
import { arenaAbi } from "contracts/abi/Arena";
import { USDC, emptyStakes, makeRng, planBet, revertReason, seedFor, type PlannedBet } from "./bettor-plan.js";

const base = {
  nOutcomes: 3,
  minUsdc: 1,
  maxUsdc: 50,
  intervalMs: 1000,
  marginMs: 3000,
  yesBias: 0.5,
};

/** Drive the planner the way scripts/bettor.ts does: plan, book the stake, advance the clock.
 *  `costMs` is the chain time a bet costs on top of its planned delay (simulate + send + receipt). */
function run(
  seed: number,
  opts: Partial<typeof base> & { windowMs?: number; balances?: bigint[]; costMs?: number } = {},
) {
  const cfg = { ...base, ...opts };
  const rng = makeRng(seed);
  const stakes = emptyStakes(cfg.nOutcomes);
  const balances = opts.balances ?? Array.from({ length: 4 }, () => 1000n * USDC);
  const lockMs = 1_000_000 + (opts.windowMs ?? 60_000);
  let nowMs = 1_000_000;
  const bets: (PlannedBet & { atMs: number })[] = [];
  for (let guard = 0; guard < 5000; guard++) {
    const p = planBet({ ...cfg, rng, stakes, balances, nowMs, lockMs });
    if (!p) {
      if (nowMs >= lockMs - cfg.marginMs) break;
      nowMs += cfg.intervalMs;
      continue;
    }
    bets.push({ ...p, atMs: nowMs });
    stakes[p.outcomeIdx]![p.yes ? 1 : 0] += p.amount;
    balances[p.bettor]! -= p.amount;
    nowMs += p.delayMs + (opts.costMs ?? 0);
  }
  const covered = stakes.map((m) => m.map((s) => s > 0n));
  return { bets, stakes, covered, lockMs, cfg };
}

/** Arena.claim: a market is void unless the winning side holds `total / nOutcomes` of its pool. */
const paysBothWays = (m: bigint[], nOutcomes: number) =>
  m.every((side) => side * BigInt(nOutcomes) >= m[0]! + m[1]!);

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
      planBet({ ...base, rng: makeRng(1), stakes: emptyStakes(3), balances: [1000n * USDC], nowMs: lockMs - cfg.marginMs, lockMs }),
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
    const { bets, stakes } = run(77, { nOutcomes: 4, windowMs: 300_000 });
    const slots = new Set(bets.slice(0, 8).map((b) => `${b.outcomeIdx}${b.yes}`));
    expect(slots.size).toBe(8); // all 8 slots, no repeats
    expect(bets.length).toBeGreaterThan(8); // then volume
    for (const m of stakes) expect(paysBothWays(m, 4)).toBe(true);
  });

  // V2-02: two-sided was not enough — a 1 USDC side against a 50 USDC one is still void.
  it("leaves every market paying whichever way it lands, not just two-sided", () => {
    for (const nOutcomes of [2, 3, 5]) {
      for (const seed of [1, 2, 3, 42, 999]) {
        const { stakes } = run(seed, { nOutcomes, windowMs: 120_000 });
        for (const m of stakes) expect(paysBothWays(m, nOutcomes)).toBe(true);
      }
    }
  });

  it("covers a side that is late to the market at its share, not at the 1 USDC floor", () => {
    // the only empty side left faces 50 USDC across 3 outcomes, so it needs 50 / (3 - 1).
    const stakes = emptyStakes(3);
    stakes[0] = [0n, 50n * USDC];
    stakes[1] = [7n * USDC, 7n * USDC];
    stakes[2] = [7n * USDC, 7n * USDC];
    const p = planBet({ ...base, rng: makeRng(4), stakes, balances: [1000n * USDC], nowMs: 0, lockMs: 60_000 });
    expect(p).toMatchObject({ outcomeIdx: 0, yes: false });
    expect(p!.amount).toBeGreaterThanOrEqual(25n * USDC);
    stakes[0]![0] += p!.amount;
    expect(paysBothWays(stakes[0]!, 3)).toBe(true);
  });

  it("finishes a half-covered market before opening a virgin one", () => {
    for (const seed of [1, 2, 3, 42, 999]) {
      const stakes = emptyStakes(4);
      stakes[2] = [0n, 30n * USDC]; // market 2 opened on YES; markets 0, 1 and 3 untouched
      const p = planBet({ ...base, nOutcomes: 4, rng: makeRng(seed), stakes, balances: [1000n * USDC], nowMs: 0, lockMs: 60_000 });
      expect(p).toMatchObject({ outcomeIdx: 2, yes: false });
    }
  });

  // V2-01 made writes cheap; this is what the planner owes when they are not. A window that runs
  // out mid-coverage must leave refunds behind on at most the one market it had just opened.
  it("leaves at most one half-covered market when the window runs out mid-coverage", () => {
    for (const seed of [1, 2, 3, 42, 999]) {
      const { stakes } = run(seed, { nOutcomes: 5, windowMs: 15_000, intervalMs: 1500, costMs: 2000 });
      const half = stakes.filter((m) => (m[0]! > 0n) !== (m[1]! > 0n));
      expect(half.length).toBeLessThanOrEqual(1);
      for (const m of stakes) if (m[0]! > 0n && m[1]! > 0n) expect(paysBothWays(m, 5)).toBe(true);
    }
  });

  it("splits YES and NO near evenly across events, with only a per-event lean", () => {
    let yes = 0;
    let total = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const rng = makeRng(seed);
      const { bets } = run(seed, { nOutcomes: 4, windowMs: 60_000, yesBias: 0.25 + rng() * 0.5 });
      yes += bets.filter((b) => b.yes).length;
      total += bets.length;
    }
    expect(total).toBeGreaterThan(200);
    expect(yes / total).toBeGreaterThan(0.4);
    expect(yes / total).toBeLessThan(0.6);
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

  // V2-04: a revert on the send path carries no ABI, so viem prints the bare selector.
  it("decodes a bare 4-byte selector from the send path", () => {
    const sent = new BaseError(
      'The contract function "bet" reverted with the following signature:\n0x61c54c4a',
    );
    expect(revertReason(sent)).toBe("BettingClosed");
    expect(revertReason(new Error(`reverted: ${toFunctionSelector("NothingToClaim()")}`))).toBe("NothingToClaim");
  });

  it("leaves addresses and hashes alone when there is no selector", () => {
    expect(revertReason(new BaseError("nonce too low", { metaMessages: ["from: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"] })))
      .toBe("nonce too low");
  });

  it("falls back to shortMessage, then to the string", () => {
    expect(revertReason(new BaseError("boom"))).toBe("boom");
    expect(revertReason(new Error("plain"))).toBe("Error: plain");
    expect(revertReason("nope")).toBe("nope");
  });
});
