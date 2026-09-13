"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { identOf } from "@/lib/channels";
import { roundTime } from "@/lib/chain";
import type { ChannelPublic } from "@/lib/data";
import { cardAt } from "@/lib/playback";
import { FINISHED, type EventPublic } from "@/lib/public";
import { tickerLines } from "@/lib/ticker";
import { Chyron, Countdown, Digits, URGENT_MS, Umd, clock, useNow, usdc } from "./bits";
import { ClaimButton, Markets, claimableOf, useMarkets, type MarketState } from "./markets";
import { Player } from "./player";
import { VerifyBadge } from "./verify-badge";

const roundAtMs = (round: string) => Number(roundTime(BigInt(round))) * 1000;

/**
 * The graphic the broadcast cuts to between first-half clips (PRD story 11): it paces the broadcast
 * and masks the join between two independently generated clips. Cues are seconds into the first
 * half, so it only runs while the first half is playing to the on-chain clock. It is a left-aligned
 * lower third on the same edge as the rest of the page, not a full-frame card that out-shouts the
 * countdown: the status is a mono tag and the scoreline sits beside it.
 */
function StudioCard({ event, now }: { event: EventPublic; now: number | null }) {
  if (now === null || event.state !== "BETTING" || !event.startTime) return null;
  const card = cardAt(event.cards, now - Date.parse(event.startTime));
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

/**
 * The scorebug, top-right so it clears the UMD in the opposite corner. Sports only, because that is
 * the only channel with a scoreline.
 *
 * This is the one fact on the picture a viewer has to be able to read, and it is page text rather
 * than pixels for a measured reason: fast-h3 cannot draw letterforms. Three culture renders came
 * back with gibberish on every sign in shot, so a score generated into the video would read as
 * nonsense to the person whose money is on it. Everything the model draws may be gibberish; this
 * cannot be.
 */
function Scorebug({ event }: { event: EventPublic }) {
  const score = event.score;
  if (!score) return null;
  return (
    <div className="absolute top-0 right-0 z-10 flex items-center gap-2 border-b border-l border-line bg-black px-2 py-1 whitespace-nowrap">
      <span className="font-mono text-[10px] leading-none font-medium tracking-[0.18em] text-bone uppercase">
        {score.sides[0]}
      </span>
      <span className="num text-[12px] leading-none text-amber">{score.score}</span>
      <span className="font-mono text-[10px] leading-none font-medium tracking-[0.18em] text-bone uppercase">
        {score.sides[1]}
      </span>
      <span className="tag">{score.final ? "full time" : "half"}</span>
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
      {/* 38dvh, so the strip and the rules under it clear the chyron on a laptop. A source that is
          not taking bets is off air and drops to 40% luminance; a live one goes to air at 75%. */}
      <div className={locked ? "feed-dim" : "feed"}>
        <Player event={event} className="aspect-video max-h-[38dvh] w-full" />
      </div>
      {/* The picture is a raster: a full-field scanline under one rolling hum band. */}
      <span className="scan" aria-hidden />
      <span className="hum" aria-hidden />

      {/* The station's one statement of which channel this is, and the way back to it. */}
      <Link href={`/c/${event.channelId}`} className="absolute top-0 left-0 z-10">
        <Umd channelId={event.channelId} name={event.channelId} state={event.state} />
      </Link>

      <Scorebug event={event} />

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

      {/* The second half is generated pixels and cannot be trusted to show who won, so the result
          is punched onto the picture as a lower third the moment the round lands. */}
      {event.outcome !== null && !locked ? (
        <div className="slate absolute inset-x-0 bottom-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-2">
          <span className="tag">full time</span>
          <span className="display text-[clamp(18px,2.2vw,28px)] leading-none text-amber">
            {event.outcomes[event.outcome]}
          </span>
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
              <span className="data min-w-0 truncate text-bone">
                {r.label} · {r.side.toUpperCase()}
              </span>
              <span className="data shrink-0 text-bone">{usdc(r.amount)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="data mt-1 text-dim">— no positions —</p>
      )}
    </section>
  );
}

export function EventStage({
  initial,
  showHeader = true,
  onEvent,
}: {
  initial: EventPublic;
  showHeader?: boolean;
  /** Every fresh copy of this event, for a parent that has to outlive the page moving on. Must be
      stable across renders — it is a dependency of the poll. */
  onEvent?: (e: EventPublic) => void;
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
  // Once it is finished, the only question left is whether the channel has moved on, so poll the
  // channel list instead and refresh the moment it carries a different event. A one-shot refresh
  // at the flip missed a next event that was still rendering when this one ended, and the page
  // then sat on the archive until a reload.
  useEffect(() => {
    let finished = FINISHED.has(event.state);
    const id = setInterval(() => {
      if (finished) {
        fetch("/api/channels")
          .then((r) => (r.ok ? (r.json() as Promise<ChannelPublic[]>) : null))
          .then((channels) => {
            const current = channels?.find((c) => c.id === event.channelId)?.current;
            if (!current || current.id === event.id) return;
            // The refresh has to run before the clear: it re-renders the server component, which
            // is what lets a channel page rotate to the next event.
            router.refresh();
            clearInterval(id);
          })
          .catch(() => {});
        return;
      }
      fetch(`/api/events/${event.id}`)
        .then((r) => (r.ok ? (r.json() as Promise<EventPublic>) : null))
        .then((e) => {
          if (!e) return;
          setEvent(e);
          onEvent?.(e);
          finished = FINISHED.has(e.state);
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- event.state seeds `finished` once; the poll tracks it after
  }, [event.id, event.channelId, router, onEvent]);

  return (
    <>
      <div className="grid bg-vac lg:grid-cols-[1fr_460px]">
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

          {/* The clock, and the round it is counting toward, are one fact — so they are one block,
              and it sits above the monitor rather than under it. What the event IS is the thing a
              viewer has to see first; the picture is what it looks like. */}
          <div className="grid gap-x-2 border-b border-line px-2 py-2 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="min-w-0">
              {event.state === "BETTING" ? (
                <>
                  <p className="tag">betting closes in</p>
                  <Countdown
                    to={event.lockTime}
                    className="money mt-1 block text-[clamp(64px,9vw,120px)] leading-[0.82] text-amber"
                    // Inside ten seconds the clock stops being a readout and becomes a deadline.
                    urgentClassName="money mt-1 block text-[clamp(64px,9vw,120px)] leading-[0.82] text-flare"
                  />
                </>
              ) : event.state === "LOCKED" || event.state === "RESOLVE" ? (
                <>
                  <p className="tag">round lands in</p>
                  <p
                    suppressHydrationWarning
                    className={`money mt-1 text-[clamp(64px,9vw,120px)] leading-[0.82] ${
                      landsIn !== null && landsIn <= URGENT_MS ? "text-flare" : "text-amber"
                    }`}
                  >
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

            {/* The round decides this event, so it is a fact at the mid step, not a footnote. */}
            <dl className="mt-2 flex gap-x-4 sm:mt-0 sm:justify-end">
              <div>
                <dt className="tag">drand round</dt>
                <dd className="mid mt-1 text-bone">{event.drandRound ?? "—"}</dd>
              </div>
              <div>
                <dt className="tag">publishes</dt>
                <dd className="mid mt-1 text-bone" suppressHydrationWarning>
                  {event.drandRound ? new Date(roundAtMs(event.drandRound)).toLocaleTimeString() : "—"}
                </dd>
              </div>
            </dl>
          </div>

          <Screen event={event} now={now} mounted={mounted} />

          {/* The house rule is the product's argument, so it is read at reading size on a measure
              that can be read, and the derivation is set as the feature it is rather than as the
              smallest type on the page. */}
          <dl className="grid max-w-[64ch] grid-cols-[78px_1fr] gap-x-2 gap-y-2 border-b border-line px-2 py-2">
            <dt className="tag pt-1">payout</dt>
            <dd className="copy text-dim">
              Winners split their market&rsquo;s pool, less a <span className="text-bone">2%</span> fee. No house
              position.
            </dd>
            <dt className="tag pt-1">result</dt>
            <dd className="copy text-dim">
              <span className="mid block break-words text-bone">keccak256(signature ‖ eventId) mod n</span>
              over the round above — fixed before betting opens, non-existent until it publishes.
            </dd>
            <dt className="tag pt-1">refund</dt>
            <dd className="copy text-dim">
              A market whose winning side held under <span className="text-bone">1/n</span> of its pool is void:
              every stake comes back in full, no fee.
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
