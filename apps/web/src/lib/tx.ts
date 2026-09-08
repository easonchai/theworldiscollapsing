import type { Hex, TransactionReceipt } from "viem";
import { publicClient } from "./chain";

/**
 * Wait for a write and treat a mined-but-reverted transaction as a failure.
 *
 * viem resolves `waitForTransactionReceipt` for a reverted transaction — it only throws when the
 * transaction never lands — so any caller that does not read `receipt.status` announces a revert as
 * a success. `whenReverted` is a thunk because the copy usually depends on the state of the world
 * *after* the wait (a bet that reverted may only have crossed the lock while it was in the mempool).
 */
export async function confirmed(hash: Hex, whenReverted: () => string): Promise<TransactionReceipt> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(whenReverted());
  return receipt;
}

/**
 * Why a bet reverted, in the viewer's terms. A bet mined at or after `lockTime` hit `BettingClosed`
 * — PRD story 29 wants that said plainly rather than reported as a confirmation.
 */
export function betRevertMessage(lockTime: string | null, now: number): string {
  const lock = lockTime ? Date.parse(lockTime) : NaN;
  return !Number.isNaN(lock) && now >= lock
    ? "Betting closed — this bet did not count, nothing was staked."
    : "The bet reverted on chain — nothing was staked.";
}
