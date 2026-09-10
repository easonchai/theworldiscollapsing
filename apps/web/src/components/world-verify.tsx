"use client";

import { useEffect, useState } from "react";
import { IDKitRequestWidget, selfieCheckLegacy } from "@worldcoin/idkit";
import type { IDKitResult, RpContext } from "@worldcoin/idkit";
import { WORLD_ACTION, WORLD_APP_ID } from "@/lib/chain";

/**
 * World Selfie Check. IDKit 4.x needs an rp_context signed by the relying party, so the widget is
 * only usable once the server can mint one (WORLD_RP_ID + WORLD_RP_SIGNING_KEY).
 *
 * `signal` is the wallet address: the widget hashes it into every credential response as
 * `signal_hash`, which is what binds the proof to one address (docs/RESEARCH.md, World section).
 */
export function WorldVerify({ signal, onProof }: { signal: string; onProof: (proof: IDKitResult) => void }) {
  const [rpContext, setRpContext] = useState<RpContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    fetch("/api/world/rp-context")
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        return body as RpContext;
      })
      .then(setRpContext)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) {
    return <p className="num text-[12px] text-flare">World mode is not ready: {error}</p>;
  }

  return (
    <>
      <button type="button" className="btn btn-primary w-full" disabled={!rpContext} onClick={() => setOpen(true)}>
        {rpContext ? "Start Selfie Check" : "Preparing Selfie Check…"}
      </button>
      {rpContext ? (
        <IDKitRequestWidget
          open={open}
          onOpenChange={setOpen}
          app_id={WORLD_APP_ID as `app_${string}`}
          action={WORLD_ACTION}
          rp_context={rpContext}
          allow_legacy_proofs
          preset={selfieCheckLegacy({ signal })}
          onSuccess={onProof}
        />
      ) : null}
    </>
  );
}
