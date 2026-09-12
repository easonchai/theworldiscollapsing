"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  createWalletClient,
  custom,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
  type WalletClient,
  type WriteContractParameters,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PrivyProvider, getEmbeddedConnectedWallet, usePrivy, useWallets } from "@privy-io/react-auth";
import {
  SmartWalletsProvider,
  useSmartWallets,
  type SmartWalletClientType,
} from "@privy-io/react-auth/smart-wallets";
import { CHAIN_ID, DEV_WALLET_KEY, PRIVY_APP_ID, RPC_URL, chain, publicClient } from "@/lib/chain";

/**
 * The two things the app asks a wallet to do, so every write is `simulateContract` →
 * `writeContract(request)` whether a viem wallet or a Privy smart wallet is behind it.
 */
export type Signer = {
  signMessage(args: { account: Address; message: string }): Promise<Hex>;
  writeContract(request: WriteContractParameters): Promise<Hex>;
};

const fromViem = (client: WalletClient): Signer => ({
  signMessage: (args) => client.signMessage(args),
  writeContract: (request) => client.writeContract(request),
});

/** No confirmation modal on any write: the bet is already confirmed by the button that placed it. */
const silent = { uiOptions: { showWalletUIs: false } };

/**
 * Privy wraps the permissionless client by spreading it and replacing `sendTransaction`, so its
 * `writeContract` still closes over the bare client and skips the paymaster. Encoding the call and
 * sending it through the wrapper keeps gas sponsored on every write.
 */
const fromSmart = (client: SmartWalletClientType): Signer => ({
  signMessage: ({ message }) => client.signMessage({ message }, silent),
  writeContract: (request) =>
    client.sendTransaction(
      { to: request.address, data: encodeFunctionData(request), value: request.value },
      silent,
    ),
});

export type WalletState = {
  address: Address | null;
  walletClient: Signer | null;
  /** A paymaster pays this wallet's gas, so nothing ever needs to drip ETH into it. */
  sponsored: boolean;
  publicClient: typeof publicClient;
  ready: boolean;
  login: () => void;
  logout: () => void;
};

const WalletContext = createContext<WalletState>({
  address: null,
  walletClient: null,
  sponsored: false,
  publicClient,
  ready: false,
  login: () => {},
  logout: () => {},
});

export const useWallet = () => useContext(WalletContext);

/**
 * Privy: email login, embedded wallet, and — once the dashboard has smart wallets on for this
 * chain — a smart wallet the embedded wallet signs for, with gas paid by the dashboard's paymaster.
 * Until the smart wallet client is up (or if smart wallets are off in the dashboard) the embedded
 * wallet itself signs, over its EIP-1193 provider, and pays its own gas.
 */
function PrivyBridge({ children }: { children: ReactNode }) {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const { client: smart } = useSmartWallets();
  const wallet = getEmbeddedConnectedWallet(wallets) ?? wallets[0] ?? null;
  // Keyed by address so a client built for a previous wallet is never handed out.
  const [signer, setSigner] = useState<{ address: string; client: Signer } | null>(null);

  useEffect(() => {
    if (!wallet) return;
    let live = true;
    void (async () => {
      await wallet.switchChain(chain.id).catch(() => {});
      const provider = await wallet.getEthereumProvider();
      if (!live) return;
      setSigner({
        address: wallet.address,
        client: fromViem(
          createWalletClient({ account: wallet.address as Address, chain, transport: custom(provider) }),
        ),
      });
    })();
    return () => {
      live = false;
    };
  }, [wallet]);

  const value = useMemo<WalletState>(() => {
    if (authenticated && smart) {
      return {
        address: smart.account.address,
        walletClient: fromSmart(smart),
        sponsored: true,
        publicClient,
        ready,
        login: () => login(),
        logout: () => void logout(),
      };
    }
    return {
      address: authenticated && wallet ? (wallet.address as Address) : null,
      walletClient: authenticated && wallet && signer?.address === wallet.address ? signer.client : null,
      sponsored: false,
      publicClient,
      ready,
      login: () => login(),
      logout: () => void logout(),
    };
  }, [authenticated, smart, wallet, signer, ready, login, logout]);
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

/** Dev wallet: a local anvil key, always signed in. Never on a public testnet. */
function DevBridge({ children }: { children: ReactNode }) {
  const value = useMemo<WalletState>(() => {
    const account = privateKeyToAccount(DEV_WALLET_KEY as Hex);
    return {
      address: account.address,
      walletClient: fromViem(createWalletClient({ account, chain, transport: http(RPC_URL) })),
      sponsored: false,
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
          embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" }, showWalletUIs: false },
          appearance: { theme: "dark", accentColor: "#F0A72E" },
        }}
      >
        <SmartWalletsProvider>
          <PrivyBridge>{children}</PrivyBridge>
        </SmartWalletsProvider>
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
