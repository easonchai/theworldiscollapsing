"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import { GATE, USDC, USDC_DECIMALS, gateAbi, mockusdcAbi, publicClient } from "@/lib/chain";
import { useWallet } from "./wallet";

/**
 * Poll a chain read while the page is open. Every number in the UI comes from the chain, not the DB.
 * `key` identifies the read's inputs, so changing address or event restarts the poll.
 */
export function usePoll<T>(read: () => Promise<T>, key: string, intervalMs = 2500) {
  const [value, setValue] = useState<T | null>(null);
  const readRef = useRef(read);

  useEffect(() => {
    readRef.current = read;
  });

  const refresh = useCallback(() => {
    void readRef.current().then(setValue, () => {});
  }, []);

  useEffect(() => {
    let live = true;
    const tick = () =>
      readRef.current().then(
        (v) => live && setValue(v),
        () => {},
      );
    void tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [key, intervalMs]);

  return { value, refresh };
}

export type GateState = { verified: boolean; balance: bigint; balanceText: string };

/** The gate flag and play-money balance for the connected wallet. */
export function useGate() {
  const { address } = useWallet();
  const { value, refresh } = usePoll<GateState | null>(
    async () => {
      if (!address) return null;
      const [verified, balance] = await Promise.all([
        publicClient.readContract({ address: GATE, abi: gateAbi, functionName: "verified", args: [address] }),
        publicClient.readContract({ address: USDC, abi: mockusdcAbi, functionName: "balanceOf", args: [address] }),
      ]);
      return { verified, balance, balanceText: formatUnits(balance, USDC_DECIMALS) };
    },
    `gate:${address ?? ""}`,
    4000,
  );
  return { gate: value, refresh };
}
