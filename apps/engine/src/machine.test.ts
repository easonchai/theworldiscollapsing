import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { outcomeFor, PERIOD, SUSPENSE_GAP } from "./drand.js";
import {
  DEMO,
  REAL,
  RenderFetchError,
  eventIdFor,
  runChannel,
  type Chain,
  type Deps,
  type EventRow,
  type Store,
  type Timing,
} from "./machine.js";
import { stubAuthor } from "./stubs.js";

const SIG =
  "0x1a909b075202e693fc0e3bd141bbb24fce116a6ffb4343674417b89de6c658492379ad0c3a0c34a4ac46b9130948e781e527430db6240fef8253931abbb7f768" as const;

// Virtual clock: sleeping advances time instantly, so a full lifecycle runs in microseconds.
function fakeClock(start = 1_788_912_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      await new Promise((r) => setImmediate(r));
    },
  };
}

type FakeStore = Store & { rows: Map<Hex, EventRow>; canonLog: string[]; hook: (row: EventRow) => void };

function fakeStore(): FakeStore {
  const rows = new Map<Hex, EventRow>();
  const seqs = new Map<string, number>();
  const canonLog: string[] = [];
  const canonEvents = new Set<Hex>();
  const store: FakeStore = {
    rows,
    canonLog,
    hook: () => {},
    async openEvents(c) {
      return [...rows.values()]
        .filter((r) => r.channelId === c && r.state !== "DONE" && r.state !== "SKIPPED")
        .sort((a, b) => a.seq - b.seq);
    },
    async nextSeq(c) {
      const n = (seqs.get(c) ?? 0) + 1;
      seqs.set(c, n);
      return n;
    },
    async insert(row) {
      rows.set(row.id, { ...row });
      return { ...row };
    },
    async get(id) {
      const row = rows.get(id);
      return row ? { ...row } : null;
    },
    async update(id, patch) {
      const row = { ...rows.get(id)!, ...patch };
      rows.set(id, row);
      store.hook(row);
      return { ...row };
    },
    async canon() {
      return canonLog;
    },
    // Mirrors store.ts: canon rows are keyed by event, so a re-run of the CANON step is a no-op.
    async appendCanon(_c, eventId, lines) {
      if (!lines.length || canonEvents.has(eventId)) return;
      canonEvents.add(eventId);
      canonLog.push(...lines);
    },
    async lastSeenAt() {
      return null;
    },
  };
  return store;
}

function fakeChain(clock: { now(): number }) {
  const created = new Map<Hex, { n: number; lock: bigint; round: bigint; sig?: Hex; resolvedAt?: number }>();
  const calls: string[] = [];
  const chain: Chain = {
    async getEvent(id) {
      const e = created.get(id);
      if (!e) return { exists: false };
      return {
        exists: true,
        lockTime: e.lock,
        round: e.round,
        resolved: !!e.sig,
        outcome: e.sig ? outcomeFor(e.sig, id, e.n) : 0,
        signature: e.sig ?? "0x",
      };
    },
    async createEvent(id, n, lock, round) {
      if (created.has(id)) throw new Error("EventExists");
      if (Number(lock) * 1000 <= clock.now()) throw new Error("BadLockTime");
      created.set(id, { n, lock, round });
      calls.push(`create:${id.slice(0, 6)}`);
      return { tx: "0xc0ffee", startTime: new Date(clock.now()) };
    },
    async resolve(id, sig) {
      const e = created.get(id)!;
      if (e.sig) throw new Error("AlreadyResolved");
      if (Number(e.lock) * 1000 > clock.now()) throw new Error("BettingOpen");
      e.sig = sig;
      e.resolvedAt = clock.now();
      calls.push(`resolve:${id.slice(0, 6)}`);
      return { tx: "0xdead" };
    },
  };
  return { chain, calls, created };
}

const T: Timing = { ...DEMO, txBufferMs: 100, firstHalfMs: 2_000, secondHalfMs: 1_000, pauseMs: 500, idlePollMs: 50, renderRetryMs: 10 };

