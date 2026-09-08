"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { identOf } from "@/lib/channels";
import type { ChannelPublic } from "@/lib/data";
import type { EventPublic } from "@/lib/public";
import { Chyron, Countdown, StateBadge } from "./bits";
import { Player } from "./player";

/** hero = the switched feed, second = the wide preview, strip = a row in the switcher list. */
type Size = "hero" | "second" | "strip";

/**
 * The right-hand readout of a tile. Every phase shows a different number, so a wall of four
 * channels never reads as the same card printed four times.
 */
function Readout({ event, size }: { event: EventPublic; size: Size }) {
  const big =
    size === "hero"
      ? "block text-[clamp(40px,4.6vw,76px)] leading-[0.82]"
      : size === "second"
        ? "block text-[clamp(26px,2.6vw,44px)] leading-[0.85]"
        : "block text-[22px] leading-none";
  const small =
    size === "hero" ? "block text-[clamp(15px,1.5vw,22px)] leading-tight" : "block text-[13px] leading-tight";
  const label = size === "strip" ? "tag block" : "tag-lg block";

  if (event.state === "BETTING" && event.lockTime) {
    return (
      <>
        <span className={label}>locks in</span>
        <Countdown to={event.lockTime} className={`money ${big} text-amber`} />
      </>
    );
  }
  if (event.state === "LOCKED" || event.state === "RESOLVE") {
    return (
      <>
        <span className={label}>round</span>
        <span className={`money ${small} text-amber`}>{event.drandRound ?? "—"}</span>
      </>
    );
  }
  if (event.outcome !== null) {
    return (
      <>
        <span className={label}>result</span>
        <span className={`${small} max-w-[18ch] text-bone`}>{event.outcomes[event.outcome]}</span>
      </>
    );
  }
  return (
    <>
      <span className={label}>status</span>
      <span className={`${small} text-dim`}>{event.state.toLowerCase()}</span>
    </>
  );
}

/**
 * Four channels carrying the same generated footage must not frame it identically: each one is
 * pushed into its own corner of the picture, and the switcher strips punch in far enough that the
 * corner artefacts of the source never repeat across the wall.
 */
function crop(num: string, size: Size): CSSProperties {
  const n = Number(num);
  const scale = size === "strip" ? 1.5 : size === "second" ? 1.24 : 1.16;
  return { transform: `scale(${scale}) translate(${n % 2 ? -5 : 5}%, ${n < 3 ? -5 : 5}%)` };
}

/** The channel bug, inset off the tile edge so it never breaks the grid line it sits on. */
function Bug({ channel, event, small }: { channel: ChannelPublic; event: EventPublic | null; small: boolean }) {
  const ident = identOf(channel.id);
  return (
    <div
      className="z-10 flex items-center gap-2 border bg-black px-2 py-1"
      style={{ borderColor: "var(--ch)" }}
    >
      <span className="num text-[12px] leading-none text-[color:var(--ch)]">CH {ident.num}</span>
      {small ? null : (
        <span className="text-[12px] leading-none font-medium tracking-[0.2em] text-bone uppercase">
          {channel.name}
        </span>
      )}
      {event ? <StateBadge state={event.state} className="border-0 p-0" /> : null}
    </div>
  );
}

function Signal({ channel, size }: { channel: ChannelPublic; size: Size }) {
  const ident = identOf(channel.id);
  const event = channel.current;
  // The picture is held at phosphor-off luminance so the amber clock over it stays the brightest
  // thing on the wall. The switcher thumbnails carry less furniture, so they can run a little hotter.
  const lum = size === "hero" ? "[--lum:0.34]" : size === "second" ? "[--lum:0.38]" : "[--lum:0.5]";
  return (
    <div
      className={`absolute inset-0 overflow-hidden ${lum} [--sat:0.34] transition-[filter] duration-500 group-hover:[--lum:0.55] group-hover:[--sat:0.6]`}
      style={{ filter: `hue-rotate(${ident.hue}deg) saturate(var(--sat)) brightness(var(--lum)) contrast(1.06)` }}
    >
      {event ? <Player event={event} className="size-full" style={crop(ident.num, size)} /> : null}
    </div>
  );
}

