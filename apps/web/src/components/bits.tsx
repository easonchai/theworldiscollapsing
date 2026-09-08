"use client";

import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { USDC_DECIMALS } from "@/lib/chain";

export const usdc = (v: bigint, dp = 2) => {
  const n = Number(formatUnits(v, USDC_DECIMALS));
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
};

export const BADGE: Record<string, { label: string; className: string }> = {
  BETTING: { label: "On air", className: "text-phos border-phos/50" },
  LOCKED: { label: "Locked", className: "text-flare border-flare/50" },
  RESOLVE: { label: "Locked", className: "text-flare border-flare/50" },
  REVEAL: { label: "Reveal", className: "text-amber border-amber/60" },
  CANON: { label: "Reveal", className: "text-amber border-amber/60" },
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
