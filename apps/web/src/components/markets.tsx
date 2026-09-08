"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { parseUnits, type Hex } from "viem";
import {
  ARENA,
  USDC,
  USDC_DECIMALS,
  arenaAbi,
  chain,
  impliedYes,
  marketPayout,
  mockusdcAbi,
  previewPayout,
  publicClient,
} from "@/lib/chain";
import type { EventPublic } from "@/lib/public";
import { betRevertMessage, confirmed } from "@/lib/tx";
import { useGate, usePoll } from "./chain-hooks";
import { useWallet } from "./wallet";
import { usdc } from "./bits";

export type MarketState = { pool: [bigint, bigint]; stake: [bigint, bigint] };

const ZERO: [bigint, bigint] = [0n, 0n];

/**
 * Live pools and the caller's stakes for every market of the event, straight from the chain.
 * `pools`/`stakes` are mappings to a fixed [NO, YES] array, so each side is its own getter call.
 */
const poolSide = (eventId: Hex, i: number, side: 0 | 1) =>
  publicClient.readContract({ address: ARENA, abi: arenaAbi, functionName: "pools", args: [eventId, i, BigInt(side)] });

const stakeSide = (eventId: Hex, i: number, who: `0x${string}`, side: 0 | 1) =>
  publicClient.readContract({
    address: ARENA,
    abi: arenaAbi,
    functionName: "stakes",
    args: [eventId, i, who, BigInt(side)],
  });

export async function readMarket(eventId: Hex, i: number, address?: `0x${string}`): Promise<MarketState> {
  const [no, yes, stakeNo, stakeYes] = await Promise.all([
    poolSide(eventId, i, 0),
    poolSide(eventId, i, 1),
    address ? stakeSide(eventId, i, address, 0) : Promise.resolve(0n),
    address ? stakeSide(eventId, i, address, 1) : Promise.resolve(0n),
  ]);
  return { pool: [no, yes], stake: [stakeNo, stakeYes] };
}

export function useMarkets(event: EventPublic) {
  const { address } = useWallet();
  const n = event.outcomes.length;
  return usePoll<MarketState[]>(
    async () => Promise.all(Array.from({ length: n }, (_, i) => readMarket(event.id, i, address ?? undefined))),
    `markets:${event.id}:${n}:${address ?? ""}`,
    2500,
  );
}

function Odds({ pool }: { pool: [bigint, bigint] }) {
  const p = impliedYes(pool);
  return (
    <div className="mt-2">
      <div className="flex items-baseline justify-between num text-[11px]">
        <span className="text-phos">YES {p === null ? "—" : `${Math.round(p * 100)}%`}</span>
        <span className="text-dim">
          {usdc(pool[1])} / {usdc(pool[0])}
        </span>
        <span className="text-flare">NO {p === null ? "—" : `${Math.round((1 - p) * 100)}%`}</span>
      </div>
      <div className="mt-1 h-[6px] w-full bg-panel2" role="img" aria-label={`Implied yes ${p === null ? "unknown" : Math.round(p * 100)} percent`}>
        <div className="h-full bg-phos" style={{ width: `${(p ?? 0.5) * 100}%` }} />
      </div>
    </div>
  );
}

