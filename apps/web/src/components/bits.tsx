"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { formatUnits } from "viem";
import { USDC_DECIMALS } from "@/lib/chain";
import { identOf } from "@/lib/channels";
import { clock, splitClock } from "@/lib/clock";

export { clock };

export const usdc = (v: bigint, dp = 2) => {
  const n = Number(formatUnits(v, USDC_DECIMALS));
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
};

// Amber is spent on one meaning only — time or money is live — so no status wears it. On air is a
// solid red tally block, the way a real UMD lights; everything else is bone or dim on a hairline.
export const BADGE: Record<string, { label: string; className: string }> = {
  BETTING: { label: "On air", className: "tally" },
  LOCKED: { label: "Locked", className: "chip text-bone border-bone/50" },
  RESOLVE: { label: "Locked", className: "chip text-bone border-bone/50" },
  REVEAL: { label: "Reveal", className: "chip text-bone border-bone/50" },
  CANON: { label: "Reveal", className: "chip text-bone border-bone/50" },
  PAUSE: { label: "Result", className: "chip text-bone border-line" },
  DONE: { label: "Replay", className: "chip text-dim border-line" },
  READY: { label: "Cueing", className: "chip text-dim border-line" },
  RENDER: { label: "Rendering", className: "chip text-dim border-line" },
};

export function StateBadge({ state, className = "" }: { state: string; className?: string }) {
  const b = BADGE[state] ?? { label: state, className: "chip text-dim border-line" };
  return <span className={`${b.className} ${className}`}>{b.label}</span>;
}

/**
 * The UMD label: the same anatomy under every source in the station — channel number, channel name,
 * tally — on a black plate with one neutral hairline. A viewer reads the same three things whether
 * the source is the hero of the wall or the only picture on an event page.
 */
export function Umd({
  channelId,
  name,
  state,
  accent = false,
}: {
  channelId: string;
  name: string;
  state?: string;
  /** Only the wall sets this: four channels at once is the only place a hue earns its keep. */
  accent?: boolean;
}) {
  const ident = identOf(channelId);
  return (
    <div className="z-10 flex items-center gap-1 border-r border-b border-line bg-black px-2 py-1 whitespace-nowrap">
      <span
        className="num text-[11px] leading-none text-[color:var(--ch)]"
        style={{ "--ch": accent ? ident.accent : "var(--color-bone)" } as CSSProperties}
      >
        CH {ident.num}
      </span>
      <span className="font-mono text-[11px] leading-none font-medium tracking-[0.18em] text-bone uppercase">{name}</span>
      {state ? <StateBadge state={state} /> : null}
    </div>
  );
}

/** Ticks once a second so every countdown on the page moves together. */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** The clock as the station prints it: dead leading fields dimmed, the live one at full strength. */
export function Digits({ text }: { text: string }) {
  const [dead, live] = splitClock(text);
  return (
    <>
      {dead ? <span className="dead">{dead}</span> : null}
      {live}
    </>
  );
}

export function Countdown({ to, className = "" }: { to: string | null; className?: string }) {
  const now = useNow();
  // No face of its own: the caller sets it, and every caller sets the headline grotesk with tnum.
  if (!to) return <span className={`tabular-nums ${className}`}>--:--</span>;
  return (
    // Server and client render this a tick apart; the interval corrects it on mount.
    <time dateTime={to} suppressHydrationWarning className={`tabular-nums ${className}`}>
      <Digits text={clock(Date.parse(to) - now)} />
    </time>
  );
}

/**
 * The station chyron: one full-bleed crawl fixed to the foot of the viewport, the same object on
 * the wall (canon) and on an event (ticker), so it reads as broadcast furniture and never as a
 * caption belonging to one video. Categories are bold bone mono — the accent is not spent here.
 */
export function Chyron({
  label,
  lines,
  empty,
}: {
  label: string;
  lines: { cat: string; text: string }[];
  empty: string;
}) {
  // A crawl that says the same thing twice reads as filler rather than as a wire feed. Two channels
  // can land on the same canon line, so the feed is de-duplicated by text before it goes to air.
  const feed = lines.filter((line, i) => lines.findIndex((o) => o.text === line.text) === i);
  return (
    <div className="chyron">
      {/* A fixed, opaque cell: the label can never clip, and the crawl fades in behind it. */}
      <span className="chyron-label">{label}</span>
      <div className="relative flex min-w-0 flex-1 items-center overflow-hidden pl-2">
        {feed.length ? (
          <div className="marquee text-[12px] tracking-[0.08em] text-dim uppercase">
            {[...feed, ...feed].map((line, i) => (
              <span key={i}>
                <span className="mr-2 font-bold text-bone">{line.cat}</span>
                {line.text}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-[12px] tracking-[0.08em] text-dim uppercase">{empty}</span>
        )}
        <span className="chyron-mask" aria-hidden />
      </div>
    </div>
  );
}
