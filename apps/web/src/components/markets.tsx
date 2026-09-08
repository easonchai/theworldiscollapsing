"use client";

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
 * One side of one market: an outlined tile you pick, not a data cell. It shows the price if the
 * market has one and OPEN if it does not — never an em-dash, which reads as missing data. Picking
 * fills it amber; the ticket at the foot of the rail is where the money is committed.
 */
function PriceCell({
  yes,
  label,
  pool,
  staked,
  selected,
  disabled,
  busy,
  blocked,
  onPick,
}: {
  yes: boolean;
  label: string;
  pool: [bigint, bigint];
  staked: boolean;
  selected: boolean;
  disabled?: boolean;
  busy: boolean;
  blocked: string | null;
  onPick?: (yes: boolean) => void;
}) {
  const p = impliedYes(pool);
  const share = p === null ? null : yes ? p : 1 - p;
  const mult = multiple(pool, yes);
  const inner = busy ? (
    <span className="num text-[13px]">…</span>
  ) : share === null ? (
    <span className="num text-[12px] tracking-[0.14em]">open</span>
  ) : (
    <>
      <span className="money text-[17px] leading-none">{Math.round(share * 100)}%</span>
      <span className="num mt-1 text-[10px] leading-none opacity-70">
        {mult === null ? "—" : `×${mult.toFixed(2)}`}
      </span>
    </>
  );
  // Whole class strings, never assembled from pieces: Tailwind reads this file, not the DOM.
  const shell = `flex h-full min-h-[52px] flex-col items-center justify-center border uppercase ${
    selected
      ? "border-amber bg-amber text-black"
      : staked
        ? "border-amber/60 text-bone"
        : "border-line text-bone"
  }`;

  if (!onPick) return <div className={`${shell} ${share === null ? "text-dim" : ""}`}>{inner}</div>;
  return (
    <button
      type="button"
      className={`${shell} cursor-pointer transition-colors hover:border-bone disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-line`}
      disabled={disabled}
      title={blocked ?? undefined}
      aria-pressed={selected}
      aria-label={`${yes ? "Yes" : "No"} on ${label}`}
      onClick={() => onPick(yes)}
    >
      {inner}
    </button>
  );
}

