// Pure planning for the synthetic bettors in scripts/bettor.ts: no chain, no clock, no I/O, so a
// run is reproducible from BETTOR_SEED alone and the interesting parts are unit-testable.

/** USDC has 6 decimals; every amount in here is in those micro-units. */
export const USDC = 1_000_000n;
/** Arena.MIN_BET — 1 USDC. */
export const MIN_BET_USDC = 1;

export type Rng = () => number;

/** mulberry32. Same seed, same sequence. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over the event id: each event gets its own stream, so concurrent events stay reproducible
 *  no matter what order the loop happens to reach them in. */
export function seedFor(seed: number, id: string): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < id.length; i++) {
    h = Math.imul((h ^ id.charCodeAt(i)) >>> 0, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** covered[outcomeIdx][side], side 0 = NO, 1 = YES — matches Arena's pools layout. */
export const emptyCoverage = (nOutcomes: number): boolean[][] =>
  Array.from({ length: nOutcomes }, () => [false, false]);

export type PlanInput = {
  rng: Rng;
  nOutcomes: number;
  covered: boolean[][];
  /** micro-USDC on hand, by bettor index. */
  balances: bigint[];
  nowMs: number;
  lockMs: number;
  /** stop this long before lockTime so a bet in flight cannot land on BettingClosed. */
  marginMs: number;
  minUsdc: number;
  maxUsdc: number;
  /** slowest gap between bets; the plan speeds up when the slots left do not fit at this pace. */
  intervalMs: number;
  /** P(YES) for this event, so the pools are not always symmetric. */
  yesBias: number;
};

export type PlannedBet = {
  bettor: number;
  outcomeIdx: number;
  yes: boolean;
  /** micro-USDC. */
  amount: bigint;
  /** wait this long before asking for the next bet. */
  delayMs: number;
};

/**
 * One bet, or null when none is possible right now (past the deadline, or nobody can afford the
 * floor). A market with an empty side is void under `Arena.claim`, so coverage comes first: every
 * uncovered (market, side) slot gets a floor bet before a tick is spent on volume, and the delay is
 * derived from the window so the slots still to fill actually fit inside it.
 */
export function planBet(i: PlanInput): PlannedBet | null {
  const deadline = i.lockMs - i.marginMs;
  if (i.nowMs >= deadline) return null;

  const floor = Math.max(MIN_BET_USDC, Math.floor(i.minUsdc));
  const ceiling = Math.max(floor, Math.floor(i.maxUsdc));
  const solvent: number[] = [];
  for (let b = 0; b < i.balances.length; b++) {
    if (i.balances[b] >= BigInt(floor) * USDC) solvent.push(b);
  }
  if (solvent.length === 0) return null;

  const uncovered: [number, number][] = [];
  for (let o = 0; o < i.nOutcomes; o++) {
    for (const side of [0, 1]) if (!i.covered[o]?.[side]) uncovered.push([o, side]);
  }
  const bettor = solvent[Math.floor(i.rng() * solvent.length)]!;
  const cap = Math.min(ceiling, Number(i.balances[bettor]! / USDC));
  let outcomeIdx: number;
  let yes: boolean;
  let whole: number;
  if (uncovered.length > 0) {
    // Coverage first, at the floor: a cheap bet on every empty side beats a fat bet on a void market.
    const [o, side] = uncovered[Math.floor(i.rng() * uncovered.length)]!;
    outcomeIdx = o;
    yes = side === 1;
    whole = floor;
  } else {
    outcomeIdx = Math.floor(i.rng() * i.nOutcomes);
    yes = i.rng() < i.yesBias;
    // log-uniform: small bets common, big ones rare.
    whole = Math.round(Math.exp(Math.log(floor) + i.rng() * (Math.log(cap) - Math.log(floor))));
  }
  const amount = BigInt(Math.min(cap, Math.max(floor, whole))) * USDC;

  // Cadence follows the work left, never slower than intervalMs: the +2 is the headroom the jitter
  // and the last uncovered slot need, and it is recomputed every call so a slow tick self-corrects.
  const pace = Math.min(i.intervalMs, (deadline - i.nowMs) / (uncovered.length + 2));
  const delayMs = Math.max(200, Math.round(pace * (0.6 + i.rng() * 0.8)));
  return { bettor, outcomeIdx, yes, amount, delayMs };
}

/**
 * viem buries the custom error name in the cause chain, so `shortMessage` alone renders an expected
 * `NothingToClaim` as the same bare "reverted" sentence as a real failure.
 */
export function revertReason(e: unknown): string {
  const err = e as { walk?: (fn: (x: unknown) => boolean) => unknown; shortMessage?: string };
  const reverted = err?.walk?.((x) => (x as { name?: string })?.name === "ContractFunctionRevertedError") as
    | { data?: { errorName?: string }; reason?: string }
    | null
    | undefined;
  return reverted?.data?.errorName ?? reverted?.reason ?? err?.shortMessage ?? String(e).slice(0, 120);
}
