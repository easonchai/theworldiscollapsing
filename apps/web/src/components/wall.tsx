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
 * pushed into its own corner of the picture, and every tile punches in far enough that the corner
 * artefacts of the source are cropped off rather than repeated across the wall.
 */
function crop(num: string, size: Size): CSSProperties {
  const n = Number(num);
  const scale = size === "strip" ? 1.4 : size === "second" ? 1.2 : 1.08;
  return { transform: `scale(${scale}) translate(${n % 2 ? -5 : 5}%, ${n < 3 ? -5 : 5}%)` };
}

/**
 * The picture at broadcast amplitude. The source is a 100% signal; bars go to air at 75%, and a
 * feed that is not the switched one drops to 40% luminance — so the only full-strength colour on
 * the wall is the tally block and the clock of the tile that is about to lock.
 */
function Feed({ channel, size }: { channel: ChannelPublic; size: Size }) {
  const ident = identOf(channel.id);
  const event = channel.current;
  if (!event) {
    // A channel with nothing on it is not a dimmed picture: it is a dead input, and it says so.
    return (
      <div className="absolute inset-0 grid place-items-center bg-black">
        <span className="tag">
          no signal
          <span className="caret" aria-hidden />
        </span>
      </div>
    );
  }
  return (
    <div className={`absolute inset-0 overflow-hidden ${size === "hero" ? "feed" : "feed-dim"}`}>
      <Player event={event} className="size-full" style={crop(ident.num, size)} />
    </div>
  );
}

/** One market of an event: the question, its pool, and where the money sits. */
function MarketRow({ label, pool, prior }: { label: string; pool: [bigint, bigint] | undefined; prior: number }) {
  const yes = pool ? impliedYes(pool) : null;
  const sum = pool ? pool[0] + pool[1] : 0n;
  // Before the first stake the line is the flat prior over the event's outcomes — one of them
  // happens, so an unbet board is an even board. It is dim, so it never passes for a paid price.
  const share = yes ?? prior;
  const live = yes !== null;
  return (
    <li className="grid grid-cols-[1fr_84px_132px] items-center gap-2 border-t border-line py-1">
      <span className="truncate font-mono text-[12px] tracking-[0.06em] text-bone uppercase">{label}</span>
      <span className={`num text-right text-[12px] ${live ? "text-bone" : "text-dim"}`}>{usdc(sum)}</span>
      <span className="grid grid-cols-[1fr_36px] items-center gap-2">
        <span className="odds-bar" aria-hidden>
          <span className={live ? "bg-bone" : "bg-dim/50"} style={{ width: `${Math.round(share * 100)}%` }} />
        </span>
        <span className={`num text-right text-[12px] ${live ? "text-bone" : "text-dim"}`}>
          {Math.round(share * 100)}%
        </span>
      </span>
    </li>
  );
}

/** The switched feed's board: every market of the event, priced, under labelled columns. */
function MarketBoard({ event, pools }: { event: EventPublic; pools: [bigint, bigint][] | undefined }) {
  const staked = (pools ?? []).some((p) => p[0] + p[1] > 0n);
  const prior = 1 / Math.max(1, event.outcomes.length);
  return (
    <div className="mt-2">
      <div className="grid grid-cols-[1fr_84px_132px] items-center gap-2">
        <span className="tag">market</span>
        <span className="tag text-right">pool</span>
        <span className="tag text-right">implied yes</span>
      </div>
      <ul>
        {event.outcomes.map((label, i) => (
          <MarketRow key={i} label={label} pool={pools?.[i]} prior={prior} />
        ))}
      </ul>
      {!staked ? <p className="tag mt-1 border-t border-line pt-1">no stake yet · first in sets the line</p> : null}
    </div>
  );
}

/**
 * The one clock every tile carries, in the same corner at two sizes: the hero at broadcast scale,
 * every other tile at 24px. Amber is spent on exactly this and on the tally, nowhere else.
 */
