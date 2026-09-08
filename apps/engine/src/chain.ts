import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil, baseSepolia } from "viem/chains";
import { arenaAbi } from "contracts/abi/Arena";
import type { Chain } from "./machine.js";

export function makeChain(cfg: { rpcUrl: string; chainId: number; privateKey: Hex; arena: Address }): Chain {
  const chain = cfg.chainId === baseSepolia.id ? baseSepolia : anvil;
  const transport = http(cfg.rpcUrl);
  const account = privateKeyToAccount(cfg.privateKey);
  const pub = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });
  const base = { abi: arenaAbi, address: cfg.arena } as const;

  // One resolver key serves every channel: serialize sends so nonces never collide.
  let queue: Promise<unknown> = Promise.resolve();
  function send(fn: "createEvent" | "resolve", args: readonly unknown[]) {
    const p = queue.then(() => sendNow(fn, args));
    queue = p.catch(() => {});
    return p;
  }

  async function sendNow(fn: "createEvent" | "resolve", args: readonly unknown[]) {
    const hash = await wallet.writeContract({ ...base, functionName: fn, args } as never);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${fn} reverted: ${hash}`);
    const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
    return { tx: hash, blockTime: new Date(Number(block.timestamp) * 1000) };
  }

  return {
    async getEvent(id) {
      const [n, lockTime, round, resolved, outcome, signature] = await pub.readContract({
        ...base,
        functionName: "events",
        args: [id],
      });
      if (n === 0) return { exists: false };
      return { exists: true, lockTime, round, resolved, outcome, signature };
    },
    async createEvent(id, nOutcomes, lockTime, round) {
      const r = await send("createEvent", [id, nOutcomes, lockTime, round]);
      return { tx: r.tx, startTime: r.blockTime };
    },
    async resolve(id, signature) {
      return { tx: (await send("resolve", [id, signature])).tx };
    },
  };
}
