// Perpetual synthetic bettors: keeps every open market busy so the wall, the subgraph and the
// payout arithmetic all have something real to chew on. Runs forever until SIGINT/SIGTERM; pass
// --events N to stop after N events have been bet and claimed.
//
//   pnpm --filter engine bettor                       # perpetual, config from apps/engine/.env
//   pnpm --filter engine bettor -- --events 2         # bounded, the README's smoke
//
// Keys come from the env (BETTOR_KEYS, GATE_OWNER_PRIVATE_KEY) and never from the command line.
// The Gate owner is also the funder: it verifies each bettor and tops its native balance up, so on
// anvil that is account 0 and on Base Sepolia it is the deployer wallet.
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  parseEventLogs,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil, baseSepolia } from "viem/chains";
import { arenaAbi } from "contracts/abi/Arena";
import { gateAbi } from "contracts/abi/Gate";
import { mockusdcAbi } from "contracts/abi/MockUSDC";
import { makePrisma } from "db";
import { USDC, emptyCoverage, makeRng, planBet, seedFor } from "../src/bettor-plan.js";

try {
  process.loadEnvFile();
} catch {}

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const req = (name: string, key: string): string => {
  const v = arg(name) ?? process.env[key];
  if (!v) throw new Error(`missing --${name} / ${key}`);
  return v;
};
const num = (key: string, dflt: number): number => Number(process.env[key] ?? dflt);

const rpcUrl = req("rpc", "RPC_URL");
const arena = req("arena", "ARENA_ADDRESS") as Address;
const usdc = req("usdc", "USDC_ADDRESS") as Address;
const gate = req("gate", "GATE_ADDRESS") as Address;
const dbUrl = req("db", "DATABASE_URL");
const chainId = num("CHAIN_ID", anvil.id);
const targetEvents = arg("events") ? Number(arg("events")) : Infinity;

const ownerKey = req("owner", "GATE_OWNER_PRIVATE_KEY") as Hex;
const allKeys = req("keys", "BETTOR_KEYS")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean) as Hex[];
const keys = allKeys.slice(0, Math.min(num("BETTORS", allKeys.length), allKeys.length));

const MIN_USDC = num("BET_MIN_USDC", 1);
const MAX_USDC = num("BET_MAX_USDC", 50);
const INTERVAL_MS = num("BET_INTERVAL_MS", 3000);
const FUND_MIN_ETH = process.env.FUND_MIN_ETH ?? "0.005";
const FUND_ETH = process.env.FUND_ETH ?? "0.01";
const SEED = num("BETTOR_SEED", Date.now() >>> 0);
/** Stop betting this long before lockTime so nothing in flight lands on BettingClosed. */
const MARGIN_MS = 3000;
/** Faucet below this; MockUSDC hands out 1000 USDC a day. */
const TOPUP_USDC = 200n * USDC;
const MAX_UINT = (1n << 256n) - 1n;

const chain = chainId === baseSepolia.id ? baseSepolia : anvil;
const transport = http(rpcUrl);
const pub = createPublicClient({ chain, transport });
const owner = privateKeyToAccount(ownerKey);
const bettors = keys.map((k) => privateKeyToAccount(k));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(new Date().toISOString().slice(11, 19), msg);
const short = (a: Address) => `${a.slice(0, 6)}..${a.slice(-4)}`;
const fmt = (v: bigint) => (Number(v) / 1e6).toFixed(2);
const reason = (e: unknown) => (e as { shortMessage?: string })?.shortMessage ?? String(e).slice(0, 120);

const wallets = new Map<Address, ReturnType<typeof createWalletClient>>();
const queues = new Map<Address, Promise<unknown>>();
const walletFor = (account: PrivateKeyAccount) => {
  let w = wallets.get(account.address);
  if (!w) wallets.set(account.address, (w = createWalletClient({ account, chain, transport })));
  return w;
};

/** One key is one nonce: serialize everything sent from an account. Different accounts run free. */
function lane<T>(account: PrivateKeyAccount, fn: () => Promise<T>): Promise<T> {
  const p = (queues.get(account.address) ?? Promise.resolve()).then(fn);
  queues.set(account.address, p.catch(() => {}));
  return p;
}