function TileClock({ event, hero }: { event: EventPublic; hero: boolean }) {
  const big = hero ? "text-[clamp(34px,4vw,56px)]" : "text-[24px]";
  if (event.state === "BETTING" && event.lockTime) {
    return (
      <>
        <span className="tag block">locks in</span>
        <Countdown to={event.lockTime} className={`money block leading-[0.82] text-amber ${big}`} />
      </>
    );
  }
  if (event.state === "LOCKED" || event.state === "RESOLVE") {
    return (
      <>
        <span className="tag block">drand round</span>
        <span className={`money block leading-[0.82] text-bone ${hero ? "text-[clamp(20px,2vw,30px)]" : "text-[18px]"}`}>
          {event.drandRound ?? "—"}
        </span>
      </>
    );
  }
  if (event.outcome !== null) {
    return (
      <>
        <span className="tag block">result</span>
        <span
          className={`money line-clamp-2 block max-w-[18ch] text-bone uppercase ${hero ? "text-[clamp(18px,1.8vw,26px)] leading-[0.95]" : "text-[15px] leading-[1.05]"}`}
        >
          {event.outcomes[event.outcome]}
        </span>
      </>
    );
  }
  return (
    <>
      <span className="tag block">status</span>
      <span className={`money block leading-none text-dim ${hero ? "text-[clamp(18px,1.8vw,26px)]" : "text-[15px]"}`}>
        {event.state.toLowerCase()}
      </span>
    </>
  );
}

/**
 * One tile anatomy at three sizes. Every tile on the wall is the same object — picture, UMD in the
 * corner, one black caption plate along the foot carrying headline, meta and clock — and size adds
 * nothing but scale, except on the switched feed, which also carries the board.
 */
function Tile({ channel, size, pools }: { channel: ChannelPublic; size: Size; pools: Pools | null }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const [visible, setVisible] = useState(false);
  const event = channel.current;
  const hero = size === "hero";
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
    hero
      ? "aspect-video lg:col-span-5 lg:row-span-4 lg:aspect-auto"
      : size === "second"
        ? "aspect-video lg:col-span-3 lg:row-span-2 lg:aspect-auto"
        : "aspect-video lg:col-span-3 lg:row-span-1 lg:aspect-auto"
  }`;

  return (
    <Link
      ref={ref}
      href={`/c/${channel.id}`}
      aria-label={`${channel.name} — ${event?.title ?? "off air"}`}
      className={shell}
    >
      {visible ? <Feed channel={channel} size={size} /> : <div className="absolute inset-0 bg-black" />}

      {/* Flush into the corner, so the tile has exactly one left edge and the tally reads from
          across the room against black rather than against the picture. */}
      <div className="absolute top-0 left-0 z-10">
        <Umd channelId={channel.id} name={channel.name} state={event?.state} accent />
      </div>

      {/* The lower third: a solid black plate punched through the picture, carrying the casino. */}
      <div className="slate absolute inset-x-0 bottom-0 z-10 px-2 py-2">
        <div className="flex items-end justify-between gap-2">
          <div className="min-w-0">
            <h2
              className={`line-clamp-2 text-bone ${hero ? "text-[clamp(22px,2.2vw,34px)]" : "text-[clamp(15px,1.4vw,20px)]"}`}
            >
              {event?.title ?? "no transmission"}
            </h2>
            <p className="tag mt-1 truncate">
              {event
                ? `seq ${String(event.seq).padStart(3, "0")} · ${event.outcomes.length} markets · pool ${pool} usdc`
                : "this channel has not gone on air yet"}
            </p>
          </div>
          {event ? (
            <div className="shrink-0 text-right">
              <TileClock event={event} hero={hero} />
            </div>
          ) : null}
        </div>

        {/* The switched feed shows the board itself; the rest of the wall shows the headline number.
            Below lg the tiles stack at 16:9 and the board would cover the whole picture, so there
            the hero carries the same caption as every other tile and the board lives on the event. */}
        {event && hero ? (
          <div className="hidden lg:block">
            <MarketBoard event={event} pools={mine} />
          </div>
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
    return <p className="copy p-2 text-dim">No channels yet. Start the engine and the wall fills itself.</p>;
  }

  // A switcher, not a dashboard: one screen on air, one wide preview beside it, the rest as rows in
  // the rundown. 46px bar + 32px chyron, so the wall meets the crawl on one hairline.
  const [lead, second, ...rest] = channels;

  // Whatever the world last decided, running along the bottom of the wall.
  const canon = channels.flatMap((c) => c.canon.slice(-2).map((line) => ({ cat: c.name, text: line })));

  return (
    <div className="relative">
      <div className="grid gap-px bg-line lg:h-[calc(100dvh-78px)] lg:grid-cols-8 lg:grid-rows-4">
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
