"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { GATE_MODE, USDC, WORLD_APP_ID, chain, mockusdcAbi, publicClient } from "@/lib/chain";
import { buildVerifyMessage } from "@/lib/verify-message";
import { useGate, usePoll } from "./chain-hooks";
import { shortError } from "./markets";
import { clock, useNow } from "./bits";
import { useWallet } from "./wallet";

const WorldVerify = dynamic(() => import("./world-verify").then((m) => m.WorldVerify), { ssr: false });

const FAUCET_COOLDOWN_S = 86_400n;

export function VerifyFlow() {
  const { address, walletClient, login } = useWallet();
  const { gate, refresh } = useGate();
  const [attest, setAttest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  const { value: lastFaucet, refresh: refreshFaucet } = usePoll<bigint>(
    async () =>
      address
        ? publicClient.readContract({ address: USDC, abi: mockusdcAbi, functionName: "lastFaucet", args: [address] })
        : 0n,
    `faucet:${address ?? ""}`,
    5000,
  );
  const readyAtMs = lastFaucet ? Number(lastFaucet + FAUCET_COOLDOWN_S) * 1000 : 0;
  const cooling = lastFaucet !== null && lastFaucet > 0n && readyAtMs > now;

  /** Sign the challenge, then hand it to the server: only the wallet's owner can ask to be verified. */
  async function sign() {
    if (!walletClient || !address) throw new Error("no wallet");
    const message = buildVerifyMessage(address, Math.floor(Date.now() / 1000));
    const signature = await walletClient.signMessage({ account: address, message });
    return { message, signature };
  }

  async function post(body: Record<string, unknown>) {
    const res = await fetch("/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = (await res.json()) as { verified?: boolean; tx?: string; error?: string };
    if (!res.ok || !out.verified) throw new Error(out.error ?? `verify failed (${res.status})`);
    setStatus(`Verified on chain — ${out.tx?.slice(0, 12)}…`);
    refresh();
  }

  async function verifyCheckbox() {
    setBusy(true);
    setError(null);
    setStatus("Signing…");
    try {
      const { message, signature } = await sign();
      setStatus("Setting your flag on chain…");
      await post({ address, attest: true, message, signature });
    } catch (e) {
      setStatus(null);
      setError(shortError(e));
    } finally {
      setBusy(false);
    }
  }

  async function faucet() {
    if (!walletClient || !address) return;
    setBusy(true);
    setError(null);
    setStatus("Requesting play USDC…");
    try {
      const tx = await walletClient.writeContract({
        address: USDC,
        abi: mockusdcAbi,
        functionName: "faucet",
        account: address,
        chain,
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      setStatus("1,000 play USDC delivered.");
      refresh();
      refreshFaucet();
    } catch (e) {
      setStatus(null);
      setError(shortError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-px bg-line lg:grid-cols-3">
      <section className="bg-vac p-3">
        <p className="tag">step one</p>
        <h2 className="mt-1 text-[24px] text-bone">Wallet</h2>
        <p className="mt-2 font-body text-[16px] text-dim">
          Bets, the faucet and the verified flag are all keyed to an address.
        </p>
        {address ? (
          <p className="mt-2 num text-[12px] text-phos">connected {address}</p>
        ) : (
          <button type="button" className="btn btn-primary mt-2 w-full" onClick={login}>
            Sign in
          </button>
        )}
      </section>

      <section className="bg-vac p-3">
        <p className="tag">step two</p>
        <h2 className="mt-1 text-[24px] text-bone">Verify</h2>
        <p className="mt-2 font-body text-[16px] text-dim">
          {GATE_MODE === "world"
            ? "World Selfie Check proves a live human is behind the address, so bots cannot farm the faucet."
            : "Self-attestation stands in for Selfie Check while the beta flag is pending."}
        </p>

        <label className="mt-3 flex items-start gap-2 font-body text-[15px] text-bone">
          <input
            type="checkbox"
            className="mt-1 size-4 accent-amber"
            checked={attest}
            onChange={(e) => setAttest(e.target.checked)}
          />
          I am 18 or older. This is play money on a testnet.
        </label>

        <div className="mt-3">
          {gate?.verified ? (
            <p className="num text-[13px] text-phos">✓ this address is verified</p>
          ) : GATE_MODE === "world" ? (
            WORLD_APP_ID ? (
              <WorldVerifyGate attest={attest} address={address} sign={sign} post={post} setError={setError} />
            ) : (
              <p className="num text-[12px] text-amber">
                World mode is selected but NEXT_PUBLIC_WORLD_APP_ID is not set, so Selfie Check cannot start here.
              </p>
            )
          ) : (
            <button
              type="button"
              className="btn btn-primary w-full"
              disabled={!address || !attest || busy}
              onClick={verifyCheckbox}
            >
              {busy ? "Working…" : "Attest and verify"}
            </button>
          )}
        </div>
      </section>

      <section className="bg-vac p-3">
        <p className="tag">step three</p>
        <h2 className="mt-1 text-[24px] text-bone">Faucet</h2>
        <p className="mt-2 font-body text-[16px] text-dim">
          1,000 play USDC per day per verified address. Balance: {gate ? gate.balanceText : "—"}.
        </p>
        <button
          type="button"
          className="btn btn-primary mt-3 w-full"
          disabled={!address || !gate?.verified || busy || cooling}
          title={!gate?.verified ? "Verify first" : cooling ? "Once a day" : undefined}
          onClick={faucet}
        >
          {cooling ? `Again in ${clock(readyAtMs - now)}` : busy ? "Working…" : "Take 1,000 USDC"}
        </button>
      </section>

      <div aria-live="polite" className="bg-vac px-3 py-2 lg:col-span-3">
        {status ? <p className="num text-[12px] text-phos">{status}</p> : null}
        {error ? <p className="num text-[12px] text-flare">{error}</p> : null}
      </div>
    </div>
  );
}

function WorldVerifyGate({
  attest,
  address,
  sign,
  post,
  setError,
}: {
  attest: boolean;
  address: string | null;
  sign: () => Promise<{ message: string; signature: string }>;
  post: (body: Record<string, unknown>) => Promise<void>;
  setError: (m: string) => void;
}) {
  if (!address || !attest) {
    return <p className="num text-[12px] text-dim">Sign in and tick the box to start Selfie Check.</p>;
  }
  return (
    <WorldVerify
      signal={address}
      onProof={async (proof) => {
        try {
          const { message, signature } = await sign();
          await post({ address, attest: true, proof, message, signature });
        } catch (e) {
          setError(shortError(e));
        }
      }}
    />
  );
}
