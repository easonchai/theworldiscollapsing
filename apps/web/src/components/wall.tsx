"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { identOf } from "@/lib/channels";
import type { ChannelPublic } from "@/lib/data";
import type { EventPublic } from "@/lib/public";
import { Chyron, Countdown, StateBadge } from "./bits";
import { Player } from "./player";

/**
 * The right-hand readout of a tile. Every phase shows a different number, so a wall of four
 * channels never reads as the same card printed four times.
 */
function Readout({ event, featured }: { event: EventPublic; featured: boolean }) {
  const big = featured
    ? "block text-[clamp(34px,4vw,68px)] leading-[0.82] tracking-[-0.02em]"
    : "block text-[20px] leading-none";
  const small = featured ? "block text-[clamp(15px,1.5vw,22px)] leading-tight" : "block text-[13px] leading-tight";

  if (event.state === "BETTING" && event.lockTime) {
    return (
      <>
        <span className="tag block">locks in</span>
        <Countdown to={event.lockTime} className={`${big} text-amber`} />
      </>
    );
  }
  if (event.state === "LOCKED" || event.state === "RESOLVE") {
    return (
      <>
        <span className="tag block">round</span>
        <span className={`num ${small} text-amber`}>{event.drandRound ?? "—"}</span>
      </>
    );
  }
  if (event.outcome !== null) {
    return (
      <>
        <span className="tag block">result</span>
        <span className={`${small} max-w-[18ch] text-bone`}>{event.outcomes[event.outcome]}</span>
      </>
    );
  }
  return (
    <>
      <span className="tag block">status</span>
      <span className={`${small} text-dim`}>{event.state.toLowerCase()}</span>
    </>
  );
}

/**
 * Four channels carrying the same generated footage must not frame it identically: each one is
 * pushed into its own corner of the picture, so a streak that crosses every feed never crosses
 * four screens at the same point.
 */
function crop(num: string): CSSProperties {
  const n = Number(num);
  return { transform: `scale(1.16) translate(${n % 2 ? -4 : 4}%, ${n < 3 ? -4 : 4}%)` };
}

function Tile({ channel, featured }: { channel: ChannelPublic; featured: boolean }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const [visible, setVisible] = useState(false);
  const event = channel.current;
  const ident = identOf(channel.id);

  // Only tiles on screen carry a <video src>, so four decoders never run for a wall of forty.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "120px" });
    io.observe(node);
    return () => io.disconnect();
  }, []);

  return (
    <Link
      ref={ref}
      href={`/c/${channel.id}`}
      aria-label={`${channel.name} — ${event?.title ?? "off air"}`}
      style={{ "--ch": ident.accent } as CSSProperties}
      className={`group relative block overflow-hidden bg-black outline-offset-[-2px] aspect-video lg:aspect-auto ${
        featured ? "lg:col-span-7 lg:row-span-3" : "lg:col-span-5"
      }`}
    >
      {event && visible ? (
        // Each channel tints its own signal, so identical footage still reads as four channels, and
        // the saturation is held well under the source's so the amber furniture survives over it.
        <div
          className="absolute inset-0 overflow-hidden [--sat:0.42] transition-[filter] duration-500 group-hover:[--sat:0.8]"
          style={{ filter: `hue-rotate(${ident.hue}deg) saturate(var(--sat)) contrast(1.08)` }}
        >
          <Player event={event} className="size-full" style={crop(ident.num)} />
        </div>
      ) : (
        <div className="absolute inset-0 grid place-items-center">
          <span className="tag">{event ? "standby" : "off air"}</span>
        </div>
      )}

      <span className="signal" aria-hidden />

      {/* channel bug, the way a broadcaster corners its own screen */}
      <div
        className="absolute top-0 left-0 z-10 flex items-center gap-2 border-r border-b bg-black px-2 py-1"
        style={{ borderColor: "var(--ch)" }}
      >
        <span className="num text-[12px] leading-none text-[color:var(--ch)]">CH {ident.num}</span>
        <span className="text-[12px] leading-none font-medium tracking-[0.2em] text-bone uppercase">
          {channel.name}
        </span>
        {event ? <StateBadge state={event.state} className="border-0 p-0" /> : null}
      </div>

      {/* caption band: solid black under the type, one hairline rule, no scanlines through words */}
      <div className="absolute inset-x-0 bottom-0 z-10 border-t bg-black" style={{ borderColor: "var(--ch)" }}>
        <div className="flex items-end justify-between gap-3 px-2 py-2">
          <div className="min-w-0">
            {featured ? (
              <>
                <h2 className="font-display text-[clamp(24px,2.7vw,46px)] leading-[0.9] text-bone">
                  {event?.title ?? "no transmission"}
                </h2>
                <p className="mt-1 truncate text-[12px] tracking-[0.12em] text-dim uppercase">
                  {event
                    ? `${event.outcomes.length} markets · parimutuel 2% fee · seq ${String(event.seq).padStart(3, "0")}`
                    : "this channel has not gone on air yet"}
                </p>
              </>
            ) : (
              <>
                <p className="truncate text-[13px] leading-tight text-bone">{event?.title ?? "no transmission"}</p>
                <p className="num mt-0.5 text-[11px] tracking-[0.12em] text-dim uppercase">
                  {event ? `seq ${String(event.seq).padStart(3, "0")} · ${event.outcomes.length} markets` : "off air"}
                </p>
              </>
            )}
          </div>
          {event ? (
            <div className="shrink-0 text-right">
              <Readout event={event} featured={featured} />
            </div>
          ) : null}
        </div>
      </div>

      <span
        className="absolute inset-0 z-10 border border-transparent transition group-hover:border-[color:var(--ch)]"
        aria-hidden
      />
    </Link>
  );
}

export function Wall({ initial }: { initial: ChannelPublic[] }) {
  const [channels, setChannels] = useState(initial);

  useEffect(() => {
    const tick = () =>
      fetch("/api/channels")
        .then((r) => r.json() as Promise<ChannelPublic[]>)
        .then(setChannels)
        .catch(() => {});
    const id = setInterval(tick, 3000);
    return () => clearInterval(id);
  }, []);

  if (!channels.length) {
    return <p className="p-4 text-[13px] text-dim">No channels yet. Start the engine and the wall fills itself.</p>;
  }

  // Fixed furniture: channel one takes the big screen, the rest stack beside it. The wall is a
  // room, not a feed — a tile that moves every few seconds would just churn video decoders.
  const [lead, ...rest] = channels;

  // Whatever the world last decided, running along the bottom of the wall.
  const canon = channels.flatMap((c) => c.canon.slice(-2).map((line) => ({ cat: c.name, text: line })));

  return (
    <div className="beam relative">
      <div className="grid gap-px bg-line lg:h-[calc(100dvh-74px)] lg:grid-cols-12 lg:grid-rows-3">
        <Tile channel={lead} featured />
        {rest.map((c) => (
          <Tile key={c.id} channel={c} featured={false} />
        ))}
      </div>

      <Chyron label="canon" lines={canon} empty="nothing has happened yet" />
    </div>
  );
}
