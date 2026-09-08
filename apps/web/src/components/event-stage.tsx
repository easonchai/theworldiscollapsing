"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { identOf } from "@/lib/channels";
import { roundTime } from "@/lib/chain";
import type { EventPublic } from "@/lib/public";
import { tickerLines } from "@/lib/ticker";
import { Chyron, Countdown, Digits, Umd, clock, useNow, usdc } from "./bits";
import { ClaimButton, Markets, claimableOf, useMarkets, type MarketState } from "./markets";
import { Player } from "./player";
import { VerifyBadge } from "./verify-badge";

const roundAtMs = (round: string) => Number(roundTime(BigInt(round))) * 1000;

/** How long a studio card stays on screen once its cue passes. */
const CARD_MS = 3500;

/**
 * The graphic the broadcast cuts to between first-half clips (PRD story 11): it paces the broadcast
 * and masks the join between two independently generated clips. Cues are seconds into the first
 * half, so it only runs while the first half is playing to the on-chain clock. It is a left-aligned
 * lower third on the same edge as the rest of the page, not a full-frame card that out-shouts the
 * countdown: the status is a mono tag and the scoreline sits beside it.
 */
function StudioCard({ event, now }: { event: EventPublic; now: number | null }) {
  if (now === null || event.state !== "BETTING" || !event.startTime) return null;
  const elapsed = now - Date.parse(event.startTime);
  const card = event.cards.find((c) => elapsed >= c.at * 1000 && elapsed < c.at * 1000 + CARD_MS);
  if (!card) return null;
  return (
    <div className="slate absolute inset-x-0 bottom-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-2">
      <span className="tag">studio</span>
      <span className="font-mono text-[12px] leading-none font-bold tracking-[0.18em] text-bone uppercase">
        {card.title}
      </span>
      <span className="h-3 w-px bg-line" aria-hidden />
      {card.stats.map((stat, i) => (
        <span key={i} className="num text-[12px] leading-none tracking-[0.1em] text-dim uppercase">
          {stat}
        </span>
      ))}
    </div>
  );
}

/** True once hydrated: time-dependent markup must match the server render until then. */
const neverChanges = () => () => {};
const useMounted = () =>
  useSyncExternalStore(
    neverChanges,
    () => true,
    () => false,
  );

/**
 * The monitor: the picture at broadcast amplitude (the source is a 100% signal, bars go to air at
 * 75%) under one rolling hum bar, with the station's UMD label — channel, name, tally — flush in
 * the frame's top-left corner so the one cue that has to read from across the room does. Every
 * number lives in the strip below, so no fact is stated twice.
 */
function Screen({ event, now, mounted }: { event: EventPublic; now: number; mounted: boolean }) {
  const locked = event.state === "LOCKED" || event.state === "RESOLVE";

  return (
    <div className="relative overflow-hidden border-b border-line bg-black">
      {/* 38dvh, so the strip and the rules under it clear the chyron on a laptop. */}
      <div className="feed">
        <Player event={event} className="aspect-video max-h-[38dvh] w-full" />
      </div>
      <span className="hum" aria-hidden />

      {/* The station's one statement of which channel this is, and the way back to it. */}
      <Link href={`/c/${event.channelId}`} className="absolute top-0 left-0 z-10">
        <Umd channelId={event.channelId} name={event.channelId} state={event.state} />
      </Link>

      {locked ? (
        <div className="absolute inset-0 z-20 grid place-items-center bg-vac/80">
          <div className="px-2 text-center">
            <p className="display text-[clamp(26px,3.4vw,44px)] leading-none text-bone">
              Locked
            </p>
            <p className="copy mt-2 text-dim">The ending does not exist yet.</p>
          </div>
        </div>
      ) : null}

      <StudioCard event={event} now={mounted ? now : null} />
    </div>
  );
}

/**
 * What this address has riding on the event, between the board and the ticket. An empty book is a
 * state, and a terminal states it in three words, not in a sentence about what will happen later.
 */
