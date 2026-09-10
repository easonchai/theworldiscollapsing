import { concatHex, keccak256, type Hex } from "viem";

// drand evmnet (BN254, verified on chain by DrandVerifier): round r is published at
// GENESIS + (r - 1) * PERIOD. Mirrors Arena.sol.
export const GENESIS = 1727521075n;
export const PERIOD = 3n;
export const SUSPENSE_GAP = 10n;
export const DRAND_URL = "https://api.drand.sh/v2/beacons/evmnet/rounds";

export const roundTime = (round: bigint): bigint => GENESIS + (round - 1n) * PERIOD;

/** Smallest round published at or after unix time `t`. */
export const roundAt = (t: bigint): bigint =>
  t <= GENESIS ? 1n : (t - GENESIS + PERIOD - 1n) / PERIOD + 1n;

/** Round the contract will accept for a given lock time. */
export const roundForLock = (lockTime: bigint): bigint => roundAt(lockTime + SUSPENSE_GAP);

/** outcome = keccak256(sig ‖ eventId) mod n — must match Arena.deriveOutcome. */
export const outcomeFor = (signature: Hex, eventId: Hex, nOutcomes: number): number =>
  Number(BigInt(keccak256(concatHex([signature, eventId]))) % BigInt(nOutcomes));

export type Beacon = { round: bigint; signature: Hex };

/**
 * `timeoutMs` bounds the request: money is already locked on chain when the machine starts asking
 * for a beacon, and it retries forever. Without a per-request abort one hung socket parks the whole
 * channel — the retry loop only gets its cadence back if a stuck request fails.
 */
export async function fetchRound(round: bigint, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<Beacon> {
  const res = await fetchImpl(`${DRAND_URL}/${round}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`drand round ${round}: HTTP ${res.status}`);
  const body = (await res.json()) as { round?: unknown; signature?: unknown };
  if (body.round !== Number(round)) throw new Error(`drand: expected round ${round}, got ${body.round}`);
  // evmnet signatures are uncompressed BN254 G1 points: 64 bytes.
  if (typeof body.signature !== "string" || !/^[0-9a-f]{128}$/.test(body.signature)) {
    throw new Error("drand: malformed signature");
  }
  return { round, signature: `0x${body.signature}` };
}
