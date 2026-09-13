"use client";

import { useState } from "react";
import { isAddress, parseUnits, type Address } from "viem";
import { useFundWallet } from "@privy-io/react-auth";
import { USDC, USDC_DECIMALS, chain, mockusdcAbi, publicClient } from "@/lib/chain";
import { confirmed, txMessage, type TxMessage } from "@/lib/tx";
import { TxError } from "./bits";
import { useWallet } from "./wallet";

type Props = {
  balanceText: string;
  onMoved: () => void;
};

/**
 * Mainnet replaces the faucet with Privy's funding flow: card (MoonPay or Coinbase Onramp) or a
 * transfer from another wallet, all inside Privy's modal, landing as USDC on this chain. The way
 * out is a plain USDC transfer signed by the same wallet, so the user never sees a bridge, a
 * chain picker or gas.
 *
 * ponytail: off-ramp is "send USDC to an address". Privy's fiat off-ramp needs guided onboarding
 * (Bridge), so it is not wired; add it behind the same button when the account has it.
 */
export function Ramp({ balanceText, onMoved }: Props) {
  const { address, walletClient } = useWallet();
  const { fundWallet } = useFundWallet();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<TxMessage | null>(null);

  async function fund() {
    if (!address) return;
    setError(null);
    try {
      const r = await fundWallet({ address, options: { chain, asset: "USDC", amount: "20" } });
      setStatus(r.status === "completed" ? "Funds on the way. The balance updates when they land." : null);
      onMoved();
    } catch (e) {
      setError(txMessage(e));
    }
  }

  async function withdraw() {
    if (!walletClient || !address || !isAddress(to)) return;
    setBusy(true);
    setError(null);
    setStatus("Sending USDC…");
    try {
      const sim = await publicClient.simulateContract({
        address: USDC,
        abi: mockusdcAbi,
        functionName: "transfer",
        args: [to as Address, parseUnits(amount, USDC_DECIMALS)],
        account: address,
      });
      const tx = await walletClient.writeContract(sim.request);
      await confirmed(tx, () => "The transfer reverted on chain — nothing left the wallet.");
      setStatus(`Sent ${amount} USDC — ${tx.slice(0, 12)}…`);
      setAmount("");
      onMoved();
    } catch (e) {
      setStatus(null);
      setError(txMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const canWithdraw = !!walletClient && isAddress(to) && Number(amount) > 0 && !busy;

  return (
    <section className="bg-vac p-2">
      <p className="tag">step three</p>
      <h2 className="mt-1 text-[24px] text-bone">Fund</h2>
      <p className="mt-2 text-[14px] text-dim">USDC on {chain.name}. Balance: {balanceText}.</p>
      <button type="button" className="btn btn-primary mt-3 w-full" disabled={!address} onClick={fund}>
        Add USDC
      </button>
      <p className="mt-4 text-[14px] text-dim">Or send USDC out to another address.</p>
      <input
        className="field mt-2 w-full"
        placeholder="0x…"
        value={to}
        onChange={(e) => setTo(e.target.value.trim())}
        aria-label="destination address"
      />
      <input
        className="field mt-2 w-full"
        inputMode="decimal"
        placeholder="amount"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        aria-label="USDC amount"
      />
      <button type="button" className="btn mt-2 w-full" disabled={!canWithdraw} onClick={withdraw}>
        {busy ? "Working…" : "Send USDC"}
      </button>
      <div aria-live="polite">
        {status ? <p className="num mt-2 text-[12px] text-bone">{status}</p> : null}
        <TxError error={error} className="num mt-2 text-[12px]" />
      </div>
    </section>
  );
}
