const ZERO = "0x0000000000000000000000000000000000000000";

export type TrustCopy = { proves: string | null; doesNot: string };

/**
 * The trust bullets on /verify, derived from `Arena.verifier()` rather than hard-coded, so the
 * page can never claim less (or more) than the deployment actually enforces. `verifier` is null
 * when the chain could not be read.
 */
export function trustCopy(verifier: string | null): TrustCopy {
  if (verifier === null)
    return {
      proves: null,
      doesNot:
        "We could not read Arena.verifier() from the chain just now, so whether resolution is checked on chain is unknown here. Either way only the resolver can resolve — three days after the lock anyone can bail an unresolved event and every stake comes back in full — and one owner key holds setVerifier, setResolver and setTreasury.",
    };

  if (verifier.toLowerCase() === ZERO)
    return {
      proves: null,
      doesNot:
        "This Arena has no on-chain verifier, so resolution trusts a submitter whose work anyone can audit — and only the resolver can resolve, though anyone can bail an unresolved event three days after the lock for a full refund, with one owner key holding setVerifier, setResolver and setTreasury.",
    };

  return {
    proves: "Resolution verifies the drand BLS signature on chain, so no submitter is trusted with the outcome.",
    doesNot:
      "Liveness and keys. Only the resolver can call resolve, so it can stall an event — three days after the lock anyone can bail it and every stake comes back in full, no fee — and one owner key holds setVerifier, setResolver and setTreasury.",
  };
}
