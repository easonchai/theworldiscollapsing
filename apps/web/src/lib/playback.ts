import type { EventPublic } from "./public";
import { REVEALED } from "./public";

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
 */
export function sourceFor(event: EventPublic): { src: string | null; t0: number | null; archive: boolean } {
  const revealed = REVEALED.has(event.state) && !!event.winningBranchUrl;
  const src = revealed ? event.winningBranchUrl : event.firstHalfUrl;
  if (event.state === "DONE") return { src, t0: null, archive: true };
  return { src, t0: revealed ? ms(event.revealTime) : ms(event.startTime), archive: false };
}