/** One engine "process": aborts synchronously the moment `until(store)` holds. */
function harness(over: Partial<Deps> & { fc?: ReturnType<typeof fakeChain> } = {}) {
  const clock = fakeClock();
  const fc = over.fc ?? fakeChain(clock);
  const store = (over.store as FakeStore | undefined) ?? fakeStore();
  const ac = new AbortController();
  let until: (s: FakeStore) => boolean = () => false;
  store.hook = () => {
    if (until(store)) ac.abort();
  };
  const d: Deps = {
    store,
    chain: fc.chain,
    drand: { fetchRound: async (round) => ({ round, signature: SIG }) },
    author: stubAuthor,
    render: {
      render: async (ev) => ({
        firstHalfUrl: `first:${ev.seq}`,
        branchUrls: ev.outcomes.map((_, i) => `branch:${ev.seq}:${i}`),
        costUsd: 3,
      }),
    },
    timing: T,
    nOutcomes: 3,
    provenance: "reactor:real",
    ...clock,
    log: () => {},
    alwaysOn: true,
    ...over,
  };
  const run = async (cond: (s: FakeStore) => boolean) => {
    until = cond;
    await runChannel("sports", d, ac.signal);
    return store;
  };
  return { d, store, fc, clock, ac, run };
}

const rows = (s: FakeStore) => [...s.rows.values()].sort((a, b) => a.seq - b.seq);
const doneCount = (s: FakeStore) => rows(s).filter((r) => r.state === "DONE").length;

/**
 * Drops an open (unfinished) event straight into the store, as a previous engine run would have left
 * it, bypassing produce()/nextSeq so its provenance can be set independently of the running engine's.
 * seq 42 (ticket 21's real example) keeps it clear of the seq-1-onward events runChannel authors itself.
 */
async function seedEvent(
  store: FakeStore,
  seq: number,
  provenance: string | null,
  state: EventRow["state"] = "RENDER",
): Promise<EventRow> {
  const a = await stubAuthor.author({ channelId: "sports", seq, canon: [], firstHalfSec: 2, secondHalfSec: 1, nOutcomes: 3 });
  const row: EventRow = {
    id: eventIdFor("sports", seq),
    channelId: "sports",
    seq,
    state,
    title: a.title,
    premise: a.premise,
    outcomes: a.outcomes,
    script: a,
    provenance,
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
  };
  store.rows.set(row.id, row);
  return row;
}

