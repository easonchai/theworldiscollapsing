import { keccak256, toHex, type Hex } from "viem";
import { outcomeFor, roundForLock, roundTime, type Beacon } from "./drand.js";
import type { Authored } from "./authored.js";

// Per-channel lifecycle. Persisted states only; AUTHOR is transient (nothing to resume).
export type State =
  | "RENDER"
  | "READY"
  | "BETTING"
  | "LOCKED"
  | "RESOLVE"
  | "REVEAL"
  | "CANON"
  | "PAUSE"
  | "DONE"
  | "SKIPPED";

export type EventRow = {
  id: Hex;
  channelId: string;
  seq: number;
  state: State;
  title: string;
  premise: string;
  outcomes: string[];
  script: Authored;
  reasoning: string | null;
  firstHalfUrl: string | null;
  branchUrls: string[] | null;
  lockTime: Date | null;
  drandRound: bigint | null;
  startTime: Date | null;
  revealTime: Date | null;
  outcome: number | null;
  signature: Hex | null;
  createTx: Hex | null;
  resolveTx: Hex | null;
  renderAttempts: number;
  error: string | null;
};

export interface Store {
  /** Non-terminal events for a channel, seq ascending. */
  openEvents(channelId: string): Promise<EventRow[]>;
  nextSeq(channelId: string): Promise<number>;
  insert(row: EventRow): Promise<EventRow>;
  update(id: Hex, patch: Partial<EventRow>): Promise<EventRow>;
  canon(channelId: string, limit: number): Promise<string[]>;
  appendCanon(channelId: string, eventId: Hex, lines: string[]): Promise<void>;
  lastSeenAt(): Promise<Date | null>;
}

export type OnChainEvent =
  | { exists: false }
  | { exists: true; lockTime: bigint; round: bigint; resolved: boolean; outcome: number; signature: Hex };

export interface Chain {
  getEvent(id: Hex): Promise<OnChainEvent>;
  createEvent(id: Hex, nOutcomes: number, lockTime: bigint, round: bigint): Promise<{ tx: Hex; startTime: Date }>;
  resolve(id: Hex, signature: Hex): Promise<{ tx: Hex }>;
}

export interface Author {
  author(ctx: { channelId: string; seq: number; canon: string[] }): Promise<Authored>;
}

export interface Render {
  firstHalf(ev: EventRow): Promise<string>;
  branches(ev: EventRow): Promise<string[]>;
}

export type Timing = {
  txBufferMs: number; // headroom between sending createEvent and first-half start
  firstHalfMs: number;
  secondHalfMs: number;
  pauseMs: number;
  idlePollMs: number;
  renderRetryMs: number;
  drandRetryMs: number;
  maxRenderAttempts: number;
  presenceWindowMs: number;
};

export const REAL: Timing = {
  txBufferMs: 15_000,
  firstHalfMs: 60_000,
  secondHalfMs: 60_000,
  pauseMs: 30_000,
  idlePollMs: 10_000,
  renderRetryMs: 5_000,
  drandRetryMs: 2_000,
  maxRenderAttempts: 3,
  presenceWindowMs: 5 * 60_000,
};

export const DEMO: Timing = { ...REAL, txBufferMs: 3_000, firstHalfMs: 15_000, secondHalfMs: 10_000, pauseMs: 5_000 };

export type Deps = {
  store: Store;
  chain: Chain;
  drand: { fetchRound(round: bigint): Promise<Beacon> };
  author: Author;
  render: Render;
  timing: Timing;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  alwaysOn: boolean;
};

export const eventIdFor = (channelId: string, seq: number): Hex => keccak256(toHex(`${channelId}:${seq}`));

const LIVE = new Set<State>(["BETTING", "LOCKED", "RESOLVE", "REVEAL", "CANON", "PAUSE"]);

// In-flight branch renders, so RESOLVE never starts a second (paid) render of the same event.
const inflightBranches = new Map<Hex, Promise<EventRow>>();

