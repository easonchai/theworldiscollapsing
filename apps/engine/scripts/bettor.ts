// Drives real bets against a running engine so the subgraph has something to index.
//
//   RPC_URL=http://127.0.0.1:8545 ARENA_ADDRESS=0x.. USDC_ADDRESS=0x.. GATE_ADDRESS=0x.. \
//   DATABASE_URL=postgresql://... pnpm --filter engine exec tsx scripts/bettor.ts --events 2
//
// Anvil account 0 owns the Gate, so it can verify accounts 2–5; those four faucet, approve,
// bet on whatever event is BETTING, then claim once the engine resolves it.
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import { arenaAbi } from "contracts/abi/Arena";
import { gateAbi } from "contracts/abi/Gate";
import { mockusdcAbi } from "contracts/abi/MockUSDC";
import { makePrisma } from "db";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const req = (name: string, env: string): string => {
  const v = arg(name) ?? process.env[env];
  if (!v) throw new Error(`missing --${name} / ${env}`);
  return v;
};

const rpcUrl = req("rpc", "RPC_URL");
const arena = req("arena", "ARENA_ADDRESS") as Address;
const usdc = req("usdc", "USDC_ADDRESS") as Address;
const gate = req("gate", "GATE_ADDRESS") as Address;
const targetEvents = Number(arg("events") ?? "2");

// anvil deterministic accounts: 0 is the Gate owner / engine resolver, 2–5 are the bettors.
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const BETTOR_KEYS: Hex[] = [
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
];

const USDC = 1_000_000n; // 6 decimals
const MAX_UINT = (1n << 256n) - 1n;

const transport = http(rpcUrl);
const pub = createPublicClient({ chain: anvil, transport });
const owner = privateKeyToAccount(OWNER_KEY);
const bettors = BETTOR_KEYS.map((k) => privateKeyToAccount(k));
const wallet = (account: PrivateKeyAccount) => createWalletClient({ account, chain: anvil, transport });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string, extra?: Record<string, unknown>) =>
  console.log(msg, extra ? JSON.stringify(extra) : "");

async function send(account: PrivateKeyAccount, request: Parameters<ReturnType<typeof wallet>["writeContract"]>[0]) {
  const hash = await wallet(account).writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`tx reverted: ${hash}`);
  return receipt;
}

/** Verify, faucet and approve each bettor. Idempotent: safe to re-run against a live anvil. */
async function prepareBettors() {
  for (const b of bettors) {
    const verified = await pub.readContract({ abi: gateAbi, address: gate, functionName: "verified", args: [b.address] });
    if (!verified) {
      await send(owner, { abi: gateAbi, address: gate, functionName: "setVerified", args: [b.address, true] } as never);
    }
    const balance = await pub.readContract({ abi: mockusdcAbi, address: usdc, functionName: "balanceOf", args: [b.address] });
    if (balance < 200n * USDC) {
      await send(b, { abi: mockusdcAbi, address: usdc, functionName: "faucet", args: [] } as never);
    }
    const allowance = await pub.readContract({
      abi: mockusdcAbi,
      address: usdc,
      functionName: "allowance",
      args: [b.address, arena],
    });
    if (allowance < 1000n * USDC) {
      await send(b, { abi: mockusdcAbi, address: usdc, functionName: "approve", args: [arena, MAX_UINT] } as never);
    }
    log("bettor ready", { address: b.address, usdc: Number(await usdcOf(b.address)) / 1e6 });
  }
}

const usdcOf = (a: Address) =>
  pub.readContract({ abi: mockusdcAbi, address: usdc, functionName: "balanceOf", args: [a] });

const onChain = (id: Hex) => pub.readContract({ abi: arenaAbi, address: arena, functionName: "events", args: [id] });

/** A mix of YES and NO across outcome indexes, 10–50 USDC each. Bettor 0 bets twice on one market. */
function betPlan(nOutcomes: number) {
  return [
    { bettor: 0, outcomeIdx: 0, yes: true, amount: 10n * USDC },
    { bettor: 1, outcomeIdx: 0, yes: false, amount: 20n * USDC },
    { bettor: 2, outcomeIdx: 1 % nOutcomes, yes: true, amount: 30n * USDC },
    { bettor: 3, outcomeIdx: nOutcomes - 1, yes: false, amount: 40n * USDC },
    { bettor: 0, outcomeIdx: 0, yes: true, amount: 50n * USDC },
  ];
}

async function betOn(id: Hex, channelId: string) {
  const [nOutcomes, lockTime] = await onChain(id);
  for (const p of betPlan(nOutcomes)) {
    if (BigInt(Math.floor(Date.now() / 1000)) >= lockTime - 1n) {
      log("lock reached, stopping bets", { channelId, eventId: id });
      return;
    }
    const b = bettors[p.bettor];
    await send(b, {
      abi: arenaAbi,
      address: arena,
      functionName: "bet",
      args: [id, p.outcomeIdx, p.yes, p.amount],
    } as never);
    log("bet", {
      channelId,
      eventId: id,
      bettor: b.address,
      outcomeIdx: p.outcomeIdx,
      side: p.yes ? "YES" : "NO",
      usdc: Number(p.amount) / 1e6,
    });
  }
}

async function claimAll(id: Hex, channelId: string) {
  while (!(await onChain(id))[3]) await sleep(1000);
  const outcome = (await onChain(id))[4];
  log("resolved", { channelId, eventId: id, outcome });
  for (const b of bettors) {
    try {
      const { request } = await pub.simulateContract({
        account: b,
        abi: arenaAbi,
        address: arena,
        functionName: "claim",
        args: [id],
      });
      const receipt = await send(b, request as never);
      const [claimed] = parseEventLogs({ abi: arenaAbi, eventName: "Claimed", logs: receipt.logs });
      log("claim", {
        channelId,
        eventId: id,
        bettor: b.address,
        payoutUsdc: Number(claimed.args.payout) / 1e6,
        feeUsdc: Number(claimed.args.fee) / 1e6,
      });
    } catch {
      log("nothing to claim", { channelId, eventId: id, bettor: b.address });
    }
  }
}

const prisma = makePrisma(req("db", "DATABASE_URL"));
await prepareBettors();

const seen = new Set<string>();
const betOnEvents: { id: Hex; channelId: string }[] = [];
log("waiting for BETTING events", { targetEvents });
while (betOnEvents.length < targetEvents) {
  const rows = await prisma.event.findMany({ where: { state: "BETTING" }, select: { id: true, channelId: true } });
  for (const row of rows) {
    if (seen.has(row.id) || betOnEvents.length >= targetEvents) continue;
    seen.add(row.id);
    await betOn(row.id as Hex, row.channelId);
    betOnEvents.push({ id: row.id as Hex, channelId: row.channelId });
  }
  await sleep(500);
}

for (const ev of betOnEvents) await claimAll(ev.id, ev.channelId);
for (const b of bettors) log("final balance", { bettor: b.address, usdc: Number(await usdcOf(b.address)) / 1e6 });
await prisma.$disconnect();
