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

const ONE = 10n ** BigInt(USDC_DECIMALS);

/** What one USDC on this side would come back as, if that side wins at today's pools. */
function multiple(pool: readonly [bigint, bigint], yes: boolean): number | null {
  if (pool[0] + pool[1] === 0n) return null;
  return Number(previewPayout(ONE, yes, pool)) / Number(ONE);
}

/**
 * The betting board's one object: the split bar is both the odds picture and the bet target, so
 * there is no outlined button pretending the price lives somewhere else. An empty market is drawn
 * as empty — a full bar over a nothing pool would be a lie.
 */
function SplitBar({
  pool,
  disabled,
  busy,
  blocked,
  onBet,
}: {
  pool: [bigint, bigint];
  disabled?: boolean;
  busy: string | null;
  blocked: string | null;
  onBet?: (yes: boolean) => void;
}) {
  const p = impliedYes(pool);
  const sides = [true, false].map((yes) => ({
    yes,
    share: p === null ? 0.5 : yes ? p : 1 - p,
    mult: multiple(pool, yes),
  }));

  return (
    <div
      className="mt-2 flex h-12 overflow-hidden border border-line bg-black"
      role="group"
      aria-label={`Implied yes ${p === null ? "unknown, no bets yet" : `${Math.round(p * 100)} percent`}`}
    >
      {sides.map(({ yes, share, mult }) => {
        // Whole class strings, never assembled from pieces: Tailwind reads this file, not the DOM.
        const tone = yes ? "text-yes" : "text-no";
        const fill = p === null ? "" : yes ? "bg-yes/12" : "bg-no/12";
        const hover = p === null ? "hover:bg-bone/8" : yes ? "hover:bg-yes/25" : "hover:bg-no/25";
        const label = `${yes ? "YES" : "NO"}${p === null ? "" : ` ${Math.round(share * 100)}%`}`;
        const shell = `flex min-w-[86px] basis-0 flex-col items-center justify-center ${fill} ${
          yes ? "" : "border-l border-line"
        }`;
        const inner = (
          <>
            <span className={`text-[13px] leading-none font-medium tracking-[0.14em] ${tone}`}>{label}</span>
            <span className="num mt-1 text-[11px] leading-none text-dim">
              {mult === null ? "—" : `×${mult.toFixed(2)}`}
            </span>
          </>
        );
        return onBet ? (
          <button
            key={String(yes)}
            type="button"
            style={{ flexGrow: share }}
            className={`${shell} ${hover} cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent`}
            disabled={disabled}
            title={blocked ?? undefined}
            onClick={() => onBet(yes)}
          >
            {busy === String(yes) ? <span className="num text-[13px] text-bone">…</span> : inner}
          </button>
        ) : (
          <div key={String(yes)} style={{ flexGrow: share }} className={shell}>
            {inner}
          </div>
        );
      })}
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
      {/* 46px so this header sits on the same baseline as the station bar and the channel bug. */}
      <div className="flex h-[46px] items-center justify-between border-b border-line px-2">
        <h2 className="text-[22px] text-bone">Markets</h2>
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
        <span id="stake-hint" className="num shrink-0 text-[11px] whitespace-nowrap text-dim">
          USDC · bal {gate ? gate.balanceText : "—"}
        </span>
      </div>

      <ul>
        {event.outcomes.map((label, i) => {
          const m = markets?.[i] ?? { pool: ZERO, stake: ZERO };
          const won = event.outcome === i;
          const resolved = event.outcome !== null;
          const total = m.pool[0] + m.pool[1];
          return (
            <li key={i} className={`border-b border-line px-2 py-2 ${resolved && won ? "bg-bone/5" : ""}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <span className="tag">market {String(i + 1).padStart(2, "0")}</span>
                  <h3 className="mt-0.5 text-[15px] leading-tight normal-case tracking-normal text-bone">{label}</h3>
                </div>
                <div className="shrink-0 text-right">
                  <span className="tag block">pool</span>
                  <span className={`num block text-[22px] leading-none ${total === 0n ? "text-dim" : "text-bone"}`}>
                    {usdc(total)}
                  </span>
                </div>
              </div>

              <SplitBar
                pool={m.pool}
                disabled={!!blocked || busy !== null}
                blocked={blocked}
                busy={busy?.startsWith(`${i}-`) ? busy.slice(`${i}-`.length) : null}
                onBet={resolved ? undefined : (yes) => bet(i, yes)}
              />

              {total === 0n && !resolved ? (
                <p className="mt-1 text-[11px] tracking-[0.1em] text-dim uppercase">no bets yet</p>
              ) : null}

              {resolved ? (
                <p className="mt-1 text-[11px] tracking-[0.1em] uppercase">
                  <span className={won ? "text-bone" : "text-dim"}>{won ? "resolved yes" : "resolved no"}</span>
                </p>
              ) : null}

              {m.stake[0] > 0n || m.stake[1] > 0n ? (
                <p className="mt-1 num text-[11px] text-dim">
                  you: <span className="text-yes">{usdc(m.stake[1])} yes</span> ·{" "}
                  <span className="text-no">{usdc(m.stake[0])} no</span>
                  {resolved ? (
                    <>
                      {" "}
                      · payout <span className="text-amber">{usdc(marketPayout(m.stake, m.pool, won))}</span>
                    </>
                  ) : null}
                </p>
              ) : null}

              {parsed && !blocked ? (
                <p className="mt-1 num text-[11px] text-dim">
                  {usdc(parsed)} on yes returns <span className="text-yes">{usdc(previewPayout(parsed, true, m.pool))}</span>
                  {" · "}on no <span className="text-no">{usdc(previewPayout(parsed, false, m.pool))}</span>
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div aria-live="polite" className="border-t border-line px-2 py-2">
        {open ? (
          <p className="text-[11px] tracking-[0.1em] text-dim uppercase">
            the price is the pool: the first stake on a side sets it, every later stake moves it
          </p>
        ) : null}
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
        {status ? <p className="num text-[11px] text-bone">{status}</p> : null}
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
    return <p className="num text-[13px] text-bone">Claimed {usdc(paid)} USDC.</p>;
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