const write = (account: PrivateKeyAccount, request: unknown) =>
  lane(account, async () => {
    const hash = await walletFor(account).writeContract(request as never);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`tx reverted: ${hash}`);
    return receipt;
  });

const usdcOf = (a: Address) =>
  pub.readContract({ abi: mockusdcAbi, address: usdc, functionName: "balanceOf", args: [a] });
const onChain = (id: Hex) => pub.readContract({ abi: arenaAbi, address: arena, functionName: "events", args: [id] });

const balances: bigint[] = bettors.map(() => 0n);
const pnl: bigint[] = bettors.map(() => 0n);
const stats = { bets: 0, staked: 0n, claims: 0, paid: 0n, fees: 0n, events: 0 };
let stopping = false;

/** Fund with gas, verify, faucet and approve. Idempotent, so the loop can re-run it periodically. */
async function topUp() {
  for (const [i, b] of bettors.entries()) {
    try {
      if ((await pub.getBalance({ address: b.address })) < parseEther(FUND_MIN_ETH)) {
        await lane(owner, async () => {
          const hash = await walletFor(owner).sendTransaction({
            to: b.address,
            value: parseEther(FUND_ETH),
          } as never);
          await pub.waitForTransactionReceipt({ hash });
        });
        log(`fund   ${short(b.address)} +${FUND_ETH} ETH`);
      }
      const verified = await pub.readContract({
        abi: gateAbi,
        address: gate,
        functionName: "verified",
        args: [b.address],
      });
      if (!verified) {
        await write(owner, { abi: gateAbi, address: gate, functionName: "setVerified", args: [b.address, true] });
        log(`verify ${short(b.address)}`);
      }
      if ((await usdcOf(b.address)) < TOPUP_USDC) {
        // FaucetCooldown is a day: a broke bettor just sits out until the planner can afford it again.
        try {
          await write(b, { abi: mockusdcAbi, address: usdc, functionName: "faucet", args: [] });
          log(`faucet ${short(b.address)} -> ${fmt(await usdcOf(b.address))} USDC`);
        } catch (e) {
          log(`faucet ${short(b.address)} cooling (${reason(e)})`);
        }
      }
      const allowance = await pub.readContract({
        abi: mockusdcAbi,
        address: usdc,
        functionName: "allowance",
        args: [b.address, arena],
      });
      if (allowance < MAX_UINT / 2n) {
        await write(b, { abi: mockusdcAbi, address: usdc, functionName: "approve", args: [arena, MAX_UINT] });
      }
      balances[i] = await usdcOf(b.address);
    } catch (e) {
      log(`prep   ${short(b.address)} failed: ${reason(e)}`);
    }
  }
}

type Tracked = { id: Hex; channelId: string; seq: number; lockMs: number; stakers: Set<number> };
const tracked = new Map<Hex, Tracked>();

/** Bet on one event until its lock, keeping every market's YES and NO side non-empty. */
async function playEvent(row: { id: Hex; channelId: string; seq: number }) {
  const [nOutcomes, lockTime] = await onChain(row.id);
  if (nOutcomes === 0) return; // DB says BETTING but createEvent has not landed yet; next tick.
  const lockMs = Number(lockTime) * 1000;
  const rng = makeRng(seedFor(SEED, row.id));
  const yesBias = 0.25 + rng() * 0.5;
  const covered = emptyCoverage(nOutcomes);
  const t: Tracked = { ...row, lockMs, stakers: new Set() };
  tracked.set(row.id, t);
  stats.events++;
  log(`open   ${row.channelId}#${row.seq} ${nOutcomes} markets, ${Math.round((lockMs - Date.now()) / 1000)}s left`);

  while (!stopping && Date.now() < lockMs - MARGIN_MS) {
    const p = planBet({
      rng,
      nOutcomes,
      covered,
      balances,
      nowMs: Date.now(),
      lockMs,
      marginMs: MARGIN_MS,
      minUsdc: MIN_USDC,
      maxUsdc: MAX_USDC,
      intervalMs: INTERVAL_MS,
      yesBias,
    });
    if (!p) {
      await sleep(INTERVAL_MS);
      continue;
    }
    const b = bettors[p.bettor]!;
    try {
      const { request } = await pub.simulateContract({
        account: b,
        abi: arenaAbi,
        address: arena,
        functionName: "bet",
        args: [row.id, p.outcomeIdx, p.yes, p.amount],
      });
      const receipt = await write(b, request);
      covered[p.outcomeIdx]![p.yes ? 1 : 0] = true;
      balances[p.bettor]! -= p.amount;
      pnl[p.bettor]! -= p.amount;
      t.stakers.add(p.bettor);
      stats.bets++;
      stats.staked += p.amount;
      log(
        `bet    ${row.channelId}#${row.seq} m${p.outcomeIdx} ${p.yes ? "YES" : "NO "} ${fmt(p.amount).padStart(6)} ${short(b.address)} ${receipt.transactionHash.slice(0, 10)}`,
      );
    } catch (e) {
      log(`bet    ${row.channelId}#${row.seq} ${short(b.address)} skipped: ${reason(e)}`);
      balances[p.bettor] = await usdcOf(b.address);
    }
    await sleep(p.delayMs);
  }
}

