"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import type { EventPublic } from "@/lib/public";
import { rotate, type ChannelView } from "@/lib/rotation";
import { EventStage } from "./event-stage";
import { ClaimButton, claimableOf, useMarkets } from "./markets";

/**
 * Money left on an event this channel has already moved on from. It is pinned above the new
 * broadcast — the bettor was watching this page, so this page is where their winnings stay — and it
 * exists only for an address that is actually owed something: `claimable` comes from the chain, and
 * a viewer with no stake in the finished event never sees the strip. Once the claim lands the card
 * holds its receipt (the stakes are deleted on chain, so `claimable` drops to zero) until dismissed.
 */
function PinnedClaim({ event, onDismiss }: { event: EventPublic; onDismiss: () => void }) {
  const { value: markets, refresh } = useMarkets(event);
  const claimable = claimableOf(event, markets);
  const [owed, setOwed] = useState(false);
  if (claimable > 0n && !owed) setOwed(true);
  if (!owed) return null;

  return (
    <section
      aria-label="Unclaimed winnings"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-panel px-2 py-2"
    >
      <span className="tag text-amber">unclaimed · event {String(event.seq).padStart(3, "0")}</span>
      <Link href={`/e/${event.id}`} className="data min-w-0 flex-1 truncate text-bone hover:text-amber">
        {event.title}
      </Link>
      <span className="w-[240px] shrink-0">
        <ClaimButton event={event} claimable={claimable} onClaimed={refresh} />
      </span>
      <button type="button" className="tag shrink-0 cursor-pointer hover:text-bone" onClick={onDismiss}>
        dismiss
      </button>
    </section>
  );
}

/**
 * The channel's stage. The server swaps `current` as the engine moves the channel on; this holds the
 * swap so a settled claim survives it. Both the server's copy of the event and the stage's own poll
 * feed one reducer, because the poll sees the outcome seconds before the page is re-rendered.
 */
export function ChannelStage({ current }: { current: EventPublic }) {
  const [view, setView] = useState<ChannelView>({ current, pinned: null });
  const onEvent = useCallback((e: EventPublic) => setView((v) => rotate(v, e)), []);
  // Adjusting state while rendering, the React way: a re-render of this page is a new `current`
  // object, and the rotation has to be folded in before the stage below is keyed off it.
  const [served, setServed] = useState(current);
  if (served !== current) {
    setServed(current);
    setView((v) => rotate(v, current));
  }

  return (
    <>
      {view.pinned ? (
        <PinnedClaim
          key={view.pinned.id}
          event={view.pinned}
          onDismiss={() => setView((v) => ({ ...v, pinned: null }))}
        />
      ) : null}
      <EventStage key={view.current.id} initial={view.current} showHeader={false} onEvent={onEvent} />
    </>
  );
}