function Tile({ channel, size }: { channel: ChannelPublic; size: Size }) {
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

  const shell = `group relative block overflow-hidden bg-black outline-offset-[-2px] ${
    size === "hero"
      ? "beam aspect-video lg:col-span-7 lg:row-span-4 lg:aspect-auto"
      : size === "second"
        ? "aspect-video lg:col-span-5 lg:row-span-2 lg:aspect-auto"
        : "lg:col-span-5 lg:row-span-1"
  }`;

  // A switcher row: thumbnail on the left, slate on the right. No caption floats over this picture,
  // so the row reads as a line in a rundown rather than as a fourth identical card.
  if (size === "strip") {
    return (
      <Link
        ref={ref}
        href={`/c/${channel.id}`}
        aria-label={`${channel.name} — ${event?.title ?? "off air"}`}
        style={{ "--ch": ident.accent } as CSSProperties}
        className={`${shell} flex items-stretch hover:bg-panel2`}
      >
        <div className="relative aspect-video w-[38%] shrink-0 overflow-hidden bg-black">
          {event && visible ? <Signal channel={channel} size={size} /> : null}
          <span className="signal" aria-hidden />
          <div className="absolute top-1 left-1">
            <Bug channel={channel} event={null} small />
          </div>
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-between gap-2 border-l border-line px-2 py-1">
          <div className="min-w-0">
            <p className="truncate font-display text-[15px] leading-tight font-semibold text-bone uppercase">
              {event?.title ?? "no transmission"}
            </p>
            <p className="num mt-0.5 truncate text-[11px] tracking-[0.12em] text-dim uppercase">
              {event ? `${channel.name} · seq ${String(event.seq).padStart(3, "0")}` : "off air"}
            </p>
          </div>
          {event ? (
            <div className="shrink-0 text-right">
              <Readout event={event} size={size} />
            </div>
          ) : null}
        </div>
      </Link>
    );
  }

  return (
    <Link
      ref={ref}
      href={`/c/${channel.id}`}
      aria-label={`${channel.name} — ${event?.title ?? "off air"}`}
      style={{ "--ch": ident.accent } as CSSProperties}
      className={shell}
    >
      {event && visible ? (
        <Signal channel={channel} size={size} />
      ) : (
        <div className="absolute inset-0 grid place-items-center">
          <span className="tag">{event ? "standby" : "off air"}</span>
        </div>
      )}

      <span className="signal" aria-hidden />

      <div className="absolute top-1 left-1">
        <Bug channel={channel} event={event} small={false} />
      </div>

      {/* keyed lower-third: the picture fades into the type under one amber hairline */}
      <div className="slate absolute inset-x-0 bottom-0 z-10">
        <div className="flex items-end justify-between gap-3 px-2 pt-4 pb-2">
          <div className="min-w-0">
            {size === "hero" ? (
              <>
                <h2 className="text-[clamp(24px,2.7vw,46px)] text-bone">{event?.title ?? "no transmission"}</h2>
                <p className="mt-1 truncate text-[12px] tracking-[0.12em] text-dim uppercase">
                  {event
                    ? `${event.outcomes.length} markets · parimutuel 2% fee · seq ${String(event.seq).padStart(3, "0")}`
                    : "this channel has not gone on air yet"}
                </p>
              </>
            ) : (
              <>
                <h2 className="text-[clamp(17px,1.7vw,26px)] text-bone">{event?.title ?? "no transmission"}</h2>
                <p className="num mt-1 truncate text-[11px] tracking-[0.12em] text-dim uppercase">
                  {event ? `seq ${String(event.seq).padStart(3, "0")} · ${event.outcomes.length} markets` : "off air"}
                </p>
              </>
            )}
          </div>
          {event ? (
            <div className="shrink-0 text-right">
              <Readout event={event} size={size} />
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

  // A switcher, not a dashboard: one screen on air, one wide preview beside it, the rest as rows in
  // the rundown. 46px bar + 32px chyron + 14px of air below the last row.
  const [lead, second, ...rest] = channels;

  // Whatever the world last decided, running along the bottom of the wall.
  const canon = channels.flatMap((c) => c.canon.slice(-2).map((line) => ({ cat: c.name, text: line })));

  return (
    <div className="relative">
      <div className="mb-[14px] grid gap-px bg-line lg:h-[calc(100dvh-92px)] lg:grid-cols-12 lg:grid-rows-4">
        <Tile channel={lead} size="hero" />
        {second ? <Tile key={second.id} channel={second} size="second" /> : null}
        {rest.map((c) => (
          <Tile key={c.id} channel={c} size="strip" />
        ))}
      </div>

      <Chyron label="canon" lines={canon} empty="nothing has happened yet" />
    </div>
  );
}
