"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { EventPublic } from "@/lib/public";
import { gql, subgraphConfigured, type SubgraphPosition } from "@/lib/subgraph";
import { ClaimButton, claimableOf, readMarket } from "./markets";
import { SubgraphNotConfigured } from "./not-configured";
import { usdc } from "./bits";
import { useWallet } from "./wallet";

const QUERY = `query positions($bettor: Bytes!) {
  positions(where: { bettor: $bettor }, first: 200) {
    id
    bettor
    yesStake
    noStake
    claimed
    market { outcomeIdx }
    event { id nOutcomes lockTime drandRound resolved outcome createdAt totalPool betCount }
  }
}`;

type Row = { event: EventPublic; positions: SubgraphPosition[]; claimable: bigint };

export function PositionsList() {
  const { address } = useWallet();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!subgraphConfigured || !address) return;
    let live = true;
    const load = async () => {
      try {
        const [{ positions }, events] = await Promise.all([
          gql<{ positions: SubgraphPosition[] }>(QUERY, { bettor: address.toLowerCase() }),
          fetch("/api/events?limit=100").then((r) => r.json() as Promise<EventPublic[]>),
        ]);
        const byId = Object.fromEntries(events.map((e) => [e.id.toLowerCase(), e]));
        const grouped = new Map<string, SubgraphPosition[]>();
        for (const p of positions) {
          const key = p.event.id.toLowerCase();
          grouped.set(key, [...(grouped.get(key) ?? []), p]);
        }
        // Claimable is money, so it comes from the chain, never from the index. Every event's
        // markets, and every outcome within one event, read in parallel rather than one round
        // trip at a time.
        const built = await Promise.all(
          Array.from(grouped, async ([eventId, group]): Promise<Row | null> => {
            const event = byId[eventId];
            if (!event) return null;
            const markets =
              event.outcome === null
                ? null
                : await Promise.all(event.outcomes.map((_, i) => readMarket(event.id, i, address)));
            return { event, positions: group, claimable: claimableOf(event, markets) };
          }),
        );
        const out = built.filter((r): r is Row => r !== null);
        if (live) {
          setRows(out.sort((a, b) => Number(b.claimable - a.claimable)));
          setError(null);
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    void load();
    const id = setInterval(load, 6000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [address]);

  if (!subgraphConfigured) return <SubgraphNotConfigured what="Your positions list" />;
  if (!address) return <p className="px-2 py-6 text-[12px] text-dim">Sign in to see your positions.</p>;

  return (
    <div>
      {error ? <p className="px-2 py-2 num text-[12px] text-flare">subgraph: {error}</p> : null}
      <ul className="divide-y divide-line">
        {(rows ?? []).map(({ event, positions, claimable }) => (
          <li key={event.id} className="grid gap-2 px-2 py-2 lg:grid-cols-[1fr_260px]">
            <div>
              <Link href={`/e/${event.id}`} className="text-[15px] text-bone hover:text-amber">
                {event.title}
              </Link>
              <p className="num text-[11px] text-dim">
                {event.channelId} · {event.outcome !== null ? `resolved — ${event.outcomes[event.outcome]}` : event.state}
              </p>
              <ul className="mt-1 num text-[12px] text-dim">
                {positions.map((p) => (
                  <li key={p.id}>
                    {event.outcomes[p.market.outcomeIdx] ?? `outcome ${p.market.outcomeIdx}`}:{" "}
                    <span className="text-bone">{usdc(BigInt(p.yesStake))} yes</span> ·{" "}
                    <span className="text-bone">{usdc(BigInt(p.noStake))} no</span>
                    {p.claimed ? " · claimed" : ""}
                  </li>
                ))}
              </ul>
            </div>
            <div className="self-center">
              {event.outcome !== null ? (
                <ClaimButton event={event} claimable={claimable} />
              ) : (
                <p className="num text-[12px] text-dim">still running</p>
              )}
            </div>
          </li>
        ))}
      </ul>
      {rows && !rows.length ? (
        <p className="px-2 py-6 text-[12px] text-dim">No positions indexed for this address yet.</p>
      ) : null}
    </div>
  );
}
