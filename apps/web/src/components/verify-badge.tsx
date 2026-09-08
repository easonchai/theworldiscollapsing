"use client";

import { useEffect, useState } from "react";
import { DRAND_URL, outcomeFor } from "@/lib/chain";
import type { EventPublic } from "@/lib/public";

type Check = {
  fetched: string;
  sigMatch: boolean;
  derived: number;
  outcomeMatch: boolean;
};

/**
 * Independent check of the result: pull the drand signature for the committed round straight from
 * drand, compare it to what the contract stored, then recompute the outcome from it.
 */
export function VerifyBadge({ event }: { event: EventPublic }) {
  const [check, setCheck] = useState<Check | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { drandRound, signature, outcome } = event;

  useEffect(() => {
    if (!drandRound || !signature || outcome === null) return;
    let live = true;
    fetch(`${DRAND_URL}/${drandRound}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`drand HTTP ${r.status}`))))
      .then((b: { signature?: string }) => {
        if (!live) return;
        if (typeof b.signature !== "string") throw new Error("drand: no signature");
        const fetched = `0x${b.signature}`;
        const derived = outcomeFor(fetched as `0x${string}`, event.id, event.outcomes.length);
        setCheck({
          fetched,
          sigMatch: fetched.toLowerCase() === signature.toLowerCase(),
          derived,
          outcomeMatch: derived === outcome,
        });
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [drandRound, signature, outcome, event.id, event.outcomes.length]);

  if (!drandRound || !signature || outcome === null) return null;

  const ok = check?.sigMatch && check?.outcomeMatch;
  const short = (s: string) => `${s.slice(0, 10)}…${s.slice(-6)}`;

  return (
    <div className={`panel p-2 ${ok ? "border-amber/50" : check || error ? "border-flare/60" : ""}`}>
      <div className="flex items-center gap-2">
        <span aria-hidden className={`text-[18px] leading-none ${ok ? "text-amber" : check || error ? "text-flare" : "text-dim"}`}>
          {ok ? "✓" : check || error ? "✗" : "…"}
        </span>
        <span className="tag">
          {ok
            ? "verified against drand evmnet"
            : error
              ? "could not reach drand"
              : check
                ? "mismatch — do not trust this result"
                : "checking drand…"}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 num text-[11px] text-dim">
        <dt>round</dt>
        <dd className="text-bone">{drandRound}</dd>
        <dt>stored sig</dt>
        <dd className="text-bone">{short(signature)}</dd>
        <dt>drand sig</dt>
        <dd className={check?.sigMatch ? "text-bone" : "text-flare"}>{check ? short(check.fetched) : error ?? "…"}</dd>
        <dt>keccak mod {event.outcomes.length}</dt>
        <dd className={check?.outcomeMatch ? "text-bone" : "text-flare"}>
          {check ? `${check.derived} — ${event.outcomes[check.derived]}` : "…"}
        </dd>
        <dt>on chain</dt>
        <dd className="text-bone">
          {outcome} — {event.outcomes[outcome]}
        </dd>
      </dl>
    </div>
  );
}
