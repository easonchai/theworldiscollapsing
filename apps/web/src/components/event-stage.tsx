"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { identOf } from "@/lib/channels";
import { roundTime } from "@/lib/chain";
import type { EventPublic } from "@/lib/public";
import { tickerLines } from "@/lib/ticker";
import { Chyron, Countdown, StateBadge, clock, useNow, usdc } from "./bits";
import { ClaimButton, Markets, claimableOf, useMarkets } from "./markets";
import { Player } from "./player";
import { VerifyBadge } from "./verify-badge";

const roundAtMs = (round: string) => Number(roundTime(BigInt(round))) * 1000;

/** How long a studio card stays on screen once its cue passes. */
const CARD_MS = 3500;

/**
 * The graphic the broadcast cuts to between first-half clips (PRD story 11): it paces the broadcast
 * and masks the join between two independently generated clips. Cues are seconds into the first
 * half, so it only runs while the first half is playing to the on-chain clock.
 */
function StudioCard({ event, now }: { event: EventPublic; now: number | null }) {
  if (now === null || event.state !== "BETTING" || !event.startTime) return null;
  const elapsed = now - Date.parse(event.startTime);
  const card = event.cards.find((c) => elapsed >= c.at * 1000 && elapsed < c.at * 1000 + CARD_MS);
  if (!card) return null;
  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-vac/92 text-center">
      <div className="px-3">
        <p className="tag text-amber">studio</p>
        <p className="mt-1 font-display text-[clamp(26px,5vw,58px)] leading-none font-bold text-bone uppercase">
          {card.title}
        </p>
        <ul className="mt-3 flex flex-wrap justify-center gap-2">
          {card.stats.map((stat, i) => (
            <li key={i} className="chip border-line text-dim">
              {stat}
            </li>
          ))}
        </ul>
      </div>
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
 * The monitor: one dimmed picture under a scanline mask, and one keyed lower-third band that says
 * which channel this is and what it is doing. Every number lives in the strip below instead, so no
 * fact is stated twice in two different treatments.
 */
function Screen({ event, now, mounted }: { event: EventPublic; now: number; mounted: boolean }) {
  const ident = identOf(event.channelId);
  const locked = event.state === "LOCKED" || event.state === "RESOLVE";

  return (
    <div className="relative border-b border-line bg-black">
      {/* Held at phosphor-off luminance: this is a monitor in a dark gallery, not a colour-bar
          poster, and the amber clock below it has to stay the brightest thing on the page. */}
      <div style={{ filter: `hue-rotate(${ident.hue}deg) saturate(0.34) brightness(0.34) contrast(1.06)` }}>
        {/* 38dvh, so the strip and the two prose blocks under it clear the chyron on a laptop. */}
        <Player event={event} className="aspect-video max-h-[38dvh] w-full" />
      </div>
      <span className="signal" aria-hidden />

      <div className="slate absolute inset-x-0 bottom-0 z-10 flex items-center gap-2 px-2 pt-6 pb-2">
        <span className="num text-[12px] leading-none text-dim">CH {ident.num}</span>
        <span className="text-[12px] leading-none font-medium tracking-[0.2em] text-bone uppercase">
          {event.channelId}
        </span>
        <span className="ml-auto">
          <StateBadge state={event.state} />
        </span>
      </div>

      {locked ? (
        <div className="absolute inset-0 z-20 grid place-items-center bg-vac/75 text-center">
          <div>
            <p className="font-display text-[clamp(38px,7vw,84px)] leading-none font-bold text-amber uppercase">
              Locked
            </p>
            <p className="mt-2 text-[13px] text-dim">The ending does not exist yet.</p>
          </div>
        </div>
      ) : null}

      <StudioCard event={event} now={mounted ? now : null} />
    </div>
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
      <div className="grid bg-vac lg:grid-cols-[1fr_380px]">
        <div className="min-w-0 bg-vac">
          {showHeader ? (
            <header className="border-b border-line px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                {/* Channel identity is a hue only on the wall, where four channels sit side by side.
                    On one channel's own page it buys nothing, so the chrome stays amber and bone. */}
                <Link href={`/c/${event.channelId}`} className="chip hover:bg-amber hover:text-black">
                  CH {ident.num} {event.channelId}
                </Link>
                <span className="tag">event {String(event.seq).padStart(3, "0")}</span>
              </div>
              <h1 className="mt-2 text-[clamp(30px,4.4vw,58px)] text-bone">{event.title}</h1>
              {/* The premise is prose, so it is set as prose: sentence case, mono, 13px/1.5. */}
              <p className="mt-2 max-w-[70ch] text-[13px] leading-[1.5] text-dim">{event.premise}</p>
            </header>
          ) : null}

          <Screen event={event} now={now} mounted={mounted} />

          {/* The strip carries every number on the page exactly once, and its first cell is the
              single hero fact: whatever clock this event is currently running against. */}
          <div className="grid grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-[1.5fr_1fr_1fr_1.3fr]">
            <div className="bg-vac px-2 py-2">
              {event.state === "BETTING" ? (
                <>
                  <p className="tag-lg">betting closes in</p>
                  <Countdown to={event.lockTime} className="money mt-1 block text-[64px] leading-[0.85] text-amber" />
                </>
              ) : event.state === "LOCKED" || event.state === "RESOLVE" ? (
                <>
                  <p className="tag-lg">round lands in</p>
                  <p className="money mt-1 text-[64px] leading-[0.85] text-amber" suppressHydrationWarning>
                    {landsIn === null || !mounted ? "—" : clock(landsIn)}
                  </p>
                </>
              ) : resolved ? (
                <>
                  <p className="tag-lg">result</p>
                  <p className="mt-1 font-display text-[clamp(22px,2.4vw,34px)] leading-[0.95] font-bold text-bone uppercase">
                    {event.outcomes[event.outcome!]}
                  </p>
                </>
              ) : (
                <>
                  <p className="tag-lg">status</p>
                  <p className="money mt-1 text-[34px] leading-none text-dim">{event.state.toLowerCase()}</p>
                </>
              )}
            </div>
            <Cell label="drand round">{event.drandRound ?? "—"}</Cell>
            <Cell label="round publishes">
              <span suppressHydrationWarning>
                {event.drandRound ? new Date(roundAtMs(event.drandRound)).toLocaleTimeString() : "—"}
              </span>
            </Cell>
            <div className="grid bg-vac p-2">
              <Link href="/verify" className="btn btn-primary h-full text-center">
                Verify and take the faucet
              </Link>
            </div>
          </div>

          {/* The two things a bettor has to read before staking, on the same grid as the numbers
              above them. */}
          <div className="grid gap-px bg-line sm:grid-cols-2">
            <section className="bg-vac px-2 py-2">
              <p className="tag">house rules</p>
              <ul className="mt-1 space-y-1 text-[13px] leading-[1.5] break-words text-dim">
                <li>
                  Winners split the pool of the market they were right about, less a{" "}
                  <span className="text-bone">2%</span> fee. There is no house position.
                </li>
                <li>
                  The result is <span className="text-bone">keccak256(signature ‖ eventId) mod n</span> over the drand
                  round above, fixed on chain before betting opens and non-existent until it publishes.
                </li>
                <li>A market nobody won refunds every stake in full.</li>
              </ul>
            </section>
            <section className="bg-vac px-2 py-2">
              <p className="tag">verify to bet</p>
              <p className="mt-1 text-[13px] leading-[1.5] text-dim">
                The faucet and the bet button are gated on chain: one verification per address, then play USDC and
                every market of every event.
              </p>
            </section>
          </div>
        </div>

        <aside className="flex min-w-0 flex-col border-t border-line bg-vac lg:sticky lg:top-[46px] lg:max-h-[calc(100dvh-78px)] lg:self-start lg:overflow-y-auto lg:border-t-0 lg:border-l">
          <Markets event={event} markets={markets} refresh={refresh} />

          {resolved ? (
            <div className="flex flex-col gap-2 border-t border-line bg-vac p-2">
              <div className="panel border-amber/40 p-2">
                <p className="tag">your claim</p>
                <p className="money mt-1 text-[26px] leading-none text-amber">{usdc(claimable)} USDC</p>
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

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-vac px-2 py-2">
      <p className="tag">{label}</p>
      <p className="num mt-1 text-[14px] text-bone">{children}</p>
    </div>
  );
}
