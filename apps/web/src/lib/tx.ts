import { BaseError, ContractFunctionRevertedError, type Hex, type TransactionReceipt } from "viem";
import { publicClient } from "./chain";

/** What a failed write says, and where it sends the viewer if there is somewhere to go. */
export type TxMessage = { text: string; href: string | null };

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

/**
 * Every custom error `Arena` and `MockUSDC` can revert the four writes this app makes with
 * (approve, bet, claim, faucet), said in the viewer's terms. Simulating before signing turns each
 * of these into a sentence the user reads *instead of* a wallet prompt for a doomed transaction.
 */
const CONTRACT_ERRORS: Record<string, TxMessage> = {
  // Arena
  BettingClosed: { text: "Betting is closed on this event — nothing was staked.", href: null },
  BadOutcome: { text: "That market is not on this event.", href: null },
  ZeroAmount: { text: "Enter a stake above zero.", href: null },
  NothingToClaim: { text: "Nothing to claim on this event.", href: null },
  NotResolved: { text: "The round has not landed yet, so there is nothing to claim.", href: null },
  UnknownEvent: { text: "This event is not on chain.", href: null },
  // Arena and MockUSDC both gate on it, and the fix is the same page either way.
  NotVerified: { text: "This address is not verified yet.", href: "/verify" },
  // MockUSDC
  FaucetCooldown: { text: "The faucet pays out once a day — the cooldown has not passed.", href: null },
};

/** The contract's own error name, when the call reverted with one of them. */
export function revertName(e: unknown): string | null {
  if (!(e instanceof BaseError)) return null;
  const reverted = e.walk((err) => err instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? (reverted.data?.errorName ?? null) : null;
}

/** The first line of whatever viem said, when nothing better is known. */
export function shortError(e: unknown): string {
  const msg = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
  return msg.split("\n")[0].slice(0, 160);
}

/** What went wrong with a write, mapped from the contract's custom error where there is one. */
export function txMessage(e: unknown): TxMessage {
  const name = revertName(e);
  return (name ? CONTRACT_ERRORS[name] : undefined) ?? { text: shortError(e), href: null };
}
