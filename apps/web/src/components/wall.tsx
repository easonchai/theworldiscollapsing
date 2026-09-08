"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { identOf } from "@/lib/channels";
import type { ChannelPublic } from "@/lib/data";
import { Countdown, StateBadge } from "./bits";
import { Player } from "./player";

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
        // Footage is held back a little so the station furniture always reads over it.
        <Player
          event={event}
          className="absolute inset-0 size-full saturate-[0.85] brightness-[0.82] transition duration-500 group-hover:saturate-100 group-hover:brightness-100"
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center">
          <span className="tag">{event ? "standby" : "off air"}</span>
        </div>
      )}

      {/* lower third */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black via-black/75 to-transparent p-2 pt-6">
        <div className="flex items-end justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className="font-mono text-[clamp(13px,1.5vw,18px)] leading-none text-[color:var(--ch)]"
              >
                {ident.glyph}
              </span>
              <span className="border-l-2 border-[color:var(--ch)] pl-2 font-display text-[clamp(20px,2.6vw,34px)] leading-none tracking-wide text-bone uppercase">
                {channel.name}
              </span>
              {event ? <StateBadge state={event.state} /> : null}
            </div>
            <p className="mt-1 truncate font-mono text-[11px] tracking-[0.08em] text-dim">
              {event?.title ?? "no transmission"}
            </p>
          </div>
          {event?.state === "BETTING" && event.lockTime ? (
            <span className="shrink-0 text-right">
              <span className="tag block">locks in</span>
              <Countdown to={event.lockTime} className="text-[22px] leading-none text-amber" />
            </span>
          ) : null}
        </div>
      </div>

      <span
        className="absolute inset-0 border border-transparent transition group-hover:border-[color:var(--ch)]"
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
    return (
      <p className="p-4 font-mono text-sm text-dim">
        No channels yet. Start the engine and the wall fills itself.
      </p>
    );
  }

  // Fixed furniture: channel one takes the big screen, the rest stack beside it. The wall is a
  // room, not a feed — a tile that moves every few seconds would just churn video decoders.
  const [lead, ...rest] = channels;

  // Whatever the world last decided, running along the bottom of the wall.
  const canon = channels.flatMap((c) => c.canon.slice(-2).map((line) => ({ channel: c.name, line })));

  return (
    <div className="beam relative">
      <div className="grid gap-px bg-line lg:h-[calc(100dvh-72px)] lg:grid-cols-12 lg:grid-rows-3">
        <Tile channel={lead} featured />
        {rest.map((c) => (
          <Tile key={c.id} channel={c} featured={false} />
        ))}
      </div>

      <div className="flex h-[26px] items-center border-t border-line bg-black">
        <span className="tag shrink-0 border-r border-line px-2 text-amber">canon</span>
        <div className="flex-1 overflow-hidden pl-2">
          {canon.length ? (
            <div className="marquee font-mono text-[11px] tracking-[0.1em] text-dim uppercase">
              {[...canon, ...canon].map((c, i) => (
                <span key={i}>
                  <span className="mr-2 text-bone">{c.channel}</span>
                  {c.line}
                </span>
              ))}
            </div>
          ) : (
            <span className="font-mono text-[11px] tracking-[0.1em] text-dim uppercase">nothing has happened yet</span>
          )}
        </div>
      </div>
    </div>
  );
}
