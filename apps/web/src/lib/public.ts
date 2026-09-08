import type { Event } from "db";

/** The only shape of an Event a client ever sees. Defined in docs/CONTRACTS.md. */
export type EventPublic = {
  id: `0x${string}`;
  channelId: string;
  seq: number;
  state: string;
  title: string;
  premise: string;
  outcomes: string[];
  ticker: string[];
  reasoning: string | null;
  firstHalfUrl: string | null;
  winningBranchUrl: string | null;
  startTime: string | null;
  lockTime: string | null;
  drandRound: string | null;
  revealTime: string | null;
  outcome: number | null;
  signature: string | null;
  createTx: string | null;
  resolveTx: string | null;
};

/** States in which the outcome is already public, so the winning branch may be served. */
export const REVEALED = new Set(["REVEAL", "CANON", "PAUSE", "DONE"]);

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Build the public view of an event row. This is the anti-skip-ahead guarantee: the object is
 * constructed field by field (never spread from the row), and `branchUrls` leaves this function
 * only as `winningBranchUrl`, only once the chain has resolved the event.
 */
export function toPublic(e: Event): EventPublic {
  const script = (e.script ?? {}) as { ticker?: unknown };
  const branches = strings(e.branchUrls);
  const revealed = REVEALED.has(e.state) && e.outcome !== null;
  return {
    id: e.id as `0x${string}`,
    channelId: e.channelId,
    seq: e.seq,
    state: e.state,
    title: e.title,
    premise: e.premise,
    outcomes: strings(e.outcomes),
    ticker: strings(script.ticker),
    reasoning: e.reasoning,
    firstHalfUrl: e.firstHalfUrl,
    winningBranchUrl: revealed ? (branches[e.outcome as number] ?? null) : null,
    startTime: e.startTime?.toISOString() ?? null,
    lockTime: e.lockTime?.toISOString() ?? null,
    drandRound: e.drandRound?.toString() ?? null,
    revealTime: e.revealTime?.toISOString() ?? null,
    outcome: e.outcome,
    signature: e.signature,
    createTx: e.createTx,
    resolveTx: e.resolveTx,
  };
}
