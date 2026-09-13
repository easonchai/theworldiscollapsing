import { billsRealMoney, makeBudget, unlimited } from "./budget.js";
import path from "node:path";
import type { Address, Hex } from "viem";
import { fetchRound } from "./drand.js";
import { env, flag, intEnv, list } from "./env.js";
import { DEMO, REAL, runChannel, type Deps, type Render } from "./machine.js";
import { makeChain } from "./chain.js";
import { makePrisma } from "db";
import { makeAuthor } from "./author.js";
import { makeMediaStore, pruneEventMedia, startMediaServer, sweepWorkDir } from "./media.js";
import { makeOpenRouter } from "./openrouter.js";
import { claimPidFile } from "./pidfile.js";
import { makeReactorRender } from "./reactor.js";
import { makeRender } from "./render.js";
import { branchKey, parseRoot, revealBranch, sealingStore } from "./seal.js";
import { CHANNELS, makeStore } from "./store.js";
import { stubAuthor, stubRender } from "./stubs.js";

try {
  process.loadEnvFile();
} catch {}

const timing = flag("DEMO_MODE") ? DEMO : REAL;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** How long a sealed reveal waits for the CRE key before the engine decrypts the winner itself. */
const CRE_GRACE_MS = 3_000;
const prisma = makePrisma(env("DATABASE_URL"));
const store = makeStore(prisma);
await store.ensureChannels();

const log = (msg: string, extra?: Record<string, unknown>) =>
  console.log(new Date().toISOString(), msg, extra ? JSON.stringify(extra) : "");

const mediaDir = env("MEDIA_DIR", "./media");
// One engine per MEDIA_DIR, claimed before anything is authored: a copy that outlived its
// pnpm/tsx parents is otherwise invisible until the media port refuses to bind (and with
// MEDIA_STORE=blob, not even then), while it keeps spending.
const releasePid = claimPidFile(path.join(mediaDir, "engine.pid"));
process.on("exit", releasePid);
const mediaStoreKind = env("MEDIA_STORE", "local") === "blob" ? "blob" : "local";
// Events older than the newest MEDIA_KEEP per channel have their published media deleted; the wall
// only ever replays the newest DONE event and the channel page lists recent history.
const mediaKeep = intEnv("MEDIA_KEEP", "20", 1, Infinity);
// Branches rendered per event; fed to the author, createEvent and (later) the session estimate.
const nOutcomes = intEnv("N_OUTCOMES", "3", 2, 5);
// Declared here (rather than by Promise.all below) because the Reactor boot check needs it too.
const channels = list("CHANNELS", "sports,politics,culture,region");
// Fail fast: a channel id CHANNELS names but store.ts has no house style for would air looking
// unfinished, so the engine refuses to invent one rather than create it on demand.
const unknownChannels = channels.filter((c) => !Object.hasOwn(CHANNELS, c));
if (unknownChannels.length) throw new Error(`CHANNELS names ${unknownChannels.join(", ")}, which store.ts does not create`);
const plainMedia = makeMediaStore({
  store: mediaStoreKind,
  dir: mediaDir,
  baseUrl: env("MEDIA_BASE_URL", "http://localhost:4000"),
  token: process.env.BLOB_READ_WRITE_TOKEN,
});

// BRANCH_SEAL=1: branch videos are published as AES-256-GCM ciphertext and only the Chainlink CRE
// confidential workflow can release the winning key. Local media store only — reveal decrypts the
// ciphertext in place on this box. Default off, so nothing else changes.
const sealRoot = flag("BRANCH_SEAL") ? parseRoot(env("BRANCH_SEAL_ROOT")) : null;
if (sealRoot && mediaStoreKind !== "local") throw new Error("BRANCH_SEAL=1 needs MEDIA_STORE=local");
const media = sealRoot ? sealingStore(plainMedia, sealRoot) : plainMedia;

/**
 * Decrypt branch `outcome` of a sealed event with `key`, publish the plaintext and point
 * `Event.branchUrls[outcome]` at it. The file name is read back from the row: branch files carry a
 * random suffix, so it cannot be derived from the outcome index.
 */
async function publishWinningBranch(eventId: string, outcome: number, key: string): Promise<string> {
  const row = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
  const urls = [...((row.branchUrls as string[] | null) ?? [])];
  const sealed = urls[outcome];
  if (!sealed?.endsWith(".enc")) throw new Error(`event ${eventId} has no sealed branch ${outcome}`);
  const name = path.basename(new URL(sealed).pathname).replace(/\.enc$/, "");
  const local = await revealBranch(mediaDir, eventId, name, key);
  urls[outcome] = await plainMedia.storeFile(eventId, name, local);
  await prisma.event.update({ where: { id: eventId }, data: { branchUrls: urls } });
  return urls[outcome]!;
}

const mediaServer =
  mediaStoreKind === "local"
    ? startMediaServer({
        dir: mediaDir,
        port: Number(env("MEDIA_PORT", "4000")),
        reveal: sealRoot
          ? {
              secret: env("REVEAL_SECRET"),
              async handle({ eventId, outcome, key }) {
                const url = await publishWinningBranch(eventId, outcome, key);
                log("branch key released", { eventId, outcome, url });
                return { url };
              },
            }
          : undefined,
      })
    : null;
