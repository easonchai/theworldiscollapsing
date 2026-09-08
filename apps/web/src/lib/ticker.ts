import { impliedYes } from "./chain";
import type { EventPublic } from "./public";

/**
 * What the strip across the bottom of the video says (PRD story 12): the authored strap lines, the
 * countdown to lock, and the live implied odds of every market. A viewer watching full-bleed sees
 * the same two numbers as a viewer with the markets panel open.
 *
 * `pools` is [no, yes] per outcome straight from chain, or null while the first poll is in flight;
 * `countdown` is the already-formatted time to lock, or null when betting is not open.
 */
export function tickerLines(
  event: EventPublic,
  pools: readonly (readonly [bigint, bigint])[] | null,
  countdown: string | null,
): string[] {
  const lines = [...event.ticker];
  if (countdown) lines.push(`BETTING CLOSES IN ${countdown}`);
  (pools ?? []).forEach((pool, i) => {
    const label = event.outcomes[i];
    const yes = impliedYes(pool);
    if (!label) return;
    lines.push(`${label} — YES ${yes === null ? "NO BETS YET" : `${Math.round(yes * 100)}%`}`);
  });
  return lines;
}
