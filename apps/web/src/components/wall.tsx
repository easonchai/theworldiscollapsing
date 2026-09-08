"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { identOf } from "@/lib/channels";
import { impliedYes } from "@/lib/chain";
import type { ChannelPublic } from "@/lib/data";
import type { EventPublic } from "@/lib/public";
import { Chyron, Countdown, Umd, usdc } from "./bits";
import { usePoll } from "./chain-hooks";
import { readMarket } from "./markets";
import { Player } from "./player";

/** hero = the switched feed, second = the wide preview, strip = a row in the switcher list. */
type Size = "hero" | "second" | "strip";

/** [no, yes] per market of each channel's current event, straight from chain. */
type Pools = Record<string, [bigint, bigint][]>;

const total = (pools: [bigint, bigint][] | undefined) =>
  (pools ?? []).reduce((sum, p) => sum + p[0] + p[1], 0n);

/**
 * The casino state of the whole wall in one poll: every market of every channel's current event.
 * Without it four tiles say nothing but their own name and the wall has no product on it.
 */
function useWallPools(channels: ChannelPublic[]): Pools | null {
  const key = channels.map((c) => `${c.id}:${c.current?.id ?? ""}:${c.current?.outcomes.length ?? 0}`).join("|");
  return usePoll<Pools>(
    async () => {
      const entries = await Promise.all(
        channels.map(async (c) => {
          const event = c.current;
          if (!event) return [c.id, [] as [bigint, bigint][]] as const;
          const markets = await Promise.all(event.outcomes.map((_, i) => readMarket(event.id, i)));
          return [c.id, markets.map((m) => m.pool)] as const;
        }),
      );
      return Object.fromEntries(entries);
    },
    key,
    3000,
  ).value;
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

/**
 * The picture at full brightness under one interlace: a tile is either a crisp signal or a hard
 * black standby slate, never a dimmed wash. Hue is the channel's identity, nothing is dimmed.
 */
function Signal({ channel, size }: { channel: ChannelPublic; size: Size }) {
  const ident = identOf(channel.id);
  const event = channel.current;
  return (
    <div className="absolute inset-0 overflow-hidden" style={{ filter: `hue-rotate(${ident.hue}deg)` }}>
      {event ? <Player event={event} className="size-full" style={crop(ident.num, size)} /> : null}
    </div>
  );
}

/** One market of the hero event: the question, its pool, and where the money sits. */
function MarketRow({ label, pool }: { label: string; pool: [bigint, bigint] | undefined }) {
  const yes = pool ? impliedYes(pool) : null;
  const sum = pool ? pool[0] + pool[1] : 0n;
  return (
    <li className="grid grid-cols-[1fr_88px_84px_40px] items-center gap-2 border-t border-line py-1">
      <span className="truncate font-mono text-[12px] tracking-[0.06em] text-bone uppercase">{label}</span>
      <span className={`num text-right text-[12px] ${sum === 0n ? "text-dim" : "text-bone"}`}>
        {pool ? usdc(sum) : "—"}
      </span>
      <span className="odds-bar" aria-hidden>
        <span style={{ width: `${Math.round((yes ?? 0) * 100)}%` }} />
      </span>
      <span className="num text-right text-[12px] text-dim">{yes === null ? "—" : `${Math.round(yes * 100)}%`}</span>
    </li>
  );
}

/**
 * The one clock on the wall. Only the switched feed carries it, so four tiles never print the same
 * countdown four times, and amber is spent on exactly this.
 */
function HeroClock({ event }: { event: EventPublic }) {
  if (event.state === "BETTING" && event.lockTime) {
    return (
      <>
        <span className="tag block">locks in</span>
        <Countdown to={event.lockTime} className="money block text-[clamp(40px,4.6vw,76px)] leading-[0.82] text-amber" />
      </>
    );
  }
  if (event.state === "LOCKED" || event.state === "RESOLVE") {
    return (
      <>
        <span className="tag block">drand round</span>
        <span className="money block text-[clamp(22px,2.2vw,34px)] leading-none text-bone">
          {event.drandRound ?? "—"}
        </span>
      </>
    );
  }
  if (event.outcome !== null) {
    return (
      <>
        <span className="tag block">result</span>
        <span className="money block max-w-[22ch] text-[clamp(18px,1.8vw,28px)] leading-tight text-bone uppercase">
          {event.outcomes[event.outcome]}
        </span>
      </>
    );
  }
  return (
    <>
      <span className="tag block">status</span>
      <span className="money block text-[clamp(18px,1.8vw,28px)] leading-none text-dim">
        {event.state.toLowerCase()}
      </span>
    </>
  );
}

function Tile({ channel, size, pools }: { channel: ChannelPublic; size: Size; pools: Pools | null }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const [visible, setVisible] = useState(false);
  const event = channel.current;
  const mine = pools?.[channel.id];
  const pool = pools ? usdc(total(mine)) : "—";

  // Only tiles on screen carry a <video src>, so four decoders never run for a wall of forty.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "120px" });
    io.observe(node);
    return () => io.disconnect();
  }, []);

  // One 8-column grid: the switched feed takes five of them, the rundown three.
  const shell = `group relative block overflow-hidden bg-black outline-offset-[-2px] ${
    size === "hero"
      ? "aspect-video lg:col-span-5 lg:row-span-4 lg:aspect-auto"
      : size === "second"
        ? "aspect-video lg:col-span-3 lg:row-span-2 lg:aspect-auto"
        : "lg:col-span-3 lg:row-span-1"
  }`;

  // A switcher row: thumbnail on the left, one headline and one number on the right. No countdown
  // and no repeated meta — the rundown says what the hero does not.
  if (size === "strip") {
    return (
      <Link
        ref={ref}
        href={`/c/${channel.id}`}
        aria-label={`${channel.name} — ${event?.title ?? "off air"}`}
        className={`${shell} flex items-stretch hover:bg-panel2`}
      >
        <div className="relative aspect-video w-[38%] shrink-0 overflow-hidden bg-black">
          {event && visible ? <Signal channel={channel} size={size} /> : null}
          <span className="signal" aria-hidden />
        </div>
        {/* The UMD hangs off the tile's top-left corner like every other channel's; a rundown row is
            too narrow to hold it inside the thumbnail without wrapping the label. */}
        <div className="absolute top-2 left-2">
          <Umd channelId={channel.id} name={channel.name} state={event?.state} />
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-between gap-2 border-l border-line px-2 py-2">
          <div className="min-w-0">
            <p className="truncate font-display text-[15px] leading-tight font-semibold text-bone uppercase">
              {event?.title ?? "no transmission"}
            </p>
            <p className="tag mt-1 truncate">{event ? `seq ${String(event.seq).padStart(3, "0")}` : "off air"}</p>
          </div>
          {event ? (
            <div className="shrink-0 text-right">
              <span className="tag block">pool</span>
              <span className="money block text-[22px] leading-none text-bone">{pool}</span>
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
      className={shell}
    >
      {event && visible ? (
        <Signal channel={channel} size={size} />
      ) : (
        // No dimmed wash for a source that is not there: hard black and a slate that says so.
        <div className="absolute inset-0 grid place-items-center bg-black">
          <span className="tag">{event ? "standby" : "no signal"}</span>
        </div>
      )}

      <span className="signal" aria-hidden />

      <div className="absolute top-2 left-2">
        <Umd channelId={channel.id} name={channel.name} state={event?.state} />
      </div>

      {/* The lower third: a solid black plate punched through the picture, carrying the casino. */}
      <div className="slate absolute inset-x-0 bottom-0 z-10 px-2 py-2">
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <h2
              className={`text-bone ${size === "hero" ? "line-clamp-2 text-[clamp(22px,2.2vw,34px)]" : "truncate text-[clamp(16px,1.5vw,22px)]"}`}
            >
              {event?.title ?? "no transmission"}
            </h2>
            <p className="tag mt-1 truncate">
              {event
                ? `seq ${String(event.seq).padStart(3, "0")} · ${event.outcomes.length} markets · pool ${pool} usdc`
                : "this channel has not gone on air yet"}
            </p>
          </div>
          {event && size === "hero" ? (
            <div className="shrink-0 text-right">
              <HeroClock event={event} />
            </div>
          ) : null}
        </div>

        {/* The hero shows the board itself; the preview shows one line of it. */}
        {event && size === "hero" ? (
          <ul className="mt-2">
            {event.outcomes.map((label, i) => (
              <MarketRow key={i} label={label} pool={mine?.[i]} />
            ))}
          </ul>
        ) : null}
      </div>

      <span className="absolute inset-0 z-10 border border-transparent transition group-hover:border-bone" aria-hidden />
    </Link>
  );
}

export function Wall({ initial }: { initial: ChannelPublic[] }) {
  const [channels, setChannels] = useState(initial);
  const pools = useWallPools(channels);

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
    return <p className="prose p-2 text-dim">No channels yet. Start the engine and the wall fills itself.</p>;
  }

  // A switcher, not a dashboard: one screen on air, one wide preview beside it, the rest as rows in
  // the rundown. 46px bar + 46px chyron inset + 14px of air below the last row.
  const [lead, second, ...rest] = channels;

  // Whatever the world last decided, running along the bottom of the wall.
  const canon = channels.flatMap((c) => c.canon.slice(-2).map((line) => ({ cat: c.name, text: line })));

  return (
    <div className="relative">
      <div className="mb-[14px] grid gap-px bg-line lg:h-[calc(100dvh-106px)] lg:grid-cols-8 lg:grid-rows-4">
        <Tile channel={lead} size="hero" pools={pools} />
        {second ? <Tile key={second.id} channel={second} size="second" pools={pools} /> : null}
        {rest.map((c) => (
          <Tile key={c.id} channel={c} size="strip" pools={pools} />
        ))}
      </div>

      <Chyron label="canon" lines={canon} empty="nothing has happened yet" />
    </div>
  );
}