if (mediaServer) log("media server", { dir: mediaDir, port: Number(env("MEDIA_PORT", "4000")), sealed: !!sealRoot });

// Stubs are the default only when neither video vendor is configured at all.
const stubMode =
  flag("STUB_MODE") ||
  (process.env.STUB_MODE !== "0" &&
    !process.env.OPENROUTER_API_KEY &&
    !process.env.OPENROUTER_BASE_URL &&
    !process.env.REACTOR_API_KEY);

// VIDEO_VENDOR: reactor when REACTOR_API_KEY is set, else openrouter when an OpenRouter key or base
// URL is set, else stub. An explicit VIDEO_VENDOR overrides that priority; STUB_MODE=1 still forces
// stub for both author and render regardless of VIDEO_VENDOR (spec section 3).
const explicitVendor = process.env.VIDEO_VENDOR;
const videoVendor: "reactor" | "openrouter" | "stub" = stubMode
  ? "stub"
  : explicitVendor === "reactor" || explicitVendor === "openrouter" || explicitVendor === "stub"
    ? explicitVendor
    : process.env.REACTOR_API_KEY
      ? "reactor"
      : "openrouter";

// Global concurrent-Reactor-session ceiling; boot fails below if CHANNELS needs more than this.
const reactorSessions = intEnv("REACTOR_SESSIONS", "4", 1, Infinity);
const reactorSidecarKind = env("REACTOR_SIDECAR", "real") === "fake" ? "fake" : "real";
if (videoVendor === "reactor" && channels.length > reactorSessions) {
  throw new Error(
    `REACTOR_SESSIONS=${reactorSessions} is fewer than CHANNELS (${channels.length}): every channel needs its own session slot`,
  );
}

// What this engine stamps on every event it authors, and the only provenance it will resume and
// render (machine.ts runChannel). Reactor's fake sidecar is a free loopback, not the real vendor, so
// it gets its own "fake" provenance rather than being lumped in with a real Reactor engine — that
// mix-up is exactly what ticket 21 (2026-09-12) was about: a paid engine resumed and rendered an
// event a free fake-sidecar soak had authored, opening a real billed Reactor session over a canned script.
const provenanceVendor = videoVendor === "reactor" ? (reactorSidecarKind === "fake" ? "fake" : "reactor") : videoVendor;
const provenance = `${provenanceVendor}:${timing === DEMO ? "demo" : "real"}`;

// Intermediate clips and stills never leave the engine box; only finished files go through the media store.
const workDir = path.join(mediaDir, ".work");
// A directory here at boot belongs to no live session, since the pidfile above already guarantees
// this is the only engine touching MEDIA_DIR. render()'s own sweep runs in a `finally`, which a
// signal skips, so this is the one place that also catches SIGKILL, a panic and a power cut (ticket 22).
const swept = await sweepWorkDir(workDir);
if (swept.dirs) log("swept work dir", { dirs: swept.dirs, bytes: swept.bytes });

// Declared here rather than beside the signal handlers below: a live Reactor session has to carry
// the signal so shutdown can close it and true up its reservation (ticket 31).
const ac = new AbortController();

let author = stubAuthor;
let render: Render = stubRender({
  workDir,
  store: media,
  firstHalfSec: (timing.txBufferMs + timing.firstHalfMs) / 1000, // the whole betting window, as produce() authors it
  secondHalfSec: timing.secondHalfMs / 1000,
});

// Hard ceiling on everything bought from OpenRouter or Reactor, persisted in World.spendUsd across
// restarts. Only a vendor that actually bills is metered: against the local OpenRouter fake or the
// fake Reactor sidecar, clips are free, so charging them a real rate table just stops the wall a few
// events into a soak (and World.spendUsd is cumulative, so a restart does not clear it).
const baseUrl = env("OPENROUTER_BASE_URL", "https://openrouter.ai");
const paidVendor = billsRealMoney(baseUrl) || (videoVendor === "reactor" && reactorSidecarKind !== "fake");
const capUsd = Number(env("MAX_SPEND_USD", "20"));
const budget = paidVendor
  ? makeBudget({
      capUsd,
      spentUsd: (await prisma.world.findUnique({ where: { id: 1 } }))?.spendUsd ?? 0,
      persist: async (usd) => {
        await prisma.world.update({ where: { id: 1 }, data: { spendUsd: { increment: usd } } });
      },
      log,
    })
  : unlimited();
if (!stubMode) log("budget", paidVendor ? { capUsd, spentUsd: budget.spent() } : { capUsd: null, vendor: baseUrl, note: "not openrouter.ai: spend cap off, nothing recorded" });