describe("channel lifecycle", () => {
  it("runs create → resolve in order, after lock, and reaches DONE with canon applied", async () => {
    const h = harness();
    const store = await h.run((s) => doneCount(s) >= 1);
    const ev = rows(store)[0];
    expect(h.fc.calls).toEqual([`create:${ev.id.slice(0, 6)}`, `resolve:${ev.id.slice(0, 6)}`]);
    const on = h.fc.created.get(ev.id)!;
    expect(on.resolvedAt!).toBeGreaterThanOrEqual(Number(on.lock) * 1000);
    expect(ev.outcome).toBe(outcomeFor(SIG, ev.id, 3));
    expect(ev.signature).toBe(SIG);
    expect(ev.firstHalfUrl).toBe("first:1");
    expect(ev.branchUrls).toEqual(["branch:1:0", "branch:1:1", "branch:1:2"]);
    expect(ev.costUsd).toBe(3); // first half + branches
    expect(ev.revealTime).not.toBeNull();
    expect(store.canonLog).toEqual(ev.script.canonUpdates[ev.outcome!]);
  });

  it("produces the next event while the current one is live", async () => {
    const store = await harness().run((s) => doneCount(s) >= 2);
    const [a, b] = rows(store);
    expect(a.state).toBe("DONE");
    expect(b.state).toBe("DONE");
    expect(b.seq).toBe(2);
  });

  it("restart mid-BETTING does not create a second on-chain event", async () => {
    const h1 = harness();
    await h1.run((s) => rows(s).some((r) => r.state === "BETTING"));
    expect(h1.fc.calls).toEqual([`create:${rows(h1.store)[0].id.slice(0, 6)}`]);

    // new process, same DB and chain
    const h2 = harness({ store: h1.store, fc: h1.fc, ...h1.clock });
    const store = await h2.run((s) => doneCount(s) >= 1);
    expect(rows(store)[0].state).toBe("DONE");
    expect(h1.fc.calls.filter((c) => c.startsWith("create:")).length).toBe(1);
    expect(h1.fc.calls.filter((c) => c.startsWith("resolve:")).length).toBe(1);
  });

  it("a crash after the resolve tx retries the step and reads the outcome from chain", async () => {
    const h = harness();
    const origUpdate = h.store.update;
    let crashed = false;
    h.store.update = async (id, patch) => {
      if (patch.state === "REVEAL" && !crashed) {
        crashed = true;
        throw new Error("db blip");
      }
      return origUpdate(id, patch);
    };
    const store = await h.run((s) => doneCount(s) >= 1);
    const ev = rows(store)[0];
    expect(crashed).toBe(true);
    expect(ev.signature).toBe(SIG);
    expect(ev.outcome).toBe(outcomeFor(SIG, ev.id, 3));
    expect(h.fc.calls.filter((c) => c.startsWith("resolve:")).length).toBe(1);
  });

  it("appends canon once when the CANON step re-runs after a crash", async () => {
    const h = harness();
    const origUpdate = h.store.update;
    let crashed = false;
    h.store.update = async (id, patch) => {
      // crash after appendCanon, before the state write: the step retries from CANON
      if (patch.state === "PAUSE" && !crashed) {
        crashed = true;
        throw new Error("db blip");
      }
      return origUpdate(id, patch);
    };
    const store = await h.run((s) => doneCount(s) >= 1);
    const ev = rows(store)[0];
    expect(crashed).toBe(true);
    expect(store.canonLog).toEqual(ev.script.canonUpdates[ev.outcome!]);
  });

  it("skips an event whose on-chain twin already locked instead of airing a zero-second window", async () => {
    const h = harness();
    // A database reset against a live Arena replays seq 1, whose id is already created on chain.
    h.fc.created.set(eventIdFor("sports", 1), {
      n: 3,
      lock: BigInt(Math.floor(h.clock.now() / 1000)) - 60n,
      round: 1n,
    });
    const store = await h.run((s) => doneCount(s) >= 1);
    const [stale, fresh] = rows(store);
    expect(stale.state).toBe("SKIPPED");
    expect(stale.error).toBe("stale on-chain event (database reset against a live Arena?)");
    expect(h.fc.calls).toEqual([`create:${fresh.id.slice(0, 6)}`, `resolve:${fresh.id.slice(0, 6)}`]);
    expect(fresh.seq).toBe(2);
    expect(fresh.state).toBe("DONE");
  });

  it("skips an event after bounded render failures and moves on", async () => {
    let attempts = 0;
    const h = harness({
      render: {
        render: async (ev) => {
          if (ev.seq === 1) {
            attempts++;
            throw new Error("boom");
          }
          return { firstHalfUrl: `first:${ev.seq}`, branchUrls: ev.outcomes.map(() => "b"), costUsd: 3 };
        },
      },
    });
    const store = await h.run((s) => doneCount(s) >= 1);
    const [a, b] = rows(store);
    expect(attempts).toBe(T.maxRenderAttempts);
    expect(a.state).toBe("SKIPPED");
    expect(a.renderAttempts).toBe(3);
    expect(b.state).toBe("DONE");
  });

  it("skips an event on a fetch failure without retrying or opening a second paid session", async () => {
    // Ticket 24: the build was fully paid for and only the download failed, so re-rendering would
    // pay for the build a second time. Unlike a plain render failure, this must not touch
    // renderAttempts or retry, just skip straight away.
    const callsBySeq = new Map<number, number>();
    const h = harness({
      render: {
        render: async (ev) => {
          callsBySeq.set(ev.seq, (callsBySeq.get(ev.seq) ?? 0) + 1);
          if (ev.seq === 1) throw new RenderFetchError("sidecar error at stage fetch: connection reset", 147);
          return { firstHalfUrl: `first:${ev.seq}`, branchUrls: ev.outcomes.map(() => "b"), costUsd: 3 };
        },
      },
    });
    const store = await h.run((s) => doneCount(s) >= 1);
    const [a, b] = rows(store);
    expect(a.state).toBe("SKIPPED");
    expect(a.renderAttempts).toBe(0); // never treated as a build failure worth retrying
    expect(a.error).toMatch(/fetch/);
    expect(callsBySeq.get(1)).toBe(1); // exactly one render call, no retry
    expect(b.state).toBe("DONE");
  });

  it("backs off exponentially while every production fails", async () => {
    const h = harness({
      render: { render: async () => { throw new Error("vendor down"); } },
    });
    const t0 = h.clock.now();
    await h.run((s) => rows(s).filter((r) => r.state === "SKIPPED").length >= 5);
    // 5 skips → 4 backoffs of idlePoll * 2^1..2^4 = 30 * idlePoll, plus render retries
    expect(h.clock.now() - t0).toBeGreaterThanOrEqual(30 * T.idlePollMs);
  });

  it("an event reaches READY only with every branch stored", async () => {
    // The render resolves only once both URL sets are ready, so nothing partial is ever persisted.
    const h = harness({
      render: {
        render: async (ev) => {
          await new Promise((r) => setImmediate(r));
          await new Promise((r) => setImmediate(r));
          return {
            firstHalfUrl: `first:${ev.seq}`,
            branchUrls: ev.outcomes.map((_, i) => `branch:${ev.seq}:${i}`),
            costUsd: 3,
          };
        },
      },
    });
    const readyOrLater = new Set<EventRow["state"]>(["READY", "BETTING", "LOCKED", "RESOLVE", "REVEAL", "CANON", "PAUSE", "DONE"]);
    const violations: EventRow[] = [];
    const origHook = h.store.hook;
    h.store.hook = (row) => {
      if (readyOrLater.has(row.state) && row.branchUrls === null) violations.push(row);
      origHook(row);
    };
    await h.run((s) => doneCount(s) >= 1);
    expect(violations).toEqual([]);
  });

  it("REAL pause covers production as measured, not as estimated", () => {
    // This used to assert against the estimate formula (9 s first build + halves + 3 s teardown),
    // which said 132 s. Three consecutive REAL events on sports on 2026-09-12 took 217 s, 219 s and
    // 221 s from betting open to stored media, so the formula was ~85 s optimistic and the pause it
    // blessed left the wall dark for ~146 s an event (ticket 28). The measurement is the assertion
    // now; if the pause is ever lowered again, this fails and says why.
    const MEASURED_PRODUCTION_MS = 221_000;
    // drand publishes SUSPENSE_GAP seconds past lock, so the wait between lock and reveal is that
    // gap rounded up to the next beacon, plus the resolve transaction.
    const drandSuspenseMs = Number(SUSPENSE_GAP + PERIOD) * 1_000;
    const cycleMs = REAL.txBufferMs + REAL.firstHalfMs + drandSuspenseMs + REAL.secondHalfMs + REAL.pauseMs;
    expect(cycleMs).toBeGreaterThanOrEqual(MEASURED_PRODUCTION_MS);
  });

  it("stays idle without viewers when not always-on", async () => {
    const h = harness({ alwaysOn: false });
    const p = h.run(() => false);
    await new Promise((r) => setTimeout(r, 20));
    h.ac.abort();
    await p;
    expect(h.store.rows.size).toBe(0);
  });

  it("stops after the current event when the last viewer leaves mid-cycle", async () => {
    const h = harness({ alwaysOn: false });
    // Present at cold start, gone by the time the first event is on air.
    h.store.lastSeenAt = async () => (h.fc.calls.length ? new Date(0) : new Date(h.clock.now()));
    const p = h.run(() => false);
    await new Promise((r) => setTimeout(r, 50));
    h.ac.abort();
    await p;
    expect(h.fc.calls.filter((c) => c.startsWith("create:"))).toHaveLength(1);
    expect(rows(h.store).map((r) => r.state)).toEqual(["DONE"]);
  });

  it("sweeps old published media once an event is off the wall, and finishes even if the sweep fails", async () => {
    const swept: string[] = [];
    const h = harness({ pruneMedia: async (channelId) => (swept.push(channelId), 1) });
    await h.run((s) => doneCount(s) >= 2);
    expect(swept).toEqual(["sports", "sports"]); // one sweep per event reaching DONE

    const broken = harness({ pruneMedia: async () => { throw new Error("EACCES"); } });
    const store = await broken.run((s) => doneCount(s) >= 1);
    expect(rows(store)[0].state).toBe("DONE");
  });

  it("publishes the plaintext of the winning branch at reveal when sealing is on", async () => {
    const seen: Array<[number, string]> = [];
    const h = harness({
      render: {
        render: async (ev) => ({
          firstHalfUrl: `first:${ev.seq}`,
          branchUrls: ev.outcomes.map((_, i) => `branch:${ev.seq}:${i}.enc`),
          costUsd: 3,
        }),
      },
      revealWinner: async (ev, outcome) => {
        seen.push([outcome, ev.id]);
        return `branch:${ev.seq}:${outcome}`;
      },
    });
    const store = await h.run((s) => doneCount(s) >= 1);
    const ev = rows(store)[0];
    expect(seen).toEqual([[ev.outcome!, ev.id]]);
    expect(ev.branchUrls![ev.outcome!]).toBe(`branch:1:${ev.outcome}`);
    expect(ev.branchUrls!.filter((u) => u.endsWith(".enc"))).toHaveLength(ev.outcomes.length - 1);
  });

  // Ticket 21 (2026-09-12): a paid Reactor engine resumed and rendered an event a free fake-sidecar
  // soak had authored, opening a real billed session over a canned script.
  it("skips an event authored under a different provenance instead of paying to render it", async () => {
    let rendered = false;
    const h = harness({
      provenance: "reactor:real",
      render: {
        render: async (ev) => {
          rendered = true;
          return { firstHalfUrl: `first:${ev.seq}`, branchUrls: [], costUsd: 3 };
        },
      },
    });
    await seedEvent(h.store, 42, "fake:demo");
    const store = await h.run((s) => rows(s).some((r) => r.state === "SKIPPED"));
    const ev = rows(store).find((r) => r.seq === 42)!;
    expect(ev.state).toBe("SKIPPED");
    expect(ev.error).toMatch(/provenance mismatch/);
    expect(rendered).toBe(false);
  });

  it("resumes and renders an event whose provenance matches the running engine", async () => {
    const renderedSeqs: number[] = [];
    const h = harness({
      provenance: "reactor:real",
      render: {
        render: async (ev) => {
          renderedSeqs.push(ev.seq);
          return { firstHalfUrl: `first:${ev.seq}`, branchUrls: ev.outcomes.map(() => "b"), costUsd: 3 };
        },
      },
    });
    await seedEvent(h.store, 42, "reactor:real");
    const store = await h.run((s) => rows(s).some((r) => r.seq === 42 && r.state === "DONE"));
    const ev = rows(store).find((r) => r.seq === 42)!;
    expect(ev.state).toBe("DONE");
    expect(renderedSeqs).toContain(42);
  });

  it("treats a pre-provenance row (null, unknown) as a mismatch and skips it", async () => {
    const h = harness({ provenance: "reactor:real" });
    await seedEvent(h.store, 42, null);
    const store = await h.run((s) => rows(s).some((r) => r.state === "SKIPPED"));
    const ev = rows(store).find((r) => r.seq === 42)!;
    expect(ev.state).toBe("SKIPPED");
    expect(ev.error).toMatch(/provenance mismatch/);
  });
});
