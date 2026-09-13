"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { GATE_MODE, MAINNET, USDC, WORLD_APP_ID, mockusdcAbi, publicClient } from "@/lib/chain";
import { confirmed, ensureGas, requestVerify, txMessage, type TxMessage } from "@/lib/tx";
import { useGate, usePoll } from "./chain-hooks";
import { TxError, clock, useNow } from "./bits";
import { useWallet } from "./wallet";

const Ramp = dynamic(() => import("./ramp").then((m) => m.Ramp), { ssr: false });

const WorldVerify = dynamic(() => import("./world-verify").then((m) => m.WorldVerify), { ssr: false });

const FAUCET_COOLDOWN_S = 86_400n;

export function VerifyFlow() {
  const { address, walletClient, sponsored, login } = useWallet();
  const { gate, refresh } = useGate();
  const [attest, setAttest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<TxMessage | null>(null);
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

  /** Sign, then let the server set the flag (and drip gas into an empty wallet). */
  async function verify(extra: Record<string, unknown>) {
    if (!walletClient || !address) throw new Error("no wallet");
    setStatus("Signing…");
    const out = await requestVerify(walletClient, address, extra);
    setStatus(out.tx ? `Verified on chain — ${out.tx.slice(0, 12)}…` : "Already verified.");
    refresh();
  }

  async function verifyCheckbox() {
    setBusy(true);
    setError(null);
    try {
      await verify({ attest: true });
    } catch (e) {
      setStatus(null);
      setError(txMessage(e));
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
      await ensureGas({ walletClient, address, sponsored }, setStatus);
      // Unverified addresses and a cooldown that has not passed both revert: simulating names
      // which one it is before the wallet ever opens.
      const sim = await publicClient.simulateContract({
        address: USDC,
        abi: mockusdcAbi,
        functionName: "faucet",
        account: address,
      });
      const tx = await walletClient.writeContract(sim.request);
      await confirmed(tx, () => "The faucet reverted on chain — no USDC was sent.");
      setStatus("1,000 play USDC delivered.");
      refresh();
      refreshFaucet();
    } catch (e) {
      setStatus(null);
      setError(txMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-px bg-line lg:grid-cols-3">
      <section className="bg-vac p-2">
        <p className="tag">step one</p>
        <h2 className="mt-1 text-[24px] text-bone">Wallet</h2>
        <p className="mt-2 text-[14px] text-dim">
          Bets, the faucet and the verified flag are all keyed to an address.
        </p>
        {address ? (
          <p className="mt-2 num text-[12px] text-dim">connected {address}</p>
        ) : (
          <button type="button" className="btn btn-primary mt-2 w-full" onClick={login}>
            Sign in
          </button>
        )}
      </section>

      <section className="bg-vac p-2">
        <p className="tag">step two</p>
        <h2 className="mt-1 text-[24px] text-bone">Verify</h2>
        <p className="mt-2 text-[14px] text-dim">
          {GATE_MODE === "world"
            ? "World Selfie Check proves a live human is behind the address, so bots cannot farm the faucet."
            : "Self-attestation stands in for Selfie Check while the beta flag is pending."}
        </p>

        <label className="mt-3 flex items-start gap-2 text-[14px] text-bone">
          <input
            type="checkbox"
            className="mt-1 size-4 accent-amber"
            checked={attest || !!gate?.verified}
            disabled={!!gate?.verified}
            onChange={(e) => setAttest(e.target.checked)}
          />
          I am 18 or older. This is play money on a testnet.
        </label>

        <div className="mt-3">
          {gate?.verified ? (
            <p className="num text-[13px] text-amber">✓ this address is verified</p>
          ) : GATE_MODE === "world" ? (
            WORLD_APP_ID ? (
              <WorldVerifyGate attest={attest} address={address} verify={verify} setError={setError} />
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

      {MAINNET ? (
        <Ramp balanceText={gate ? gate.balanceText : "—"} onMoved={refresh} />
      ) : (
      <section className="bg-vac p-2">
        <p className="tag">step three</p>
        <h2 className="mt-1 text-[24px] text-bone">Faucet</h2>
        <p className="mt-2 text-[14px] text-dim">
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
      )}

      <div aria-live="polite" className="bg-vac px-2 py-2 lg:col-span-3">
        {status ? <p className="num text-[12px] text-bone">{status}</p> : null}
        <TxError error={error} className="num text-[12px]" />
      </div>
    </div>
  );
}

function WorldVerifyGate({
  attest,
  address,
  verify,
  setError,
}: {
  attest: boolean;
  address: string | null;
  verify: (extra: Record<string, unknown>) => Promise<void>;
  setError: (m: TxMessage) => void;
}) {
  if (!address || !attest) {
    return <p className="num text-[12px] text-dim">Sign in and tick the box to start Selfie Check.</p>;
  }
  return (
    // The signal is the address, and the address is what the server derives the expected
    // `signal_hash` from — a proof made for one wallet cannot be spent on another.
    <WorldVerify
      signal={address}
      onProof={async (proof) => {
        try {
          await verify({ attest: true, proof });
        } catch (e) {
          setError(txMessage(e));
        }
      }}
    />
  );
}