if (!stubMode) {
  // Authoring always goes through OpenRouter regardless of video vendor — Reactor is video-only and
  // does not change how an event is written (spec section 6 / ticket 15).
  const or = makeOpenRouter({
    baseUrl,
    apiKey: env("OPENROUTER_API_KEY"),
    imageModel: env("IMAGE_MODEL", "google/gemini-3.1-flash-image"),
    onUsage: (usd, model) => budget.charge(usd, model),
  });
  author = makeAuthor({
    or,
    model: env("AUTHOR_MODEL", "openai/gpt-5-mini"),
    // gpt-5-mini supports reasoning and structured outputs, at $0.25/M in and $2/M out — authoring is
    // one call an event, so the cheap model is the default and AUTHOR_MODEL buys a bigger one.
    reasoning: { effort: "medium" },
    subgraphUrl: process.env.SUBGRAPH_URL,
    log,
  });
  if (videoVendor === "reactor") {
    const sidecarDir = path.join(import.meta.dirname, "..", "sidecar");
    render = makeReactorRender({
      python: env("REACTOR_PYTHON", "python3"),
      sidecar: path.join(sidecarDir, reactorSidecarKind === "fake" ? "fake_reactor.py" : "reactor_sidecar.py"),
      sessions: reactorSessions,
      workDir,
      store: media,
      budget,
      signal: ac.signal,
      log,
    });
  } else {
    render = makeRender({
      or,
      store: media,
      workDir,
      videoModel: env("VIDEO_MODEL", "minimax/hailuo-3-max"),
      pollIntervalMs: 3_000,
      pollTimeoutMs: 15 * 60_000,
      budget,
      imageCostUsd: Number(env("IMAGE_COST_USD", "0.04")),
      log,
    });
  }
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
  nOutcomes,
  provenance,
  now: Date.now,
  sleep,
  log,
  alwaysOn: flag("ALWAYS_ON"),
  budget: stubMode ? undefined : budget,
  // The CRE workflow releases the winning key when it sees Arena.Resolved; give it a head start,
  // then reveal locally. The engine holds BRANCH_SEAL_ROOT anyway, so this costs no secrecy, and a
  // reveal that plays ciphertext is worse than no sealing at all.
  // Blob-stored media is not swept: `del` there is a network call per file and nothing runs the
  // hosted store unattended yet. ponytail: add a blob sweep when MEDIA_STORE=blob runs for days.
  pruneMedia:
    mediaStoreKind === "local"
      ? async (channelId) => pruneEventMedia(mediaDir, await store.oldEventIds(channelId, mediaKeep))
      : undefined,
  revealWinner: sealRoot
    ? async (ev, outcome) => {
        await sleep(CRE_GRACE_MS);
        const row = await prisma.event.findUniqueOrThrow({ where: { id: ev.id } });
        const url = ((row.branchUrls as string[] | null) ?? [])[outcome] ?? null;
        if (!url?.endsWith(".enc")) return url; // the CRE key got there first
        const plain = await publishWinningBranch(ev.id, outcome, branchKey(sealRoot, ev.id, outcome));
        log("no CRE key in time, revealed the winning branch locally", { eventId: ev.id, outcome, url: plain });
        return plain;
      }
    : undefined,
};

/**
 * A channel sees the abort only between steps, and a step can be mid-sleep for a 60 s half or a
 * 15-minute render poll. Waiting that long with nothing on stdout reads as a hung engine and invites
 * `kill -9`, which orphans the node grandchild pnpm/tsx spawned — still driving the chain, the
 * database and the spend counter. So: say it, then leave. Every step is idempotent against chain
 * state, so the next start resumes where this one stopped.
 *
 * 8 s, not the 3 s this held until ticket 31, and the extra 5 s buys exactly one thing: a live
 * Reactor session now sees the abort, and the worst case for closing it is SIGTERM, 3 s, SIGKILL,
 * 2 s to reap, and then one true-up charge to persist. Exiting at 3 s landed inside that window and
 * left the session's up-front reservation on World.spendUsd with nothing behind it. This is still
 * far short of letting a channel finish a step, which is the thing the paragraph above refuses.
 */
const SHUTDOWN_GRACE_MS = 8_000;
// One Ctrl-C arrives twice: the terminal signals the whole process group, then tsx relays the same
// signal to its child about 30 ms later. Measured 2026-09-13; without this window the "second
// signal" exit below fired on every Ctrl-C, skipped the grace and stranded a session's reservation.
const SIGNAL_DEDUP_MS = 1_000;
let firstSignalAt = 0;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (ac.signal.aborted) {
      if (Date.now() - firstSignalAt < SIGNAL_DEDUP_MS) return; // the relay of the signal already handled
      process.exit(1); // a real second signal: stop waiting for the channels
    }
    firstSignalAt = Date.now();
    log("shutting down", { signal: sig, graceMs: SHUTDOWN_GRACE_MS });
    ac.abort();
    mediaServer?.close();
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  });
}

deps.log("engine start", {
  channels,
  vendor: videoVendor,
  sessions: videoVendor === "reactor" ? reactorSessions : undefined,
  nOutcomes,
  demo: timing === DEMO,
  alwaysOn: deps.alwaysOn,
  mediaStore: mediaStoreKind,
  provenance, // events authored under any other provenance are skipped on resume, not rendered (ticket 21)
});
await Promise.all(channels.map((c) => runChannel(c, deps, ac.signal)));
mediaServer?.close();
await prisma.$disconnect();
