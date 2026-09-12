import { SpendCapError, type Budget } from "./budget.js";
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
  costUsd: number | null; // video spend so far: first half + branches
  renderAttempts: number;
  error: string | null;
};

export interface Store {
  /** Non-terminal events for a channel, seq ascending. */
  openEvents(channelId: string): Promise<EventRow[]>;
  nextSeq(channelId: string): Promise<number>;
  insert(row: EventRow): Promise<EventRow>;
  get(id: Hex): Promise<EventRow | null>;
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

export type AuthorCtx = {
  channelId: string;
  seq: number;
  canon: string[];
  /** Playback budgets from Timing: the shot lists must add up to these. */
  firstHalfSec: number;
  secondHalfSec: number;
  nOutcomes: number;
};

export interface Author {
  author(ctx: AuthorCtx): Promise<Authored>;
}

export interface Render {
  /** Renders and stores the whole event. Resolves only when every file is in the media store. */
  render(ev: EventRow): Promise<{ firstHalfUrl: string; branchUrls: string[]; costUsd: number }>;
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
  firstHalfMs: 30_000,
  secondHalfMs: 30_000,
  // A Reactor render cycle runs ~135s, longer than the ~105s of first+second half air time, so the
  // pause between events has to cover the gap (ticket 10 / ADR 0002 amendment).
  pauseMs: 60_000,
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
  nOutcomes: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  alwaysOn: boolean;
  /** Spend ceiling; absent in tests and stub mode. */
  budget?: Budget;
  /**
   * BRANCH_SEAL=1 only: publish the plaintext of the winning branch at RESOLVE and return its URL
   * (null = leave `branchUrls` as they are). Without it a sealed reveal serves ciphertext.
   */
  revealWinner?: (ev: EventRow, outcome: number) => Promise<string | null>;
  /**
   * Drop the published media of this channel's events outside the retention window, returning how
   * many events were swept. Called once an event is off the wall; without it `MEDIA_DIR` grows for
   * as long as the engine runs. Local media store only.
   */
  pruneMedia?: (channelId: string) => Promise<number>;
};

// Authoring is charged at the real usage.cost afterwards; this only decides whether to start.
const AUTHOR_ESTIMATE_USD = 1;

export const eventIdFor = (channelId: string, seq: number): Hex => keccak256(toHex(`${channelId}:${seq}`));

const LIVE = new Set<State>(["BETTING", "LOCKED", "RESOLVE", "REVEAL", "CANON", "PAUSE"]);

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
      live = await step(live, d, async () => {
        // Presence is checked here, while the current event is on air, because by the time it ends
        // `next` is already primed and the gate below would never be reached. ponytail: at most one
        // event is still produced after the last viewer leaves — the one primed before they left.
        if (await present(d)) next ??= produce(channelId, d);
      });
    } catch (e) {
      // Steps are idempotent against chain state, so a transient RPC/DB error just retries the step.
      d.log("step failed, retrying", { channelId, seq: live.seq, state: live.state, error: String(e).slice(0, 300) });
      await d.sleep(d.timing.idlePollMs);
      continue;
    }
    if (live.state === "DONE" || live.state === "SKIPPED") live = null;
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
    if (!ev && d.budget) {
      try {
        d.budget.assertAffordable(AUTHOR_ESTIMATE_USD, "authoring");
      } catch {
        d.log("spend cap reached; not authoring", { channelId, spentUsd: d.budget.spent(), capUsd: d.budget.capUsd });
        return null;
      }
    }
    if (!ev) {
      const seq = await d.store.nextSeq(channelId);
      const canon = await d.store.canon(channelId, 50);
      const a = await d.author.author({
        channelId,
        seq,
        canon,
        firstHalfSec: d.timing.firstHalfMs / 1000,
        secondHalfSec: d.timing.secondHalfMs / 1000,
        nOutcomes: d.nOutcomes,
      });
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
        costUsd: null,
        renderAttempts: 0,
        error: null,
      });
      d.log("authored", { channelId, seq, title: a.title, outcomes: a.outcomes });
    }
    while (ev.state === "RENDER") {
      try {
        const r = await d.render.render(ev);
        ev = await d.store.update(ev.id, {
          firstHalfUrl: r.firstHalfUrl,
          branchUrls: r.branchUrls,
          costUsd: (ev.costUsd ?? 0) + r.costUsd,
          state: "READY",
          error: null,
        });
      } catch (e) {
        if (e instanceof SpendCapError) {
          // Not a render failure: leave the row in RENDER so it resumes once the cap is raised.
          d.log("spend cap reached; production paused", { channelId, seq: ev.seq, error: String(e) });
          return null;
        }
        ev = await d.store.update(ev.id, { renderAttempts: ev.renderAttempts + 1, error: String(e) });
        if (ev.renderAttempts >= d.timing.maxRenderAttempts) {
          ev = await d.store.update(ev.id, { state: "SKIPPED" });
          d.log("render failed, event skipped", { channelId, seq: ev.seq, error: ev.error });
          return null;
        }
        await d.sleep(d.timing.renderRetryMs);
      }
    }
    return ev;
  } catch (e) {
    d.log("produce failed", { channelId, error: String(e) });
    return null;
  }
}

async function step(ev: EventRow, d: Deps, onBetting: () => Promise<void>): Promise<EventRow> {
  const sleepUntil = (msEpoch: number) => d.sleep(Math.max(0, msEpoch - d.now()));
  switch (ev.state) {
    case "READY": {
      const on = await d.chain.getEvent(ev.id);
      let lock: bigint, round: bigint, tx: Hex | null = null, startTime: Date;
      if (on.exists) {
        // Event ids are keccak(channel:seq), so a database reset against a live Arena hands this
        // row an on-chain twin from an older run whose lock has long passed. Adopting it would put
        // the event on air with a zero-second betting window; skip it and let the channel move on.
        if (Number(on.lockTime) * 1000 <= d.now()) {
          const error = "stale on-chain event (database reset against a live Arena?)";
          d.log(error, { channelId: ev.channelId, seq: ev.seq, id: ev.id, lockTime: Number(on.lockTime) });
          return d.store.update(ev.id, { state: "SKIPPED", error });
        }
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
      await onBetting();
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
      // Sealed branches are ciphertext until a key is released; publish the winner's plaintext now
      // or the reveal plays a dead file.
      if (branchUrls && d.revealWinner) {
        try {
          const url = await d.revealWinner(ev, outcome);
          if (url) branchUrls = branchUrls.map((u, i) => (i === outcome ? url : u));
        } catch (e) {
          d.log("winning branch stayed sealed", { seq: ev.seq, outcome, error: String(e) });
        }
      }
      return d.store.update(ev.id, {
        state: "REVEAL",
        outcome,
        signature,
        resolveTx: tx,
        revealTime: new Date(d.now()),
        ...(branchUrls ? { branchUrls } : {}), // never null out URLs another path already stored
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
      if (d.pruneMedia) {
        // Disk is not worth a stalled channel: a failed sweep is logged and the event still finishes.
        try {
          const swept = await d.pruneMedia(ev.channelId);
          if (swept) d.log("pruned media", { channelId: ev.channelId, events: swept });
        } catch (e) {
          d.log("media prune failed", { channelId: ev.channelId, error: String(e).slice(0, 300) });
        }
      }
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