export async function runChannel(channelId: string, d: Deps, signal: AbortSignal): Promise<void> {
  const open = await d.store.openEvents(channelId);
  let live = open.find((e) => LIVE.has(e.state)) ?? null;
  const pending = open.find((e) => e.state === "RENDER" || e.state === "READY") ?? null;
  let next: Promise<EventRow | null> | null = pending ? produce(channelId, d, pending) : null;

  let failures = 0; // consecutive skipped/failed productions

  while (!signal.aborted) {
    if (!live) {
      if (!next) {
        if (!(await present(d))) {
          await d.sleep(d.timing.idlePollMs);
          continue;
        }
        next = produce(channelId, d);
      }
      live = await next;
      next = null;
      if (!live) {
        // Every production costs money (authoring + video). Back off, never hot-loop on a broken vendor.
        failures++;
        await d.sleep(Math.min(d.timing.idlePollMs * 2 ** failures, 30 * 60_000));
        continue;
      }
      failures = 0;
    }
    try {
      live = await step(live, d, () => {
        // ponytail: next event is produced during BETTING regardless of presence, so at most
        // one event is generated after the last viewer leaves.
        next ??= produce(channelId, d);
      });
    } catch (e) {
      // Steps are idempotent against chain state, so a transient RPC/DB error just retries the step.
      d.log("step failed, retrying", { channelId, seq: live.seq, state: live.state, error: String(e).slice(0, 300) });
      await d.sleep(d.timing.idlePollMs);
      continue;
    }
    if (live.state === "DONE") live = null;
  }
}

async function present(d: Deps): Promise<boolean> {
  if (d.alwaysOn) return true;
  const seen = await d.store.lastSeenAt();
  return !!seen && d.now() - seen.getTime() < d.timing.presenceWindowMs;
}

/** AUTHOR + RENDER (first half). Returns null if the event was skipped or authoring failed. */
export async function produce(channelId: string, d: Deps, existing?: EventRow): Promise<EventRow | null> {
  let ev = existing ?? null;
  try {
    if (!ev) {
      const seq = await d.store.nextSeq(channelId);
      const canon = await d.store.canon(channelId, 50);
      const a = await d.author.author({ channelId, seq, canon });
      ev = await d.store.insert({
        id: eventIdFor(channelId, seq),
        channelId,
        seq,
        state: "RENDER",
        title: a.title,
        premise: a.premise,
        outcomes: a.outcomes,
        script: a,
        reasoning: a.reasoning ?? null,
        firstHalfUrl: null,
        branchUrls: null,
        lockTime: null,
        drandRound: null,
        startTime: null,
        revealTime: null,
        outcome: null,
        signature: null,
        createTx: null,
        resolveTx: null,
        renderAttempts: 0,
        error: null,
      });
      d.log("authored", { channelId, seq, title: a.title, outcomes: a.outcomes });
    }
    while (ev.state === "RENDER") {
      try {
        const url = await d.render.firstHalf(ev);
        ev = await d.store.update(ev.id, { firstHalfUrl: url, state: "READY", error: null });
      } catch (e) {
        ev = await d.store.update(ev.id, { renderAttempts: ev.renderAttempts + 1, error: String(e) });
        if (ev.renderAttempts >= d.timing.maxRenderAttempts) {
          ev = await d.store.update(ev.id, { state: "SKIPPED" });
          d.log("render failed, event skipped", { channelId, seq: ev.seq, error: ev.error });
          return null;
        }
        await d.sleep(d.timing.renderRetryMs);
      }
    }
    if (!ev.branchUrls) void ensureBranches(ev, d).catch(() => {});
    return ev;
  } catch (e) {
    d.log("produce failed", { channelId, error: String(e) });
    return null;
  }
}

function ensureBranches(ev: EventRow, d: Deps): Promise<EventRow> {
  let p = inflightBranches.get(ev.id);
  if (!p) {
    p = d.render
      .branches(ev)
      .then((urls) => d.store.update(ev.id, { branchUrls: urls }))
      .finally(() => inflightBranches.delete(ev.id));
    inflightBranches.set(ev.id, p);
  }
  return p;
}

