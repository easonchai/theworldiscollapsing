"use client";

import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { USDC_DECIMALS } from "@/lib/chain";

export const usdc = (v: bigint, dp = 2) => {
  const n = Number(formatUnits(v, USDC_DECIMALS));
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
};

// Green is live and nothing else; amber is urgency and nothing else; everything settled is bone or
// dim. Red is reserved for faults, so no state badge wears it.
export const BADGE: Record<string, { label: string; className: string }> = {
  BETTING: { label: "On air", className: "text-phos border-phos/50" },
  LOCKED: { label: "Locked", className: "text-amber border-amber/60" },
  RESOLVE: { label: "Locked", className: "text-amber border-amber/60" },
  REVEAL: { label: "Reveal", className: "text-bone border-bone/50" },
  CANON: { label: "Reveal", className: "text-bone border-bone/50" },
  PAUSE: { label: "Result", className: "text-bone border-line" },
  DONE: { label: "Replay", className: "text-dim border-line" },
  READY: { label: "Cueing", className: "text-dim border-line" },
  RENDER: { label: "Rendering", className: "text-dim border-line" },
};

export function StateBadge({ state, className = "" }: { state: string; className?: string }) {
  const b = BADGE[state] ?? { label: state, className: "text-dim border-line" };
  return (
    <span className={`chip ${b.className} ${className}`}>
      {state === "BETTING" ? <span className="pulse size-[6px] rounded-full bg-phos" aria-hidden /> : null}
      {b.label}
    </span>
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

export const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
};

export function Countdown({ to, className = "" }: { to: string | null; className?: string }) {
  const now = useNow();
  if (!to) return <span className={`num ${className}`}>--:--</span>;
  return (
    // Server and client render this a tick apart; the interval corrects it on mount.
    <time dateTime={to} suppressHydrationWarning className={`num tabular-nums ${className}`}>
      {clock(Date.parse(to) - now)}
    </time>
  );
}

/**
 * The station chyron: one full-bleed crawl fixed to the foot of the viewport, the same object on
 * the wall (canon) and on an event (ticker), so it reads as broadcast furniture and never as a
 * caption belonging to one video. Each line is filed under an amber category label.
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
  return (
    <div className="chyron">
      <span className="shrink-0 self-stretch border-r border-line px-2 py-1 text-[12px] leading-[18px] tracking-[0.22em] text-amber uppercase">
        {label}
      </span>
      <div className="min-w-0 flex-1 overflow-hidden pl-2">
        {lines.length ? (
          <div className="marquee text-[12px] tracking-[0.08em] text-dim uppercase">
            {[...lines, ...lines].map((line, i) => (
              <span key={i}>
                <span className="mr-2 text-amber">{line.cat}</span>
                {line.text}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-[12px] tracking-[0.08em] text-dim uppercase">{empty}</span>
        )}
      </div>
    </div>
  );
}
