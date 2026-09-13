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
  /**
   * vendor:timing that authored this event, e.g. "reactor:real", "fake:demo". Null predates the
   * column (ticket 21, 2026-09-12) and is genuinely unknown. Checked on resume in runChannel so a
   * paid engine never renders what a different vendor or timing mode wrote. Optional (rather than
   * required) only so fixtures in other files that don't exercise provenance need not set it; every
   * row the store or produce() actually hands back always carries it, as string or null.
   */
  provenance?: string | null;
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
  /** Only lines from events this engine's own provenance authored: a fake run's world is not ours. */
  canon(channelId: string, limit: number, provenance: string): Promise<string[]>;
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

/**
 * Thrown by a `Render` when re-rendering cannot help: the video was fully built and paid for, and
 * only retrieving the recording failed. Ticket 24 (2026-09-12): a reset TCP connection killed a
 * download after the build had billed $1.032 in full; the engine's only recovery was re-rendering
 * the whole event in a new paid session, which then hit the spend cap and aired nothing. produce()
 * must skip on this error instead of retrying it like a build failure.
 */
export class RenderFetchError extends Error {
  constructor(
    message: string,
    /** Seconds Reactor actually billed, from the sidecar's `disconnected` line. The true-up on
     * this path charges real money already spent; it must not be refunded like a build failure. */
    public readonly billedS: number,
  ) {
    super(message);
    this.name = "RenderFetchError";
  }
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
  // Long enough that one channel can produce the next event without the wall going dark (ticket 28).
  //
  // 60_000 came from an estimate of a ~135 s render cycle. Three consecutive REAL events on sports
  // on 2026-09-12 measured the real thing: production, from the moment an event opened for betting
  // to the moment the next one was stored, ran 217 s to 221 s. The cycle it has to fit inside is
  // txBuffer + firstHalf + drand suspense + secondHalf + pause, which was ~148 s, so every cycle
  // fell ~73 s short and the wall went dark for 145 s to 147 s between events.
  //
  // 150_000 makes that cycle ~238 s, which covers the worst of the three with 17 s to spare. The
  // cost is stated rather than hidden: each event now occupies ~238 s instead of ~148 s, so a
  // channel airs fewer events an hour. That is the trade ticket 28 describes, taken deliberately
  // because a lit wall matters more to the demo than event count.
  //
  // What this does NOT cover is four channels at once, where the same day measured production at
  // 210 s to 400 s. That spread is download contention, not build time (the build held at 0.97x to
  // 1.08x at every concurrency level), so a longer pause is the wrong instrument for it.
  //
  // 165_000: the first half is now authored at txBuffer + firstHalf = 45 s (see produce), which is
  // 15 s more footage to build at ~1x, so the pause grows by the same 15 s to keep the margin.
  pauseMs: 165_000,
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
  /**
   * vendor:timing this running engine authors under, e.g. "reactor:real", "fake:demo" (ticket 21,
   * 2026-09-12). Stamped on every event this engine inserts and checked against events found by
   * openEvents on resume, so a real paid engine can never pick up and render what a free fake
   * sidecar or a different timing mode wrote.
   */
  provenance: string;
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
// $0.10, not the $1 this held until 2026-09-12: gpt-5-mini authored a four-channel event for
// $0.007, so $1 reserved 143x the real cost. On four channels that is $4 of headroom no event
// ever spends, and it refused a REAL round the budget could comfortably afford. $0.10 still
// leaves an order of magnitude over anything measured.
const AUTHOR_ESTIMATE_USD = 0.1;

export const eventIdFor = (channelId: string, seq: number): Hex => keccak256(toHex(`${channelId}:${seq}`));

const LIVE = new Set<State>(["BETTING", "LOCKED", "RESOLVE", "REVEAL", "CANON", "PAUSE"]);

export async function runChannel(channelId: string, d: Deps, signal: AbortSignal): Promise<void> {
  const found = await d.store.openEvents(channelId);
  // Ticket 21 (2026-09-12): a paid Reactor engine resumed and opened a real billed session over an
  // event a free fake-sidecar soak had authored. RENDER/READY events are not on chain yet, so no
  // bettor money is at stake; a provenance mismatch there (including unknown/null, from before this
  // column existed) is skipped rather than rendered. BETTING or later already has real money (and
  // maybe a tx) committed on chain, so those resume regardless of provenance — pulling one now would
  // strand bettors, and the harm this ticket cares about is specifically paying to render a foreign
  // script, not finishing an event that already went live.
  const open: EventRow[] = [];
  for (const ev of found) {
    if (!LIVE.has(ev.state) && ev.provenance !== d.provenance) {
      d.log("skipping event authored under a different provenance", {
        channelId,
        seq: ev.seq,
        eventProvenance: ev.provenance ?? "unknown",
        engineProvenance: d.provenance,
      });
      await d.store.update(ev.id, {
        state: "SKIPPED",
        error: `provenance mismatch: event=${ev.provenance ?? "unknown"} engine=${d.provenance}`,
      });
      continue;
    }
    open.push(ev);
  }
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
      const canon = await d.store.canon(channelId, 50, d.provenance);
      const a = await d.author.author({
        channelId,
        seq,
        canon,
        // The betting window is txBuffer + firstHalf (see `lock` below) and the picture starts
        // when createEvent lands, so a firstHalf-long video froze on its last frame for the
        // buffer's worth of seconds before the lock. The first half is authored to fill the window.
        firstHalfSec: (d.timing.txBufferMs + d.timing.firstHalfMs) / 1000,
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
        provenance: d.provenance,
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
        if (e instanceof RenderFetchError) {
          // The clips all built and were fully paid for; only downloading the recording failed.
          // Re-rendering would pay for the build a second time (ticket 24: that hit the spend cap
          // and politics aired nothing on 2026-09-12), and a new session cannot make the old
          // recording download any better. Skip rather than leaving the row in RENDER, which would
          // just pay for the build again on the next resume.
          ev = await d.store.update(ev.id, { state: "SKIPPED", error: String(e) });
          d.log("build succeeded but the fetch failed; skipping instead of opening a second paid session", {
            channelId,
            seq: ev.seq,
            error: String(e),
          });
          return null;
        }
        ev = await d.store.update(ev.id, { renderAttempts: ev.renderAttempts + 1, error: String(e) });
        // Every attempt gets a line: a paid session that fails costs money whether or not the
        // retries go on to succeed, and until 2026-09-12 only the final failure was logged, so a
        // cap that paused the retry hid the reason in the database.
        d.log("render attempt failed", { channelId, seq: ev.seq, attempt: ev.renderAttempts, error: String(e) });
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
