"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { roundTime } from "@/lib/chain";
import type { EventPublic } from "@/lib/public";
import { Countdown, StateBadge, clock, useNow, usdc } from "./bits";
import { ClaimButton, Markets, claimableOf, useMarkets } from "./markets";
import { Player } from "./player";
import { VerifyBadge } from "./verify-badge";

const roundAtMs = (round: string) => Number(roundTime(BigInt(round))) * 1000;

function Ticker({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  const run = [...lines, ...lines];
  return (
    <div className="overflow-hidden border-t border-line bg-black/80 py-1">
      <div className="marquee font-mono text-[11px] tracking-[0.14em] text-dim uppercase">
        {run.map((line, i) => (
          <span key={i}>
            <span className="mr-2 text-amber">◆</span>
            {line}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The screen itself: synced video, the phase overlay, and the ticker. */
function Screen({ event }: { event: EventPublic }) {
  const now = useNow();
  const locked = event.state === "LOCKED" || event.state === "RESOLVE";
  const landsIn = event.drandRound ? roundAtMs(event.drandRound) - now : null;

  return (
    <div className="relative">
      <Player event={event} className="aspect-video max-h-[52dvh] w-full" />

      {locked ? (
        <div className="absolute inset-0 grid place-items-center bg-vac/72 text-center">
          <div>
            <p className="font-display text-[clamp(38px,7vw,84px)] leading-none text-flare">Locked</p>
            <p className="mt-2 num text-[13px] text-bone">
              round <span className="text-amber">{event.drandRound}</span> lands in{" "}
              <span className="text-amber" suppressHydrationWarning>
                {landsIn === null ? "—" : clock(landsIn)}
              </span>
            </p>
            <p className="mt-1 num text-[11px] text-dim">the ending does not exist yet</p>
          </div>
        </div>
      ) : null}

      {event.state === "BETTING" ? (
        <div className="absolute top-2 right-2 flex items-center gap-2">
          <StateBadge state={event.state} className="bg-black/70" />
        </div>
      ) : null}

      {event.state === "REVEAL" || event.state === "CANON" ? (
        <span className="chip absolute top-2 right-2 border-amber/70 bg-black/70 text-amber">Reveal</span>
      ) : null}

      <Ticker lines={event.ticker} />
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
    <div className="grid gap-px bg-line lg:grid-cols-[1fr_360px]">
      {/* min-w-0: the ticker is wider than the column and must be allowed to clip, not push. */}
      <div className="min-w-0 bg-vac">
        {showHeader ? (
          <header className="border-b border-line px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Link href={`/c/${event.channelId}`} className="chip border-amber/50 text-amber hover:bg-amber hover:text-black">
                {event.channelId}
              </Link>
              <span className="tag">event {String(event.seq).padStart(3, "0")}</span>
              <StateBadge state={event.state} />
            </div>
            <h1 className="mt-2 text-[clamp(30px,4.4vw,58px)] text-bone">{event.title}</h1>
            <p className="mt-1 max-w-[70ch] font-body text-[17px] text-dim italic">{event.premise}</p>
          </header>
        ) : null}

        <Screen event={event} />

        <dl className="grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-4">
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
            {resolved ? <span className="text-phos">{event.outcomes[event.outcome!]}</span> : "undecided"}
          </Cell>
        </dl>
      </div>

      <aside className="flex min-w-0 flex-col gap-px bg-line lg:max-h-[calc(100dvh-46px)] lg:overflow-y-auto">
        <div className="bg-vac">
          <Markets event={event} markets={markets} refresh={refresh} />
        </div>

        <div className="bg-vac p-2">
          <div className="panel p-2">
            <p className="tag">house rules</p>
            <ul className="mt-2 space-y-1 font-body text-[15px] text-dim">
              <li>
                Winners split the pool of the market they were right about, less a{" "}
                <span className="num text-bone">2%</span> fee. There is no house position.
              </li>
              <li>
                The result is <span className="num text-bone">keccak256(signature ‖ eventId) mod n</span> over drand
                round <span className="num text-amber">{event.drandRound ?? "—"}</span>, which is fixed on chain
                before betting opens and does not exist until it publishes.
              </li>
              <li>A market nobody won refunds every stake in full.</li>
            </ul>
          </div>
        </div>

        {resolved ? (
          <div className="flex flex-col gap-2 bg-vac p-2">
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
