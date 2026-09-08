import type { Address, Hex } from "viem";
import { fetchRound } from "./drand.js";
import { DEMO, REAL, runChannel, type Deps } from "./machine.js";
import { makeChain } from "./chain.js";
import { makePrisma } from "db";
import { makeStore } from "./store.js";
import { stubAuthor, stubRender } from "./stubs.js";

try {
  process.loadEnvFile();
} catch {}

const env = (k: string, fallback?: string): string => {
  const v = process.env[k] ?? fallback;
  if (v === undefined || v === "") throw new Error(`missing env ${k}`);
  return v;
};

const timing = process.env.DEMO_MODE === "1" ? DEMO : REAL;
const prisma = makePrisma(env("DATABASE_URL"));
const store = makeStore(prisma);
await store.ensureChannels();

const deps: Deps = {
  store,
  chain: makeChain({
    rpcUrl: env("RPC_URL"),
    chainId: Number(env("CHAIN_ID")),
    privateKey: env("RESOLVER_PRIVATE_KEY") as Hex,
    arena: env("ARENA_ADDRESS") as Address,
  }),
  drand: { fetchRound },
  author: stubAuthor,
  render: stubRender({
    dir: env("MEDIA_DIR", "./media"),
    baseUrl: env("MEDIA_BASE_URL", "http://localhost:4000"),
    firstHalfSec: timing.firstHalfMs / 1000,
    secondHalfSec: timing.secondHalfMs / 1000,
  }),
  timing,
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (msg, extra) => console.log(new Date().toISOString(), msg, extra ? JSON.stringify(extra) : ""),
  alwaysOn: process.env.ALWAYS_ON === "1",
};

const ac = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => ac.abort());

const channels = env("CHANNELS", "sports,politics,culture,region").split(",");
deps.log("engine start", { channels, demo: timing === DEMO, alwaysOn: deps.alwaysOn });
await Promise.all(channels.map((c) => runChannel(c, deps, ac.signal)));
await prisma.$disconnect();
