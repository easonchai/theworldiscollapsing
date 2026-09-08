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

export const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

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

/** Payout for one market, given the caller's stakes and the market's pools. */
export function marketPayout(stake: readonly [bigint, bigint], pool: readonly [bigint, bigint], won: boolean): bigint {
  const win = won ? 1 : 0;
  if (pool[win] === 0n) return stake[1 - win]; // nobody to pay the losers' money to: full refund
  if (stake[win] === 0n) return 0n;
  const gross = (stake[win] * (pool[0] + pool[1])) / pool[win];
  return gross - (gross * FEE_BPS) / 10_000n;
}

/** What `amount` on this side would pay if that side wins, at the pools it would create. */
export function previewPayout(amount: bigint, yes: boolean, pool: readonly [bigint, bigint]): bigint {
  if (amount === 0n) return 0n;
  const side = yes ? 1 : 0;
  const after: [bigint, bigint] = [pool[0], pool[1]];
  after[side] += amount;
  const gross = (amount * (after[0] + after[1])) / after[side];
  return gross - (gross * FEE_BPS) / 10_000n;
}

/** Implied YES probability = share of the market's pool sitting on YES. */
export function impliedYes(pool: readonly [bigint, bigint]): number | null {
  const total = pool[0] + pool[1];
  if (total === 0n) return null;
  return Number((pool[1] * 10_000n) / total) / 10_000;
}
