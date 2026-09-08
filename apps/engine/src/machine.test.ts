import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { outcomeFor } from "./drand.js";
import { DEMO, runChannel, type Chain, type Deps, type EventRow, type Store, type Timing } from "./machine.js";
import { stubAuthor } from "./stubs.js";

const SIG =
  "0x86da6c35d9cad6916a54c9a0679f031bc5dd6ec3515a5d4eaa512077fd9fb97164c1838a9ad6ac70a00f36f016c86977" as const;

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
    async update(id, patch) {
      const row = { ...rows.get(id)!, ...patch };
      rows.set(id, row);
      store.hook(row);
      return { ...row };
    },
    async canon() {
      return canonLog;
    },
    async appendCanon(_c, _e, lines) {
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
    render: { firstHalf: async (ev) => `first:${ev.seq}`, branches: async (ev) => ev.outcomes.map((_, i) => `branch:${ev.seq}:${i}`) },
    timing: T,
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

  it("skips an event after bounded render failures and moves on", async () => {
    let attempts = 0;
    const h = harness({
      render: {
        firstHalf: async (ev) => {
          if (ev.seq === 1) {
            attempts++;
            throw new Error("boom");
          }
          return `first:${ev.seq}`;
        },
        branches: async (ev) => ev.outcomes.map(() => "b"),
      },
    });
    const store = await h.run((s) => doneCount(s) >= 1);
    const [a, b] = rows(store);
    expect(attempts).toBe(T.maxRenderAttempts);
    expect(a.state).toBe("SKIPPED");
    expect(a.renderAttempts).toBe(3);
    expect(b.state).toBe("DONE");
  });

  it("backs off exponentially while every production fails", async () => {
    const h = harness({ render: { firstHalf: async () => { throw new Error("vendor down"); }, branches: async () => [] } });
    const t0 = h.clock.now();
    await h.run((s) => rows(s).filter((r) => r.state === "SKIPPED").length >= 5);
    // 5 skips → 4 backoffs of idlePoll * 2^1..2^4 = 30 * idlePoll, plus render retries
    expect(h.clock.now() - t0).toBeGreaterThanOrEqual(30 * T.idlePollMs);
  });

  it("still resolves and reveals when branch rendering fails", async () => {
    const h = harness({
      render: { firstHalf: async (ev) => `first:${ev.seq}`, branches: async () => { throw new Error("vendor down"); } },
    });
    const store = await h.run((s) => doneCount(s) >= 1);
    const ev = rows(store)[0];
    expect(ev.state).toBe("DONE");
    expect(ev.branchUrls).toBeNull();
    expect(h.fc.calls.filter((c) => c.startsWith("resolve:")).length).toBe(1);
  });

  it("stays idle without viewers when not always-on", async () => {
    const h = harness({ alwaysOn: false });
    const p = h.run(() => false);
    await new Promise((r) => setTimeout(r, 20));
    h.ac.abort();
    await p;
    expect(h.store.rows.size).toBe(0);
  });
});