export function Markets({
  event,
  markets,
  refresh,
}: {
  event: EventPublic;
  markets: MarketState[] | null;
  refresh: () => void;
}) {
  const { address, walletClient } = useWallet();
  const { gate, refresh: refreshGate } = useGate();
  const [amount, setAmount] = useState("25");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = event.state === "BETTING";
  const parsed = useMemo(() => {
    try {
      const v = parseUnits(amount || "0", USDC_DECIMALS);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }, [amount]);

  const blocked = !address
    ? "Sign in to bet"
    : !gate?.verified
      ? "Verify to bet"
      : !open
        ? event.state === "LOCKED" || event.state === "RESOLVE"
          ? "Betting is closed — waiting for the drand round"
          : "Betting is closed"
        : !parsed
          ? "Enter an amount"
          : null;

  async function bet(outcomeIdx: number, yes: boolean) {
    if (!walletClient || !address || !parsed) return;
    const key = `${outcomeIdx}-${yes}`;
    setBusy(key);
    setError(null);
    try {
      const allowance = await publicClient.readContract({
        address: USDC,
        abi: mockusdcAbi,
        functionName: "allowance",
        args: [address, ARENA],
      });
      if (allowance < parsed) {
        setStatus("Approving USDC…");
        const approveTx = await walletClient.writeContract({
          address: USDC,
          abi: mockusdcAbi,
          functionName: "approve",
          args: [ARENA, parsed],
          account: address,
          chain,
        });
        await confirmed(approveTx, () => "The USDC approval reverted — nothing was staked.");
      }
      setStatus("Confirming bet…");
      const tx = await walletClient.writeContract({
        address: ARENA,
        abi: arenaAbi,
        functionName: "bet",
        args: [event.id, outcomeIdx, yes, parsed],
        account: address,
        chain,
      });
      const receipt = await confirmed(tx, () => betRevertMessage(event.lockTime, Date.now()));
      setStatus(`Bet confirmed in block ${receipt.blockNumber}`);
      refresh();
      refreshGate();
    } catch (e) {
      setStatus(null);
      setError(shortError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-label="Markets" className="flex flex-col">
      <div className="flex items-center justify-between border-b border-line px-2 py-2">
        <h2 className="text-[20px] text-bone">Markets</h2>
        <span className="tag">parimutuel · 2% fee</span>
      </div>

      <div className="flex items-center gap-2 border-b border-line bg-panel px-2 py-2">
        <label htmlFor="stake" className="tag">
          stake
        </label>
        <input
          id="stake"
          className="field w-24 py-1 text-right"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
          aria-describedby="stake-hint"
        />
        <span id="stake-hint" className="num text-[11px] text-dim">
          USDC · balance {gate ? gate.balanceText : "—"}
        </span>
      </div>

      <ul>
        {event.outcomes.map((label, i) => {
          const m = markets?.[i] ?? { pool: ZERO, stake: ZERO };
          const won = event.outcome === i;
          const resolved = event.outcome !== null;
          return (
            <li key={i} className={`border-b border-line px-2 py-2 ${resolved && won ? "bg-phos/5" : ""}`}>
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-body text-[17px] normal-case tracking-normal text-bone">{label}</h3>
                {resolved ? (
                  <span className={`chip shrink-0 ${won ? "border-phos/60 text-phos" : "border-line text-dim"}`}>
                    {won ? "Yes" : "No"}
                  </span>
                ) : null}
              </div>

              <Odds pool={m.pool} />

              {m.stake[0] > 0n || m.stake[1] > 0n ? (
                <p className="mt-1 num text-[11px] text-dim">
                  you: <span className="text-phos">{usdc(m.stake[1])} yes</span> ·{" "}
                  <span className="text-flare">{usdc(m.stake[0])} no</span>
                  {resolved ? (
                    <>
                      {" "}
                      · payout <span className="text-amber">{usdc(marketPayout(m.stake, m.pool, won))}</span>
                    </>
                  ) : null}
                </p>
              ) : null}

              {!resolved ? (
                <div className="mt-2 flex gap-1">
                  {[true, false].map((yes) => (
                    <button
                      key={String(yes)}
                      type="button"
                      className="btn flex-1"
                      disabled={!!blocked || busy !== null}
                      title={blocked ?? undefined}
                      onClick={() => bet(i, yes)}
                    >
                      {busy === `${i}-${yes}` ? "…" : yes ? "Yes" : "No"}
                      {parsed && !blocked ? (
                        <span className="num text-[10px] text-dim">
                          → {usdc(previewPayout(parsed, yes, m.pool))}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div aria-live="polite" className="px-2 py-2">
        {blocked ? (
          <p className="num text-[11px] text-dim">
            {blocked}
            {blocked === "Verify to bet" ? (
              <>
                {" — "}
                <Link href="/verify" className="text-amber underline underline-offset-2">
                  verify and take the faucet
                </Link>
              </>
            ) : null}
          </p>
        ) : null}
        {status ? <p className="num text-[11px] text-phos">{status}</p> : null}
        {error ? <p className="num text-[11px] text-flare">{error}</p> : null}
      </div>
    </section>
  );
}

export function shortError(e: unknown): string {
  const msg = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
  return msg.split("\n")[0].slice(0, 160);
}

/** Everything the caller can take out of this event, computed the way Arena.claim computes it. */
export function claimableOf(event: EventPublic, markets: MarketState[] | null): bigint {
  if (!markets || event.outcome === null) return 0n;
  return markets.reduce((sum, m, i) => sum + marketPayout(m.stake, m.pool, i === event.outcome), 0n);
}

export function ClaimButton({
  event,
  claimable,
  onClaimed,
}: {
  event: EventPublic;
  claimable: bigint;
  onClaimed?: () => void;
}) {
  const { address, walletClient } = useWallet();
  const { refresh: refreshGate } = useGate();
  const [busy, setBusy] = useState(false);
  const [paid, setPaid] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function claim() {
    if (!walletClient || !address) return;
    setBusy(true);
    setError(null);
    try {
      const tx = await walletClient.writeContract({
        address: ARENA,
        abi: arenaAbi,
        functionName: "claim",
        args: [event.id as Hex],
        account: address,
        chain,
      });
      await confirmed(tx, () => "The claim reverted on chain — nothing was paid out.");
      setPaid(claimable);
      refreshGate();
      onClaimed?.();
    } catch (e) {
      setError(shortError(e));
    } finally {
      setBusy(false);
    }
  }

  if (paid !== null) {
    return <p className="num text-[13px] text-phos">Claimed {usdc(paid)} USDC.</p>;
  }
  return (
    <div>
      <button type="button" className="btn btn-primary w-full" disabled={busy || claimable === 0n} onClick={claim}>
        {busy ? "Claiming…" : claimable > 0n ? `Claim ${usdc(claimable)} USDC` : "Nothing to claim"}
      </button>
      {error ? <p className="mt-1 num text-[11px] text-flare">{error}</p> : null}
    </div>
  );
}