function YourPosition({ event, markets }: { event: EventPublic; markets: MarketState[] | null }) {
  const rows = (markets ?? []).flatMap((m, i) =>
    ([1, 0] as const)
      .filter((side) => m.stake[side] > 0n)
      .map((side) => ({ key: `${i}-${side}`, label: event.outcomes[i], side: side ? "yes" : "no", amount: m.stake[side] })),
  );
  return (
    <section className="border-t border-line px-2 py-2">
      <p className="tag">your position</p>
      {rows.length ? (
        <ul className="mt-2">
          {rows.map((r) => (
            <li key={r.key} className="flex items-baseline justify-between gap-2 border-b border-line py-1">
              <span className="min-w-0 truncate font-mono text-[12px] tracking-[0.06em] text-bone uppercase">
                {r.label} · {r.side}
              </span>
              <span className="num shrink-0 text-[12px] text-bone">{usdc(r.amount)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="num mt-1 text-[12px] tracking-[0.14em] text-dim uppercase">— no positions —</p>
      )}
    </section>
  );
}

export function EventStage({
  initial,
  showHeader = true,
}: {
  initial: EventPublic;
  showHeader?: boolean;
}) {
  const [event, setEvent] = useState(initial);
  const router = useRouter();
  const { value: markets, refresh } = useMarkets(event);
  const claimable = claimableOf(event, markets);
  const resolved = event.outcome !== null;
  const ident = identOf(event.channelId);
  const now = useNow();
  const mounted = useMounted();
  const toLock =
    mounted && event.state === "BETTING" && event.lockTime ? clock(Date.parse(event.lockTime) - now) : null;
  const landsIn = event.drandRound ? roundAtMs(event.drandRound) - now : null;

  // The chain owns the clock: poll this event until it flips, then the player swaps source itself.
  // Once it is finished, ask the server for whatever is on air now.
  useEffect(() => {
    const id = setInterval(() => {
      fetch(`/api/events/${event.id}`)
        .then((r) => (r.ok ? (r.json() as Promise<EventPublic>) : null))
        .then((e) => {
          if (!e) return;
          setEvent(e);
          if (e.state === "DONE") router.refresh();
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(id);
  }, [event.id, router]);

  return (
    <>
      <div className="grid bg-vac lg:grid-cols-[1fr_420px]">
        <div className="min-w-0 bg-vac">
          {showHeader ? (
            <header className="border-b border-line px-2 py-2">
              {/* The channel is named once, on the picture below, where the UMD carries it and
                  links back. Up here the only fact left is which event this is. */}
              <p className="tag">event {String(event.seq).padStart(3, "0")}</p>
              {/* Condensed caps, two lines at most: the countdown below is the page's display moment. */}
              <h1 className="mt-2 line-clamp-2 text-[clamp(22px,2.4vw,32px)] text-bone">{event.title}</h1>
              {/* One family for copy as well as for readouts: the mono at 13/1.6. */}
              <p className="copy mt-2 max-w-[86ch] text-dim">{event.premise}</p>
            </header>
          ) : null}

          <Screen event={event} now={now} mounted={mounted} />

          {/* One clock, full width, on the page's one margin: whatever this event is running
              against, at the only display size on the page. */}
          <div className="border-b border-line px-2 py-2">
            {event.state === "BETTING" ? (
              <>
                <p className="tag">betting closes in</p>
                <Countdown
                  to={event.lockTime}
                  className="money mt-1 block text-[clamp(64px,9vw,120px)] leading-[0.82] text-amber"
                />
              </>
            ) : event.state === "LOCKED" || event.state === "RESOLVE" ? (
              <>
                <p className="tag">round lands in</p>
                <p className="money mt-1 text-[clamp(64px,9vw,120px)] leading-[0.82] text-amber" suppressHydrationWarning>
                  {landsIn === null || !mounted ? "--:--" : <Digits text={clock(landsIn)} />}
                </p>
              </>
            ) : resolved ? (
              <>
                <p className="tag">result</p>
                <p className="display mt-1 text-[clamp(22px,2.4vw,34px)] leading-[0.95] text-bone">
                  {event.outcomes[event.outcome!]}
                </p>
              </>
            ) : (
              <>
                <p className="tag">status</p>
                <p className="money mt-1 text-[34px] leading-none text-dim">{event.state.toLowerCase()}</p>
              </>
            )}
          </div>

          {/* Both facts about the randomness on one line under the clock they belong to. */}
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-line px-2 py-2">
            <span className="tag">drand round</span>
            <span className="num text-[13px] text-bone">{event.drandRound ?? "—"}</span>
            <span className="mx-1 h-3 w-px self-center bg-line" aria-hidden />
            <span className="tag">publishes</span>
            <span className="num text-[13px] text-bone" suppressHydrationWarning>
              {event.drandRound ? new Date(roundAtMs(event.drandRound)).toLocaleTimeString() : "—"}
            </span>
          </div>

          {/* The house, as three lines of a terminal, not as three paragraphs. */}
          <dl className="grid grid-cols-[74px_1fr] gap-x-2 gap-y-1 border-b border-line px-2 py-2">
            <dt className="tag">payout</dt>
            <dd className="num text-[12px] leading-[1.5] break-words text-dim">
              Winners split their market&rsquo;s pool, less a <span className="text-bone">2%</span> fee. No house
              position.
            </dd>
            <dt className="tag">result</dt>
            <dd className="num text-[12px] leading-[1.5] break-words text-dim">
              <span className="text-bone">keccak256(signature ‖ eventId) mod n</span>, over the round above — fixed
              before betting opens, non-existent until it publishes.
            </dd>
            <dt className="tag">refund</dt>
            <dd className="num text-[12px] leading-[1.5] break-words text-dim">
              A market nobody won returns every stake in full.
            </dd>
          </dl>
        </div>

        <aside className="flex min-w-0 flex-col border-t border-line bg-vac lg:sticky lg:top-[46px] lg:h-[calc(100dvh-78px)] lg:self-start lg:overflow-y-auto lg:border-t-0 lg:border-l">
          <Markets event={event} markets={markets} refresh={refresh}>
            <YourPosition event={event} markets={markets} />
          </Markets>

          {resolved ? (
            <div className="flex flex-col gap-2 border-t border-line bg-vac p-2">
              <div className="panel border-amber/40 p-2">
                <p className="tag">your claim</p>
                <p className={`money mt-1 text-[26px] leading-none ${claimable > 0n ? "text-amber" : "text-dim"}`}>
                  {usdc(claimable)} USDC
                </p>
                <div className="mt-2">
                  <ClaimButton event={event} claimable={claimable} onClaimed={refresh} />
                </div>
              </div>
              <VerifyBadge event={event} />
            </div>
          ) : null}
        </aside>
      </div>

      <Chyron
        label={`ch ${ident.num}`}
        lines={tickerLines(event, markets?.map((m) => m.pool) ?? null, toLock)}
        empty="standby"
      />
    </>
  );
}
