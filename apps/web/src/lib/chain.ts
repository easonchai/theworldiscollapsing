import { concatHex, createPublicClient, http, keccak256, type Address, type Hex } from "viem";
import { anvil, baseSepolia } from "viem/chains";
import { arenaAbi } from "contracts/abi/Arena";
import { gateAbi } from "contracts/abi/Gate";
import { mockusdcAbi } from "contracts/abi/MockUSDC";

export { arenaAbi, gateAbi, mockusdcAbi };

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "31337");
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545";
export const ARENA = (process.env.NEXT_PUBLIC_ARENA_ADDRESS ?? "0x") as Address;
export const USDC = (process.env.NEXT_PUBLIC_USDC_ADDRESS ?? "0x") as Address;
export const GATE = (process.env.NEXT_PUBLIC_GATE_ADDRESS ?? "0x") as Address;
export const GATE_MODE = process.env.NEXT_PUBLIC_GATE_MODE === "world" ? "world" : "checkbox";
export const SUBGRAPH_URL = process.env.NEXT_PUBLIC_SUBGRAPH_URL ?? "";
export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
export const DEV_WALLET_KEY = process.env.NEXT_PUBLIC_DEV_WALLET_KEY ?? "";
export const WORLD_APP_ID = process.env.NEXT_PUBLIC_WORLD_APP_ID ?? "";
export const WORLD_ACTION = process.env.NEXT_PUBLIC_WORLD_ACTION ?? "verify";

export const chain = CHAIN_ID === 84532 ? baseSepolia : anvil;

// A Privy embedded wallet is born with no ETH, so `/api/verify` drips some from the gate owner
// whenever a verified address falls below GAS_MIN. At Base Sepolia's ~0.006 gwei a faucet call
// costs ~0.000001 ETH, so GAS_DRIP is hundreds of writes; GAS_MIN is well above one bet.
export const GAS_MIN = 500_000_000_000_000n; // 0.0005 ETH
export const GAS_DRIP = 2_000_000_000_000_000n; // 0.002 ETH

/**
 * `pools` and `stakes` are mappings to a fixed [NO, YES] array, so every market side is its own
 * getter call (see `readMarket` in components/markets.tsx). Unbatched that is one HTTPS POST each:
 * a four-channel wall at three outcomes issued 24 of them every 3 s, and an idle tab on the free
 * dRPC tier ran to 1613 requests in about 13 minutes.
 *
 * `batch.multicall` aggregates the reads the wall issues in one tick (they all go out inside a
 * single `Promise.all`) into one `eth_call` against Multicall3. Measured against Base Sepolia on
 * 2026-09-13, one channel's tick at three outcomes:
 *
 *     no batching       6 POSTs, 6x eth_call        OK
 *     transport batch   4 POSTs, batch[6] each      HTTP 500, and viem retried it 4x
 *     multicall         1 POST,  1x eth_call        OK
 *
 * So deliberately not `http(RPC_URL, { batch: true })`. dRPC answers a JSON-RPC batch array with a
 * 500, and the retry behind it makes that worse than sending nothing batched at all.
 *
 * Conditional because multicall needs a deployed aggregator. viem carries Multicall3's address for
 * Base Sepolia; anvil 1.5.1 deploys none (checked, `eth_getCode` at the canonical address is empty)
 * and viem's anvil chain declares no contracts at all, so local dev keeps one POST per read. That
 * costs nothing: no local chain meters requests.
 */
export const publicClient = createPublicClient({
  chain,
  transport: http(RPC_URL),
  ...("contracts" in chain && chain.contracts?.multicall3 ? { batch: { multicall: true } } : {}),
});

// ── drand evmnet (mirrors Arena.sol and apps/engine/src/drand.ts) ─────────────
export const DRAND_GENESIS = 1727521075n;
export const DRAND_PERIOD = 3n;
export const DRAND_URL = "https://api.drand.sh/v2/beacons/evmnet/rounds";

export const roundTime = (round: bigint): bigint => DRAND_GENESIS + (round - 1n) * DRAND_PERIOD;

/** outcome = keccak256(sig ‖ eventId) mod n — must match Arena.deriveOutcome. */
export const outcomeFor = (signature: Hex, eventId: Hex, nOutcomes: number): number =>
  Number(BigInt(keccak256(concatHex([signature, eventId]))) % BigInt(nOutcomes));

// ── parimutuel math (mirrors Arena.claim) ────────────────────────────────────
export const FEE_BPS = 200n;
export const USDC_DECIMALS = 6;
/** `Arena.MIN_BET` — 1 USDC. Below it `bet` reverts `BelowMinBet`. */
export const MIN_BET = 1_000_000n;

/**
 * `Arena.claim`'s void rule: a market pays winner-take-all only while the winning side holds at
 * least its `1/nOutcomes` share of the pool. Under that it is void — both sides take their own
 * stake back, no fee — so no market ever returns more than `nOutcomes ×` a stake.
 */
export const voided = (pool: readonly [bigint, bigint], win: 0 | 1, nOutcomes: number): boolean =>
  pool[win] * BigInt(nOutcomes) < pool[0] + pool[1];

/** Payout for one market, given the caller's stakes and the market's pools. */
export function marketPayout(
  stake: readonly [bigint, bigint],
  pool: readonly [bigint, bigint],
  won: boolean,
  nOutcomes: number,
): bigint {
  const win = won ? 1 : 0;
  if (voided(pool, win, nOutcomes)) return stake[0] + stake[1];
  if (stake[win] === 0n) return 0n;
  const gross = (stake[win] * (pool[0] + pool[1])) / pool[win];
  return gross - (gross * FEE_BPS) / 10_000n;
}

/** What `amount` on this side would pay if that side wins, at the pools it would create. */
export function previewPayout(
  amount: bigint,
  yes: boolean,
  pool: readonly [bigint, bigint],
  nOutcomes: number,
): bigint {
  if (amount === 0n) return 0n;
  const side = yes ? 1 : 0;
  const after: [bigint, bigint] = [pool[0], pool[1]];
  after[side] += amount;
  if (voided(after, side, nOutcomes)) return amount; // the market would be void: the stake back
  const gross = (amount * (after[0] + after[1])) / after[side];
  return gross - (gross * FEE_BPS) / 10_000n;
}

/** Implied YES probability = share of the market's pool sitting on YES. */
export function impliedYes(pool: readonly [bigint, bigint]): number | null {
  const total = pool[0] + pool[1];
  if (total === 0n) return null;
  return Number((pool[1] * 10_000n) / total) / 10_000;
}