async function step(ev: EventRow, d: Deps, onBetting: () => void): Promise<EventRow> {
  const sleepUntil = (msEpoch: number) => d.sleep(Math.max(0, msEpoch - d.now()));
  switch (ev.state) {
    case "READY": {
      const on = await d.chain.getEvent(ev.id);
      let lock: bigint, round: bigint, tx: Hex | null = null, startTime: Date;
      if (on.exists) {
        // restart after the tx landed but before we recorded it
        ({ lockTime: lock, round } = on);
        startTime = new Date(d.now());
      } else {
        lock = BigInt(Math.floor((d.now() + d.timing.txBufferMs + d.timing.firstHalfMs) / 1000));
        round = roundForLock(lock);
        ({ tx, startTime } = await d.chain.createEvent(ev.id, ev.outcomes.length, lock, round));
      }
      d.log("on-chain", { channelId: ev.channelId, seq: ev.seq, lock: Number(lock), round: Number(round), tx });
      return d.store.update(ev.id, {
        state: "BETTING",
        lockTime: new Date(Number(lock) * 1000),
        drandRound: round,
        startTime,
        createTx: tx,
      });
    }
    case "BETTING": {
      onBetting();
      await sleepUntil(ev.lockTime!.getTime());
      return d.store.update(ev.id, { state: "LOCKED" });
    }
    case "LOCKED": {
      await sleepUntil(Number(roundTime(ev.drandRound!)) * 1000 + 1000);
      return d.store.update(ev.id, { state: "RESOLVE" });
    }
    case "RESOLVE": {
      const on = await d.chain.getEvent(ev.id);
      let signature: Hex, outcome: number, tx: Hex | null = null;
      if (on.exists && on.resolved) {
        ({ signature, outcome } = on);
      } else {
        const beacon = await fetchBeacon(ev.drandRound!, d);
        ({ tx } = await d.chain.resolve(ev.id, beacon.signature));
        signature = beacon.signature;
        outcome = outcomeFor(signature, ev.id, ev.outcomes.length);
      }
      d.log("resolved", { channelId: ev.channelId, seq: ev.seq, outcome, label: ev.outcomes[outcome], tx });
      // Money is settled above; video is best-effort. A missing branch shows as a card, never blocks payout.
      let branchUrls = ev.branchUrls;
      if (!branchUrls) {
        try {
          branchUrls = (await ensureBranches(ev, d)).branchUrls;
        } catch (e) {
          d.log("branches unavailable at reveal", { seq: ev.seq, error: String(e) });
        }
      }
      return d.store.update(ev.id, {
        state: "REVEAL",
        outcome,
        signature,
        resolveTx: tx,
        revealTime: new Date(d.now()),
        branchUrls,
      });
    }
    case "REVEAL": {
      await d.sleep(d.timing.secondHalfMs);
      return d.store.update(ev.id, { state: "CANON" });
    }
    case "CANON": {
      await d.store.appendCanon(ev.channelId, ev.id, ev.script.canonUpdates[ev.outcome!] ?? []);
      return d.store.update(ev.id, { state: "PAUSE" });
    }
    case "PAUSE": {
      await d.sleep(d.timing.pauseMs);
      return d.store.update(ev.id, { state: "DONE" });
    }
    default:
      throw new Error(`step: unexpected state ${ev.state} for ${ev.id}`);
  }
}

/** Money is locked on-chain; keep trying until the beacon is served. */
async function fetchBeacon(round: bigint, d: Deps): Promise<Beacon> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await d.drand.fetchRound(round);
    } catch (e) {
      if (attempt % 10 === 1) d.log("drand fetch failed, retrying", { round: Number(round), attempt, error: String(e) });
      await d.sleep(d.timing.drandRetryMs);
    }
  }
}
