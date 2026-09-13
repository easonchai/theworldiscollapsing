import type { EventPublic, StudioCard } from "./public";
import { REVEALED } from "./public";

/** How long a studio card stays on screen once its cue passes (PRD story 11). */
export const CARD_MS = 3500;

/**
 * Which studio card the broadcast is on, `elapsedMs` into the first half. The cards are cued off
 * the shot boundaries, and the player is locked to the chain clock, so every viewer sees the same
 * card at the same moment. Nothing is on screen before the first cue or after the last one clears.
 */
export function cardAt(cards: readonly StudioCard[], elapsedMs: number): StudioCard | null {
  return cards.find((c) => elapsedMs >= c.at * 1000 && elapsedMs < c.at * 1000 + CARD_MS) ?? null;
}

const ms = (iso: string | null): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
};

/**
 * What the player shows and where it starts.
 *
 * Live events are synced to the on-chain clock, so everyone is watching the same moment. A DONE
 * event is archive — the wall falls back to it so the world never looks dead — and its chain time
 * is long past, which would park the video on its last frame. Archive plays from the top instead.
 *
 * `loop`: once the result is out the picture keeps moving. The winning branch is 30 s and the
 * pause after it is minutes, so a branch that held its last frame left the wall frozen on a
 * dimmed still for most of every event. The first half never loops: its end is the lock.
 */
export function sourceFor(event: EventPublic): {
  src: string | null;
  t0: number | null;
  archive: boolean;
  loop: boolean;
} {
  const revealed = REVEALED.has(event.state) && !!event.winningBranchUrl;
  const src = revealed ? event.winningBranchUrl : event.firstHalfUrl;
  if (event.state === "DONE") return { src, t0: null, archive: true, loop: true };
  // A reveal with no branch has nothing to show: the no-signal card, not the first half seeked
  // past its own end.
  if (REVEALED.has(event.state) && !event.winningBranchUrl) return { src: null, t0: null, archive: false, loop: false };
  return { src, t0: revealed ? ms(event.revealTime) : ms(event.startTime), archive: false, loop: revealed };
}
