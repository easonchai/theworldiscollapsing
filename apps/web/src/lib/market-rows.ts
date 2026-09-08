import type { EventPublic } from "./public";
import type { SubgraphEventMarkets, SubgraphMarket } from "./subgraph";

/** The list shows the markets of the newest events. Unordered `markets(first: n)` would hand back
 *  the n lexicographically smallest ids — random with respect to time — and drop live markets. */
export const EVENT_WINDOW = 60;

/** Titles come from Postgres. Wider than the index window, and both are newest-first, so every
 *  event the index returns is inside it and no row can end up nameless. */
export const TITLE_WINDOW = 100;

export const MARKETS_QUERY = `{
  events(first: ${EVENT_WINDOW}, orderBy: createdAt, orderDirection: desc) {
    id
    nOutcomes
    lockTime
    drandRound
    resolved
    outcome
    createdAt
    totalPool
    betCount
    markets { id outcomeIdx yesPool noPool }
  }
  protocol(id: "1") { eventCount }
}`;

export type MarketRow = {
  market: SubgraphMarket;
  indexed: SubgraphEventMarkets;
  event: EventPublic;
  volume: bigint;
};

/** Join indexed pools to Postgres titles, filter, and order by volume then recency. */
export function marketRows(
  indexed: SubgraphEventMarkets[],
  titles: Record<string, EventPublic>,
  filter: { channel: string; state: string },
): MarketRow[] {
  const rows: MarketRow[] = [];
  for (const ie of indexed) {
    // No title means no label, no channel and nowhere to link. Such a row is never listed.
    const event = titles[ie.id.toLowerCase()];
    if (!event) continue;
    if (filter.channel !== "all" && event.channelId !== filter.channel) continue;
    if (filter.state === "open" && ie.resolved) continue;
    if (filter.state === "resolved" && !ie.resolved) continue;
    for (const market of ie.markets) {
      rows.push({ market, indexed: ie, event, volume: BigInt(market.yesPool) + BigInt(market.noPool) });
    }
  }
  return rows.sort((a, b) => {
    if (a.volume !== b.volume) return a.volume > b.volume ? -1 : 1;
    return Number(b.indexed.createdAt) - Number(a.indexed.createdAt);
  });
}
