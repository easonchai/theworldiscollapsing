"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
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
        <p className="mt-1 font-display text-[clamp(26px,5vw,58px)] leading-none text-bone uppercase">{card.title}</p>
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
 * The monitor: the signal plus the furniture a real feed carries inside its own frame — channel
 * bug, phase, the clock and the round this event is committed to. Dead air is a state, not the
 * resting state, so the frame always says what it is doing.
 */
function Screen({ event, now, mounted }: { event: EventPublic; now: number; mounted: boolean }) {
  const ident = identOf(event.channelId);
  const locked = event.state === "LOCKED" || event.state === "RESOLVE";
  const landsIn = event.drandRound ? roundAtMs(event.drandRound) - now : null;

  return (
    <div className="relative border-b border-line bg-black" style={{ "--ch": ident.accent } as CSSProperties}>
      {/* The picture is held at well under the source's saturation: this is a monitor in a dark
          gallery, not a colour-bar poster, and the amber furniture has to survive on top of it. */}
      <div style={{ filter: `hue-rotate(${ident.hue}deg) saturate(0.46) contrast(1.08)` }}>
        <Player event={event} className="aspect-video max-h-[44dvh] w-full" />
      </div>
      <span className="signal" aria-hidden />

      <div
        className="absolute top-0 left-0 z-10 flex items-center gap-2 border-r border-b bg-black px-2 py-1"
        style={{ borderColor: "var(--ch)" }}
      >
        <span className="num text-[12px] leading-none text-[color:var(--ch)]">CH {ident.num}</span>
        <span className="text-[12px] leading-none font-medium tracking-[0.2em] text-bone uppercase">
          {event.channelId}
        </span>
      </div>

      <div className="absolute top-0 right-0 z-10 border-b border-l border-line bg-black px-2 py-1">
        <StateBadge state={event.state} className="border-0 p-0" />
      </div>

      {event.state === "BETTING" ? (
        <div className="absolute bottom-0 left-0 z-10 border-t border-r border-line bg-black px-2 py-1">
          <span className="tag block">betting closes in</span>
          <Countdown to={event.lockTime} className="block text-[clamp(30px,4.2vw,56px)] leading-[0.85] text-amber" />
        </div>
      ) : event.outcome !== null ? (
        <div className="absolute bottom-0 left-0 z-10 max-w-[60%] border-t border-r border-line bg-black px-2 py-1">
          <span className="tag block">result</span>
          <span className="block font-display text-[clamp(20px,2.6vw,34px)] leading-none text-bone">
            {event.outcomes[event.outcome]}
          </span>
        </div>
      ) : null}

      <div className="absolute right-0 bottom-0 z-10 border-t border-l border-line bg-black px-2 py-1 text-right">
        <span className="tag block">drand round</span>
        <span className="num text-[13px] text-bone">{event.drandRound ?? "—"}</span>
      </div>

      {locked ? (
        <div className="absolute inset-0 z-20 grid place-items-center bg-vac/75 text-center">
          <div>
            <p className="font-display text-[clamp(38px,7vw,84px)] leading-none text-amber">Locked</p>
            <p className="mt-2 num text-[13px] text-bone">
              round <span className="text-amber">{event.drandRound}</span> lands in{" "}
              <span className="text-amber" suppressHydrationWarning>
                {landsIn === null || !mounted ? "—" : clock(landsIn)}
              </span>
            </p>
            <p className="mt-1 num text-[11px] text-dim">the ending does not exist yet</p>
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
                <Link
                  href={`/c/${event.channelId}`}
                  style={{ "--ch": ident.accent } as CSSProperties}
                  className="chip border-[color:var(--ch)] text-[color:var(--ch)] hover:bg-[color:var(--ch)] hover:text-black"
                >
                  CH {ident.num} {event.channelId}
                </Link>
                <span className="tag">event {String(event.seq).padStart(3, "0")}</span>
                <StateBadge state={event.state} />
              </div>
              <h1 className="mt-2 text-[clamp(30px,4.4vw,58px)] text-bone">{event.title}</h1>
              {/* the one editorial voice on the page */}
              <p className="mt-1 max-w-[70ch] font-body text-[17px] text-dim italic">{event.premise}</p>
            </header>
          ) : null}

          <Screen event={event} now={now} mounted={mounted} />

          <dl className="grid grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-4">
            <Cell label="betting closes">
              {event.state === "BETTING" ? (
                <Countdown to={event.lockTime} className="text-amber" />
              ) : (
                <span className="text-dim">closed</span>
              )}
            </Cell>
            <Cell label="drand round">{event.drandRound ?? "—"}</Cell>
            <Cell label="round publishes">
              <span suppressHydrationWarning>
                {event.drandRound ? new Date(roundAtMs(event.drandRound)).toLocaleTimeString() : "—"}
              </span>
            </Cell>
            <Cell label="outcome">
              {resolved ? <span className="text-bone">{event.outcomes[event.outcome!]}</span> : "undecided"}
            </Cell>
          </dl>

          {/* The band the stats strip used to leave empty: the two things a bettor has to read
              before staking, on the same grid as the numbers above them. */}
          <div className="grid gap-px bg-line sm:grid-cols-2">
            <section className="bg-vac px-2 py-2">
              <p className="tag">house rules</p>
              <ul className="mt-1 space-y-1 text-[13px] break-words text-dim">
                <li>
                  Winners split the pool of the market they were right about, less a{" "}
                  <span className="text-bone">2%</span> fee. There is no house position.
                </li>
                <li>
                  The result is <span className="text-bone">keccak256(signature ‖ eventId) mod n</span> over drand round{" "}
                  <span className="text-amber">{event.drandRound ?? "—"}</span>, fixed on chain before betting opens and
                  non-existent until it publishes.
                </li>
                <li>A market nobody won refunds every stake in full.</li>
              </ul>
            </section>
            <section className="bg-vac px-2 py-2">
              <p className="tag">verify to bet</p>
              <p className="mt-1 text-[13px] text-dim">
                The faucet and the bet button are gated on chain: one verification per address, then play USDC and
                every market of every event.
              </p>
              <Link
                href="/verify"
                className="mt-2 inline-block border-b border-amber text-[13px] tracking-[0.12em] text-amber uppercase"
              >
                verify and take the faucet
              </Link>
            </section>
          </div>
        </div>

        <aside className="flex min-w-0 flex-col border-t border-line bg-vac lg:sticky lg:top-[46px] lg:max-h-[calc(100dvh-74px)] lg:self-start lg:overflow-y-auto lg:border-t-0 lg:border-l">
          <Markets event={event} markets={markets} refresh={refresh} />

          {resolved ? (
            <div className="flex flex-col gap-2 border-t border-line bg-vac p-2">
              <div className="panel border-amber/40 p-2">
                <p className="tag">result</p>
                <p className="mt-1 font-display text-[26px] leading-none text-bone uppercase">
                  {event.outcomes[event.outcome!]}
                </p>
                <p className="mt-2 num text-[12px] text-dim">
                  your claimable <span className="text-amber">{usdc(claimable)} USDC</span>
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

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-vac px-2 py-2">
      <dt className="tag">{label}</dt>
      <dd className="num mt-1 text-[14px] text-bone">{children}</dd>
    </div>
  );
}
