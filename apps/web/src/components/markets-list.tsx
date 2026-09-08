"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { EventPublic } from "@/lib/public";
import { gql, subgraphConfigured, type SubgraphEventMarkets } from "@/lib/subgraph";
import { EVENT_WINDOW, MARKETS_QUERY, TITLE_WINDOW, marketRows } from "@/lib/market-rows";
import { impliedYes } from "@/lib/chain";
import { StateBadge, usdc } from "./bits";
import { SubgraphNotConfigured } from "./not-configured";

export function MarketsList() {
  const [indexed, setIndexed] = useState<SubgraphEventMarkets[] | null>(null);
  const [titles, setTitles] = useState<Record<string, EventPublic>>({});
  const [eventCount, setEventCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState("all");
  const [state, setState] = useState("all");

  // Pools and volume live in the index, titles and channels in Postgres. Both are re-read on the
  // same tick, so an event that appears in the index is titled on the very next render.
  useEffect(() => {
    if (!subgraphConfigured) return;
    let live = true;
    const tick = async () => {
      try {
        const [data, list] = await Promise.all([
          gql<{ events: SubgraphEventMarkets[]; protocol: { eventCount: number } | null }>(MARKETS_QUERY),
          fetch(`/api/events?limit=${TITLE_WINDOW}`).then((r) => r.json() as Promise<EventPublic[]>),
        ]);
        if (!live) return;
        setIndexed(data.events);
        setEventCount(data.protocol?.eventCount ?? null);
        setTitles(Object.fromEntries(list.map((e) => [e.id.toLowerCase(), e])));
        setError(null);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    void tick();
    const id = setInterval(tick, 5000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  const rows = useMemo(() => marketRows(indexed ?? [], titles, { channel, state }), [indexed, titles, channel, state]);

  if (!subgraphConfigured) return <SubgraphNotConfigured what="The markets list" />;

  const channels = Array.from(new Set(Object.values(titles).map((e) => e.channelId))).sort();

  return (
    <div>
      <div className="sticky top-[46px] z-20 flex flex-wrap items-center gap-2 border-b border-line bg-vac/95 px-3 py-2 backdrop-blur-[2px]">
        <span className="tag">filter</span>
        <select className="field w-auto py-1" value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Channel">
          <option value="all">all channels</option>
          {channels.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select className="field w-auto py-1" value={state} onChange={(e) => setState(e.target.value)} aria-label="State">
          <option value="all">all states</option>
          <option value="open">open</option>
          <option value="resolved">resolved</option>
        </select>
        <span className="num ml-auto text-[11px] text-dim">
          {rows.length} markets
          {eventCount !== null && eventCount > EVENT_WINDOW ? ` · newest ${EVENT_WINDOW} of ${eventCount} events` : ""}
        </span>
      </div>

      {error ? <p className="px-3 py-2 num text-[12px] text-flare">subgraph: {error}</p> : null}

      <ul className="divide-y divide-line">
        {rows.map(({ market, indexed: ie, event, volume }) => {
          const pool: [bigint, bigint] = [BigInt(market.noPool), BigInt(market.yesPool)];
          const p = impliedYes(pool);
          const won = ie.resolved && ie.outcome === market.outcomeIdx;
          return (
            <li key={market.id}>
              <Link
                href={`/e/${event.id}`}
                className="grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-2 hover:bg-panel2 sm:grid-cols-[1fr_120px_120px_120px]"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[14px] text-bone">
                    {event.outcomes[market.outcomeIdx] ?? `outcome ${market.outcomeIdx}`}
                  </span>
                  <span className="num text-[11px] text-dim">
                    {event.channelId} · {event.title}
                  </span>
                </span>
                <span className="hidden sm:block">
                  <span className="tag block">yes / no</span>
                  <span className="num text-[13px]">
                    <span className="text-bone">{p === null ? "—" : `${Math.round(p * 100)}%`}</span>
                    <span className="text-dim"> / </span>
                    <span className="text-bone">{p === null ? "—" : `${Math.round((1 - p) * 100)}%`}</span>
                  </span>
                </span>
                <span className="hidden sm:block">
                  <span className="tag block">volume</span>
                  <span className="num text-[13px] text-bone">{usdc(volume)}</span>
                </span>
                <span className="text-right">
                  {ie.resolved ? (
                    <span className={`chip ${won ? "border-bone/60 text-bone" : "border-line text-dim"}`}>
                      {won ? "Yes" : "No"}
                    </span>
                  ) : (
                    <StateBadge state={event.state} />
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>

      {indexed && !rows.length ? (
        <p className="px-3 py-6 text-[12px] text-dim">The index has no markets matching this filter.</p>
      ) : null}
    </div>
  );
}
