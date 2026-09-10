import { hashSignal } from "@worldcoin/idkit/hashing";

/**
 * Is this World proof this address's proof?
 *
 * The widget hashes the `signal` it was given into every credential response as `signal_hash`
 * (docs.world.org api-reference/developer-portal/verify: `signal_hash` lives inside `responses[]`),
 * and the proof only verifies against that hash — so a proof made for one signal cannot be
 * relabelled for another. What the verify endpoint does *not* do is know which address is asking:
 * the relying party is the one that has to insist the signal is the caller's own. Without this
 * check one Selfie Check could verify any number of addresses.
 *
 * The expected hash is derived from the address the caller signed for, never from a signal the
 * caller sent alongside the proof — that would be the attacker choosing the thing being compared.
 * `hashSignal` reads a 0x-hex signal as bytes, so an address hashes the same in either casing.
 */
export function proofBoundTo(proof: unknown, address: string): boolean {
  const responses = (proof as { responses?: unknown } | null)?.responses;
  if (!Array.isArray(responses) || responses.length === 0) return false;
  const expected = hashSignal(address).toLowerCase();
  return responses.every((r) => {
    const hash = (r as { signal_hash?: unknown } | null)?.signal_hash;
    return typeof hash === "string" && hash.toLowerCase() === expected;
  });
}
