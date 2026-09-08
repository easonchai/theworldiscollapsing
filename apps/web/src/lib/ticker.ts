import { impliedYes } from "./chain";
import type { EventPublic } from "./public";

/** One crawl item: an amber category label and the line it introduces. */
export type TickerLine = { cat: string; text: string };

/**
 * What the chyron says (PRD story 12): the authored strap lines, the countdown to lock, and the
 * live implied odds of every market. A viewer watching full-bleed sees the same two numbers as a
 * viewer with the markets panel open. Every line is filed under a category so the crawl reads as a
 * wire feed rather than one long sentence.
 *
 * `pools` is [no, yes] per outcome straight from chain, or null while the first poll is in flight;
 * `countdown` is the already-formatted time to lock, or null when betting is not open.
 */
export function tickerLines(
  event: EventPublic,
  pools: readonly (readonly [bigint, bigint])[] | null,
  countdown: string | null,
): TickerLine[] {
  const lines: TickerLine[] = event.ticker.map((text) => ({ cat: "wire", text }));
  if (countdown) lines.push({ cat: "lock", text: `BETTING CLOSES IN ${countdown}` });
  (pools ?? []).forEach((pool, i) => {
    const label = event.outcomes[i];
    const yes = impliedYes(pool);
    if (!label) return;
    lines.push({ cat: "odds", text: yes === null ? `${label} — NO BETS YET` : `${label} — YES ${Math.round(yes * 100)}%` });
  });
  return lines;
}
