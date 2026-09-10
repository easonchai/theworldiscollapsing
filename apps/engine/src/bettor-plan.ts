// Pure planning for the synthetic bettors in scripts/bettor.ts: no chain, no clock, no I/O, so a
// run is reproducible from BETTOR_SEED alone and the interesting parts are unit-testable.
import { decodeErrorResult, type Hex } from "viem";
import { arenaAbi } from "contracts/abi/Arena";
import { gateAbi } from "contracts/abi/Gate";
import { mockusdcAbi } from "contracts/abi/MockUSDC";

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

/** stakes[outcomeIdx][side] in micro-USDC, side 0 = NO, 1 = YES — matches Arena's pools layout. */
export const emptyStakes = (nOutcomes: number): bigint[][] =>
  Array.from({ length: nOutcomes }, () => [0n, 0n]);

/**
 * `Arena.claim` voids a market whose winning side holds less than its `1/nOutcomes` share of the
 * pool (`p[win] * nOutcomes < total`), so a market only pays whichever way it lands while its two
 * sides stay inside a `nOutcomes - 1 : 1` ratio. For one side of one market, in whole USDC:
 * `need` = what it takes to put that side back inside the ratio, `room` = what can still be staked
 * on it before the *other* side falls out of it.
 */
const ratio = (m: bigint[], side: number, nOutcomes: number) => {
  const mine = Number((m[side] ?? 0n) / USDC);
  const other = Number((m[1 - side] ?? 0n) / USDC);
  return { need: Math.ceil(other / (nOutcomes - 1)) - mine, room: other * (nOutcomes - 1) - mine };
};

export type PlanInput = {
  rng: Rng;
  nOutcomes: number;
  /** micro-USDC already on each (market, side); see `emptyStakes`. */
  stakes: bigint[][];
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
 * uncovered (market, side) slot gets a bet before a tick is spent on volume, and the delay is
 * derived from the window so the slots still to fill actually fit inside it. Both phases size the
 * bet to keep the market inside Arena's void ratio (see `ratio`) — two-sided is not enough, a side
 * holding 1 of 52 against 3 outcomes is a refund waiting to happen.
 */
export function planBet(i: PlanInput): PlannedBet | null {
  const deadline = i.lockMs - i.marginMs;
  if (i.nowMs >= deadline) return null;

  const floor = Math.max(MIN_BET_USDC, Math.floor(i.minUsdc));
  const ceiling = Math.max(floor, Math.floor(i.maxUsdc));
  const richest = i.balances.reduce((a, b) => (b > a ? b : a), 0n);
  /** the biggest bet anybody here could place: a slot needing more than this is not plannable. */
  const most = Math.min(ceiling, Number(richest / USDC));
  if (most < floor) return null;

  type Slot = { o: number; side: number; lo: number; hi: number };
  /** short = below its 1/nOutcomes share (an empty side is only the extreme case of that) and so a
   *  refund waiting to happen; spare = already inside the ratio with room left for volume. */
  const short: Slot[] = [];
  const spare: Slot[] = [];
  const virgin: boolean[] = [];
  for (let o = 0; o < i.nOutcomes; o++) {
    const m = i.stakes[o] ?? [];
    virgin[o] = !m[0] && !m[1];
    for (const side of [0, 1]) {
      const { need, room } = ratio(m, side, i.nOutcomes);
      const lo = Math.max(floor, need);
      // Nothing to protect on a market nobody has touched, so the opening bet is free to be big;
      // every bet after it is bounded by what the other side can carry.
      const hi = virgin[o] ? most : Math.min(most, room);
      if (lo <= hi) (virgin[o] || need > 0 ? short : spare).push({ o, side, lo, hi });
    }
  }
  // Under time pressure, finishing a market beats opening another — a half-covered market pays
  // nobody — so a market already carrying stake goes first. With ticks to spare the order is all
  // this decides, since every short slot gets filled either way.
  const pairing = short.filter((x) => !virgin[x.o]);
  const pool = pairing.length > 0 ? pairing : short.length > 0 ? short : spare;
  if (pool.length === 0) return null; // e.g. a 2-outcome market that is already dead level

  let s = pool[Math.floor(i.rng() * pool.length)]!;
  // Coverage dictates its own side; the per-event lean only gets a say on a volume bet where both
  // sides of that market can take it.
  if (pool === spare) {
    const both = pool.filter((x) => x.o === s.o);
    if (both.length === 2) s = both[i.rng() < i.yesBias ? 1 : 0]!;
  }
  // `most` came from the richest bettor, so at least that one can cover s.lo.
  const afford: number[] = [];
  for (let b = 0; b < i.balances.length; b++) {
    if ((i.balances[b] ?? 0n) >= BigInt(s.lo) * USDC) afford.push(b);
  }
  const bettor = afford[Math.floor(i.rng() * afford.length)]!;
  const hi = Math.min(s.hi, Number(i.balances[bettor]! / USDC));
  /** log-uniform between two whole-USDC bounds: small bets common, big ones rare. */
  const whole = Math.round(Math.exp(Math.log(s.lo) + i.rng() * (Math.log(hi) - Math.log(s.lo))));
  const amount = BigInt(Math.min(hi, Math.max(s.lo, whole))) * USDC;

  // Cadence follows the work left, never slower than intervalMs: the +2 is the headroom the jitter
  // and the last uncovered slot need, and it is recomputed every call so a slow tick self-corrects.
  const pace = Math.min(i.intervalMs, (deadline - i.nowMs) / (short.length + 2));
  const delayMs = Math.max(200, Math.round(pace * (0.6 + i.rng() * 0.8)));
  return { bettor, outcomeIdx: s.o, yes: s.side === 1, amount, delayMs };
}

/** Everything the bettor sends: Arena bet/claim, Gate.setVerified, MockUSDC faucet/approve. */
const ERRORS = [...arenaAbi, ...gateAbi, ...mockusdcAbi].filter((x) => x.type === "error");

/**
 * viem buries the custom error name in the cause chain, so `shortMessage` alone renders an expected
 * `NothingToClaim` as the same bare "reverted" sentence as a real failure. A revert on the *send*
 * path (eth_sendRawTransaction) carries no ABI at all and prints a bare 4-byte selector, so decode
 * that too — otherwise a real `BettingClosed` at lock reads as `0x61c54c4a`.
 */
export function revertReason(e: unknown): string {
  const err = e as { walk?: (fn: (x: unknown) => boolean) => unknown; shortMessage?: string };
  const reverted = err?.walk?.((x) => (x as { name?: string })?.name === "ContractFunctionRevertedError") as
    | { data?: { errorName?: string }; reason?: string }
    | null
    | undefined;
  const named = reverted?.data?.errorName ?? reverted?.reason;
  if (named) return named;
  // A 4-byte selector, i.e. 0x + 8 hex and no more: an address or a hash is longer and never matches.
  const selector = /0x[0-9a-fA-F]{8}(?![0-9a-fA-F])/.exec(String(e))?.[0];
  if (selector) {
    try {
      return decodeErrorResult({ abi: ERRORS, data: selector as Hex }).errorName;
    } catch {}
  }
  return err?.shortMessage ?? String(e).slice(0, 120);
}
