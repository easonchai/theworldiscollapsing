"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { EventPublic } from "@/lib/public";
import { gql, subgraphConfigured, type SubgraphMarket } from "@/lib/subgraph";
import { impliedYes } from "@/lib/chain";
import { StateBadge, usdc } from "./bits";
import { SubgraphNotConfigured } from "./not-configured";

const QUERY = `{
  markets(first: 200) {
    id
    outcomeIdx
    yesPool
    noPool
    event { id nOutcomes lockTime drandRound resolved outcome createdAt totalPool betCount }
  }
}`;

export function MarketsList() {
  const [markets, setMarkets] = useState<SubgraphMarket[] | null>(null);
  const [events, setEvents] = useState<Record<string, EventPublic>>({});
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState("all");
  const [state, setState] = useState("all");

  useEffect(() => {
    if (!subgraphConfigured) return;
    const tick = () =>
      gql<{ markets: SubgraphMarket[] }>(QUERY)
        .then((d) => {
          setMarkets(d.markets);
          setError(null);
        })
        .catch((e: Error) => setError(e.message));
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, []);

  // Titles and channels live in Postgres; pools and volume live in the index. Join them by event id.
  useEffect(() => {
    fetch("/api/events?limit=100")
      .then((r) => r.json() as Promise<EventPublic[]>)
      .then((list) => setEvents(Object.fromEntries(list.map((e) => [e.id.toLowerCase(), e]))))
      .catch(() => {});
  }, []);

  const rows = useMemo(() => {
    if (!markets) return [];
    return markets
      .map((m) => ({ m, e: events[m.event.id.toLowerCase()] ?? null, volume: BigInt(m.yesPool) + BigInt(m.noPool) }))
      .filter((r) => (channel === "all" ? true : r.e?.channelId === channel))
      .filter((r) => (state === "all" ? true : state === "resolved" ? r.m.event.resolved : !r.m.event.resolved))
      .sort((a, b) => {
        if (a.volume !== b.volume) return a.volume > b.volume ? -1 : 1;
        return Number(b.m.event.createdAt) - Number(a.m.event.createdAt);
      });
  }, [markets, events, channel, state]);

  if (!subgraphConfigured) return <SubgraphNotConfigured what="The markets list" />;

  const channels = Array.from(new Set(Object.values(events).map((e) => e.channelId))).sort();

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
        <span className="num ml-auto text-[11px] text-dim">{rows.length} markets</span>
      </div>

      {error ? <p className="px-3 py-2 num text-[12px] text-flare">subgraph: {error}</p> : null}

      <ul className="divide-y divide-line">
        {rows.map(({ m, e, volume }) => {
          const pool: [bigint, bigint] = [BigInt(m.noPool), BigInt(m.yesPool)];
          const p = impliedYes(pool);
          const won = m.event.resolved && m.event.outcome === m.outcomeIdx;
          return (
            <li key={m.id}>
              <Link
                href={e ? `/e/${e.id}` : "#"}
                className="grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-2 hover:bg-panel2 sm:grid-cols-[1fr_120px_120px_120px]"
              >
                <span className="min-w-0">
                  <span className="block truncate font-body text-[17px] text-bone">
                    {e ? e.outcomes[m.outcomeIdx] : `outcome ${m.outcomeIdx}`}
                  </span>
                  <span className="num text-[11px] text-dim">
                    {e ? `${e.channelId} · ${e.title}` : m.event.id.slice(0, 12)}
                  </span>
                </span>
                <span className="hidden sm:block">
                  <span className="tag block">yes / no</span>
                  <span className="num text-[13px]">
                    <span className="text-phos">{p === null ? "—" : `${Math.round(p * 100)}%`}</span>
                    <span className="text-dim"> / </span>
                    <span className="text-flare">{p === null ? "—" : `${Math.round((1 - p) * 100)}%`}</span>
                  </span>
                </span>
                <span className="hidden sm:block">
                  <span className="tag block">volume</span>
                  <span className="num text-[13px] text-bone">{usdc(volume)}</span>
                </span>
                <span className="text-right">
                  {m.event.resolved ? (
                    <span className={`chip ${won ? "border-phos/60 text-phos" : "border-line text-dim"}`}>
                      {won ? "Yes" : "No"}
                    </span>
                  ) : (
                    <StateBadge state={e?.state ?? "BETTING"} />
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>

      {markets && !rows.length ? (
        <p className="px-3 py-6 font-mono text-[12px] text-dim">The index has no markets matching this filter.</p>
      ) : null}
    </div>
  );
}
