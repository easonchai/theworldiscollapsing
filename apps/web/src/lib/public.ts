import type { Event } from "db";

/** A studio card, cued `at` seconds into the first half (PRD story 11). */
export type StudioCard = { at: number; title: string; stats: string[] };

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
  cards: StudioCard[];
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
 * The authored cards, with `afterShot` (an index into the first-half shot list, which the client
 * never sees) converted to seconds of playback. Anything malformed is dropped rather than trusted.
 */
function cards(script: { cards?: unknown; firstHalf?: unknown }): StudioCard[] {
  if (!Array.isArray(script.cards)) return [];
  const shots = Array.isArray(script.firstHalf) ? script.firstHalf : [];
  let end = 0;
  const ends = shots.map((s) => {
    const seconds = (s as { seconds?: unknown } | null)?.seconds;
    end += typeof seconds === "number" ? seconds : 0;
    return end;
  });
  return script.cards.flatMap((raw) => {
    const c = raw as { afterShot?: unknown; title?: unknown; stats?: unknown } | null;
    const at = typeof c?.afterShot === "number" ? ends[c.afterShot] : undefined;
    if (at === undefined || typeof c?.title !== "string") return [];
    return [{ at, title: c.title, stats: strings(c.stats) }];
  });
}

/**
 * Build the public view of an event row. This is the anti-skip-ahead guarantee: the object is
 * constructed field by field (never spread from the row), and `branchUrls` leaves this function
 * only as `winningBranchUrl`, only once the chain has resolved the event.
 */
export function toPublic(e: Event): EventPublic {
  const script = (e.script ?? {}) as { ticker?: unknown; cards?: unknown; firstHalf?: unknown };
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
    cards: cards(script),
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
