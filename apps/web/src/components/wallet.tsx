"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createWalletClient, custom, http, type Address, type Hex, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PrivyProvider, getEmbeddedConnectedWallet, usePrivy, useWallets } from "@privy-io/react-auth";
import { CHAIN_ID, DEV_WALLET_KEY, PRIVY_APP_ID, RPC_URL, chain, publicClient } from "@/lib/chain";

export type WalletState = {
  address: Address | null;
  walletClient: WalletClient | null;
  publicClient: typeof publicClient;
  ready: boolean;
  login: () => void;
  logout: () => void;
};

const WalletContext = createContext<WalletState>({
  address: null,
  walletClient: null,
  publicClient,
  ready: false,
  login: () => {},
  logout: () => {},
});

export const useWallet = () => useContext(WalletContext);

/** Privy: email login, embedded wallet, viem client over the wallet's EIP-1193 provider. */
function PrivyBridge({ children }: { children: ReactNode }) {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const wallet = getEmbeddedConnectedWallet(wallets) ?? wallets[0] ?? null;
  // Keyed by address so a client built for a previous wallet is never handed out.
  const [signer, setSigner] = useState<{ address: string; client: WalletClient } | null>(null);

  useEffect(() => {
    if (!wallet) return;
    let live = true;
    void (async () => {
      await wallet.switchChain(chain.id).catch(() => {});
      const provider = await wallet.getEthereumProvider();
      if (!live) return;
      setSigner({
        address: wallet.address,
        client: createWalletClient({ account: wallet.address as Address, chain, transport: custom(provider) }),
      });
    })();
    return () => {
      live = false;
    };
  }, [wallet]);

  const value = useMemo<WalletState>(
    () => ({
      address: authenticated && wallet ? (wallet.address as Address) : null,
      walletClient: authenticated && wallet && signer?.address === wallet.address ? signer.client : null,
      publicClient,
      ready,
      login: () => login(),
      logout: () => void logout(),
    }),
    [authenticated, wallet, signer, ready, login, logout],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

/** Dev wallet: a local anvil key, always signed in. Never on a public testnet. */
function DevBridge({ children }: { children: ReactNode }) {
  const value = useMemo<WalletState>(() => {
    const account = privateKeyToAccount(DEV_WALLET_KEY as Hex);
    return {
      address: account.address,
      walletClient: createWalletClient({ account, chain, transport: http(RPC_URL) }),
      publicClient,
      ready: true,
      login: () => {},
      logout: () => {},
    };
  }, []);
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

function Refuse({ reason }: { reason: string }) {
  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <p className="max-w-[60ch] border border-flare/60 bg-flare/10 p-4 font-mono text-sm text-bone">{reason}</p>
    </div>
  );
}

export function WalletProvider({ children }: { children: ReactNode }) {
  if (PRIVY_APP_ID) {
    return (
      <PrivyProvider
        appId={PRIVY_APP_ID}
        config={{
          loginMethods: ["email"],
          defaultChain: chain,
          supportedChains: [chain],
          embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
          appearance: { theme: "dark", accentColor: "#F0A72E" },
        }}
      >
        <PrivyBridge>{children}</PrivyBridge>
      </PrivyProvider>
    );
  }
  if (!DEV_WALLET_KEY) {
    return <Refuse reason="No wallet configured. Set NEXT_PUBLIC_PRIVY_APP_ID, or NEXT_PUBLIC_DEV_WALLET_KEY for a local chain." />;
  }
  if (CHAIN_ID === 84532) {
    return <Refuse reason="NEXT_PUBLIC_DEV_WALLET_KEY is refused on Base Sepolia (84532). Use Privy: set NEXT_PUBLIC_PRIVY_APP_ID." />;
  }
  return <DevBridge>{children}</DevBridge>;
}