export function Markets({
  event,
  markets,
  refresh,
  children,
}: {
  event: EventPublic;
  markets: MarketState[] | null;
  refresh: () => void;
  /** What sits between the board and the ticket at the foot of the rail. */
  children?: React.ReactNode;
}) {
  const { address, walletClient } = useWallet();
  const { gate, refresh: refreshGate } = useGate();
  const [amount, setAmount] = useState("25");
  const [pick, setPick] = useState<{ i: number; yes: boolean } | null>(null);
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
      setPick(null);
      refresh();
      refreshGate();
    } catch (e) {
      setStatus(null);
      setError(shortError(e));
    } finally {
      setBusy(null);
    }
  }

  const resolved = event.outcome !== null;
  const empty = markets !== null && markets.every((m) => m.pool[0] + m.pool[1] === 0n);
  const picked = pick ? { ...pick, label: event.outcomes[pick.i], pool: markets?.[pick.i]?.pool ?? ZERO } : null;
  // One button, and it says exactly why it will not fire.
  const cta = !address
    ? "Sign in to bet"
    : !gate?.verified
      ? "Verify to unlock"
      : !open
        ? "Betting closed"
        : !picked
          ? "Pick a side"
          : !parsed
            ? "Enter an amount"
            : `Place ${usdc(parsed)} on ${picked.yes ? "yes" : "no"}`;

  return (
    <section aria-label="Markets" className="flex flex-1 flex-col">
      {/* 46px so this header sits on the same baseline as the station bar and the channel bug. */}
      <div className="flex h-[46px] items-center justify-between border-b border-line px-2">
        {/* Every panel title in the station is the same tracked mono cap. */}
        <h2 className="tag text-bone">markets</h2>
        <span className="tag">parimutuel · 2% fee</span>
      </div>

      {/* A price table, not a stack of cards: one row per market, fixed columns, so every market of
          an event is on screen at once and the board reads down the YES and NO columns. */}
      <div className="grid grid-cols-[1fr_96px_96px] border-b border-line px-2 py-1">
        <span className="tag">market</span>
        <span className="tag text-center">yes</span>
        <span className="tag text-center">no</span>
      </div>

      <ul>
        {event.outcomes.map((label, i) => {
          const m = markets?.[i] ?? { pool: ZERO, stake: ZERO };
          const won = event.outcome === i;
          const total = m.pool[0] + m.pool[1];
          return (
            <li
              key={i}
              className={`grid grid-cols-[1fr_96px_96px] items-stretch gap-1 border-b border-line px-2 py-1 ${
                resolved && won ? "bg-bone/5" : ""
              }`}
            >
              <div className="min-w-0 self-center py-1 pr-2">
                <p className="text-[13px] leading-[1.35] text-bone">{label}</p>
                {resolved ? (
                  <p className="num mt-0.5 text-[11px] text-dim">
                    {won ? "resolved yes" : "resolved no"}
                    {m.stake[0] > 0n || m.stake[1] > 0n ? (
                      <> · payout {usdc(marketPayout(m.stake, m.pool, won))}</>
                    ) : null}
                  </p>
                ) : m.stake[0] > 0n || m.stake[1] > 0n ? (
                  <p className="num mt-0.5 text-[11px] text-amber">
                    you {usdc(m.stake[1])} yes · {usdc(m.stake[0])} no
                  </p>
                ) : (
                  <p className="num mt-0.5 text-[11px] text-dim">pool {usdc(total)}</p>
                )}
              </div>

              {[true, false].map((yes) => (
                <PriceCell
                  key={String(yes)}
                  yes={yes}
                  label={label}
                  pool={m.pool}
                  staked={(yes ? m.stake[1] : m.stake[0]) > 0n}
                  selected={pick?.i === i && pick.yes === yes}
                  disabled={busy !== null}
                  blocked={blocked}
                  busy={busy === `${i}-${yes}`}
                  onPick={resolved ? undefined : (side) => setPick({ i, yes: side })}
                />
              ))}
            </li>
          );
        })}
      </ul>

      {open && empty ? (
        <p className="tag border-b border-line px-2 py-2">
          awaiting first stake
          <span className="caret" aria-hidden />
        </p>
      ) : null}

      {children}

      {/* The ticket: the one place a bet is committed — pick a side above, set the stake, hit it.
          It sits at the foot of the rail, on the chyron's line, and exists only while the book is
          open: a dead ticket is worse than no ticket. */}
      <div aria-live="polite" hidden={!open} className="mt-auto border-t border-line bg-panel px-2 py-2">
        <div className="flex items-center gap-2">
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

        <p className="num mt-2 truncate text-[11px] tracking-[0.14em] text-dim uppercase">
          {picked && parsed
            ? `${picked.label} · ${picked.yes ? "yes" : "no"} · returns ${usdc(previewPayout(parsed, picked.yes, picked.pool))}`
            : "— no side picked —"}
        </p>

        {!gate?.verified && address ? (
          <a href="/verify" className="btn btn-primary mt-2 w-full">
            Verify to unlock
          </a>
        ) : (
          <button
            type="button"
            className="btn btn-primary mt-2 w-full"
            disabled={!!blocked || !picked || busy !== null}
            onClick={() => picked && bet(picked.i, picked.yes)}
          >
            {busy !== null ? "Confirming…" : cta}
          </button>
        )}

        {status ? <p className="num mt-1 text-[11px] text-bone">{status}</p> : null}
        {error ? <p className="num mt-1 text-[11px] text-flare">{error}</p> : null}
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