/** Claim every tracked event that has resolved (or been bailed out into refunds). */
async function settle() {
  for (const [id, t] of [...tracked]) {
    const [, , , resolved, outcome] = await onChain(id);
    const bailed = await pub.readContract({ abi: arenaAbi, address: arena, functionName: "bailed", args: [id] });
    if (!resolved && !bailed) continue;
    tracked.delete(id);
    log(bailed ? `bailed ${t.channelId}#${t.seq} — refunds only` : `won    ${t.channelId}#${t.seq} outcome ${outcome}`);
    for (const i of t.stakers) {
      const b = bettors[i]!;
      try {
        const { request } = await pub.simulateContract({
          account: b,
          abi: arenaAbi,
          address: arena,
          functionName: "claim",
          args: [id],
        });
        const receipt = await write(b, request);
        const [claimed] = parseEventLogs({ abi: arenaAbi, eventName: "Claimed", logs: receipt.logs });
        const payout = claimed?.args.payout ?? 0n;
        const fee = claimed?.args.fee ?? 0n;
        balances[i]! += payout;
        pnl[i]! += payout;
        stats.claims++;
        stats.paid += payout;
        stats.fees += fee;
        log(
          `claim  ${t.channelId}#${t.seq} ${short(b.address)} +${fmt(payout)} fee ${fmt(fee)} pnl ${fmt(pnl[i]!)}`,
        );
      } catch (e) {
        log(`claim  ${t.channelId}#${t.seq} ${short(b.address)} nothing (${reason(e)})`);
      }
    }
  }
}

const summary = () =>
  log(
    `summary bets=${stats.bets} staked=${fmt(stats.staked)} events=${stats.events} claims=${stats.claims} paid=${fmt(stats.paid)} fee=${fmt(stats.fees)} | ` +
      bettors.map((b, i) => `${short(b.address)} ${fmt(balances[i]!)} (${fmt(pnl[i]!)})`).join(" | "),
  );

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1);
    stopping = true;
    log(`${sig} — winding down`);
  });
}

const prisma = makePrisma(dbUrl);
log(`bettor seed=${SEED} bettors=${bettors.length} funder=${short(owner.address)} events=${targetEvents} chain=${chain.name}`);
await topUp();

const seen = new Set<string>();
const running = new Set<Promise<unknown>>();
const ticker = setInterval(summary, 60_000);
let lastTopUp = Date.now();

while (!stopping) {
  if (seen.size < targetEvents) {
    const rows = await prisma.event.findMany({
      where: { state: "BETTING" },
      select: { id: true, channelId: true, seq: true },
    });
    for (const row of rows) {
      if (seen.has(row.id) || seen.size >= targetEvents) continue;
      seen.add(row.id);
      const p = playEvent({ ...row, id: row.id as Hex })
        .catch((e) => log(`event  ${row.channelId}#${row.seq} failed: ${reason(e)}`))
        .finally(() => running.delete(p));
      running.add(p);
    }
  }
  await settle();
  if (Date.now() - lastTopUp > 30_000) {
    lastTopUp = Date.now();
    await topUp();
  }
  if (seen.size >= targetEvents && running.size === 0 && tracked.size === 0) break;
  await sleep(1000);
}

clearInterval(ticker);
await Promise.allSettled([...running]);
await settle();
summary();
log(`treasury fee collected ${fmt(stats.fees)} USDC`);
await prisma.$disconnect();
process.exit(0);
