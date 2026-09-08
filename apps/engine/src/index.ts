import path from "node:path";
import type { Address, Hex } from "viem";
import { fetchRound } from "./drand.js";
import { DEMO, REAL, runChannel, type Deps, type Render } from "./machine.js";
import { makeChain } from "./chain.js";
import { makePrisma } from "db";
import { makeAuthor } from "./author.js";
import { makeMediaStore, startMediaServer } from "./media.js";
import { makeOpenRouter } from "./openrouter.js";
import { makeRender } from "./render.js";
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

const log = (msg: string, extra?: Record<string, unknown>) =>
  console.log(new Date().toISOString(), msg, extra ? JSON.stringify(extra) : "");

const mediaDir = env("MEDIA_DIR", "./media");
const mediaStoreKind = env("MEDIA_STORE", "local") === "blob" ? "blob" : "local";
const media = makeMediaStore({
  store: mediaStoreKind,
  dir: mediaDir,
  baseUrl: env("MEDIA_BASE_URL", "http://localhost:4000"),
  token: process.env.BLOB_READ_WRITE_TOKEN,
});
const mediaServer =
  mediaStoreKind === "local" ? startMediaServer({ dir: mediaDir, port: Number(env("MEDIA_PORT", "4000")) }) : null;
if (mediaServer) log("media server", { dir: mediaDir, port: Number(env("MEDIA_PORT", "4000")) });

// Stubs are the default only when OpenRouter is not configured at all.
const stubMode =
  process.env.STUB_MODE === "1" ||
  (process.env.STUB_MODE !== "0" && !process.env.OPENROUTER_API_KEY && !process.env.OPENROUTER_BASE_URL);

// Intermediate clips and stills never leave the engine box; only finished files go through the media store.
const workDir = path.join(mediaDir, ".work");

let author = stubAuthor;
let render: Render = stubRender({
  workDir,
  store: media,
  firstHalfSec: timing.firstHalfMs / 1000,
  secondHalfSec: timing.secondHalfMs / 1000,
});

if (!stubMode) {
  const or = makeOpenRouter({
    baseUrl: env("OPENROUTER_BASE_URL", "https://openrouter.ai"),
    apiKey: env("OPENROUTER_API_KEY"),
    imageModel: env("IMAGE_MODEL", "google/gemini-3.1-flash-image"),
  });
  author = makeAuthor({
    or,
    model: env("AUTHOR_MODEL", "openai/gpt-6-astra"),
    reasoning: { effort: "medium" }, // gpt-6-astra: reasoning is mandatory, "none" is rejected
    subgraphUrl: process.env.SUBGRAPH_URL,
  });
  render = makeRender({
    or,
    store: media,
    workDir,
    videoModel: env("VIDEO_MODEL", "minimax/hailuo-3-max"),
    pollIntervalMs: 3_000,
    pollTimeoutMs: 15 * 60_000,
    log,
  });
}

const deps: Deps = {
  store,
  chain: makeChain({
    rpcUrl: env("RPC_URL"),
    chainId: Number(env("CHAIN_ID")),
    privateKey: env("RESOLVER_PRIVATE_KEY") as Hex,
    arena: env("ARENA_ADDRESS") as Address,
  }),
  drand: { fetchRound },
  author,
  render,
  timing,
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log,
  alwaysOn: process.env.ALWAYS_ON === "1",
};

const ac = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => ac.abort());

const channels = env("CHANNELS", "sports,politics,culture,region").split(",");
deps.log("engine start", {
  channels,
  mode: stubMode ? "stub" : "openrouter",
  demo: timing === DEMO,
  alwaysOn: deps.alwaysOn,
  mediaStore: mediaStoreKind,
});
await Promise.all(channels.map((c) => runChannel(c, deps, ac.signal)));
mediaServer?.close();
await prisma.$disconnect();
