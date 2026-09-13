import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Authored } from "./authored.js";
import { makeBudget, SpendCapError, type Budget } from "./budget.js";
import { RenderFetchError, type EventRow } from "./machine.js";
import type { MediaStore } from "./media.js";
import { makeReactorRender, SidecarError } from "./reactor.js";

// Canned-line Node scripts stand in for the Python sidecar, per the spec: the protocol client is
// unit-tested against small scripts that print fixed protocol lines, no Python in vitest.

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "twic-reactor-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Every canned script waits for both `start` and `plan` on stdin before reacting, like the real one. */
const AFTER_TWO_LINES = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let n = 0;
rl.on("line", () => {
  n++;
  if (n === 2) {
`;

async function writeScript(name: string, body: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, `${AFTER_TWO_LINES}${body}\n  }\n});\n`);
  return file;
}

/** Same, but first copies the `plan` line to `planFile`, so a test can assert what was enqueued. */
async function writePlanCapturingScript(name: string, planFile: string, body: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(
    file,
    `const readline = require("node:readline");
const fs = require("node:fs");
const rl = readline.createInterface({ input: process.stdin });
let n = 0;
rl.on("line", (line) => {
  n++;
  if (n === 2) {
    fs.writeFileSync(${JSON.stringify(planFile)}, line);
${body}
  }
});
`,
  );
  return file;
}

function recordingBudget(): Budget & { charges: { usd: number; what: string }[] } {
  const charges: { usd: number; what: string }[] = [];
  let spent = 0;
  return {
    capUsd: Number.POSITIVE_INFINITY,
    spent: () => spent,
    assertAffordable() {},
    async charge(usd, what) {
      spent += usd;
      charges.push({ usd, what });
    },
    charges,
  };
}

function recordingStore(): MediaStore & { stored: { eventId: string; name: string; localPath: string }[] } {
  const stored: { eventId: string; name: string; localPath: string }[] = [];
  return {
    stored,
    async storeFile(eventId, name, localPath) {
      stored.push({ eventId, name, localPath });
      return `https://fake.media/${eventId}/${name}`;
    },
  };
}

function recordingFfmpeg(): { calls: string[][]; run: (args: string[]) => Promise<void> } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args) => {
      calls.push(args);
    },
  };
}

const script: Authored = {
  title: "Test event",
  premise: "A premise.",
  outcomes: ["A", "B"],
  firstHalf: [
    { prompt: "shot one", seconds: 5 },
    { prompt: "shot two", seconds: 5 },
  ],
  branches: [
    [{ prompt: "branch A", seconds: 5 }],
    [{ prompt: "branch B", seconds: 5 }],
  ],
  cards: [{ afterShot: 0, title: "Card", stats: ["a", "b"] }],
  ticker: ["ticker"],
  canonUpdates: [["A won"], ["B won"]],
  score: null,
  reasoning: "test",
};

const ev: EventRow = {
  id: "0xreactortest",
  channelId: "sports",
  seq: 1,
  state: "RENDER",
  title: script.title,
  premise: script.premise,
  outcomes: script.outcomes,
  script,
  reasoning: script.reasoning ?? null,
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
} as EventRow;

// firstHalfSec=10, secondHalfSec=5+5=10 -> estimateSec=9+10+10+3=32, so estimateUsd is 0.224.
// The estimate is still what assertAffordable gates on; it is no longer what gets charged.
// Ticket 20: the reservation is the worst case the deadline permits, not the estimate. With an
// unbounded cap the deadline is untouched, so the reservation is the default formula's own worst
// case: 2 x 32 + 120 = 184s at $0.007/s.
const RESERVED_USD = (2 * 32 + 120) * 0.007;

describe("makeReactorRender", () => {
  it("a clean run: cuts each segment from the recording and stores every file", async () => {
    const sidecar = await writeScript(
      "clean.cjs",
      `    console.log(JSON.stringify({ event: "ready" }));
    console.log(JSON.stringify({ event: "segment", name: "first", start_t: 0, end_t: 10 }));
    console.log(JSON.stringify({ event: "segment", name: "branch-0", start_t: 10, end_t: 15 }));
    console.log(JSON.stringify({ event: "segment", name: "branch-1", start_t: 15, end_t: 20 }));
    console.log(JSON.stringify({ event: "done", recording: "/fake/session.mp4", billed_s: 20.5, fetch_s: 3.2 }));
    process.exit(0);`,
    );
    const budget = recordingBudget();
    const store = recordingStore();
    const ffmpeg = recordingFfmpeg();
    const render = makeReactorRender({
      python: process.execPath,
      sidecar,
      sessions: 1,
      workDir: path.join(dir, "work-clean"),
      store,
      budget,
      ffmpeg: ffmpeg.run,
      log: () => {},
    });

    const r = await render.render(ev);

    expect(r.firstHalfUrl).toBe("https://fake.media/0xreactortest/first.mp4");
    expect(r.branchUrls).toHaveLength(2);
    expect(r.costUsd).toBeCloseTo(20.5 * 0.007, 6);

    // three cuts: first, branch-0, branch-1, each stream-copied with -an and the right offsets
    expect(ffmpeg.calls).toHaveLength(3);
    expect(ffmpeg.calls[0]).toEqual(
      expect.arrayContaining(["-ss", "0", "-to", "10", "-i", "/fake/session.mp4", "-an", "-c", "copy"]),
    );
    expect(ffmpeg.calls[1]).toEqual(expect.arrayContaining(["-ss", "10", "-to", "15"]));
    expect(ffmpeg.calls[2]).toEqual(expect.arrayContaining(["-ss", "15", "-to", "20"]));
    expect(ffmpeg.calls[0]![ffmpeg.calls[0]!.length - 1]).toMatch(/first\.mp4$/);

    expect(store.stored.map((s) => s.name)).toEqual(["first.mp4", expect.stringMatching(/^branch-0-/), expect.stringMatching(/^branch-1-/)]);

    // reserves the worst case the (unbounded) deadline permits up front, then trues up to what
    // the sidecar actually billed, refunding the rest
    expect(budget.charges).toHaveLength(2);
    expect(budget.charges[0]).toEqual({ usd: RESERVED_USD, what: "reactor session reserve" });
    expect(budget.charges[1]!.usd).toBeCloseTo(20.5 * 0.007 - RESERVED_USD, 6);
  }, 20_000);

  it("bounds the watchdog by what the cap can still afford, so a hang cannot overrun it", async () => {
    // A stalled session rode its 234 s watchdog to $1.58 against a $1.35 cap on 2026-09-12: nothing
    // samples cost mid-session, so the deadline is the real ceiling. With a $0.35 cap the session
    // can afford 50 s in total, well under the 2 x 32 + 120 = 184 s the clock alone would allow.
    const sidecar = await writeScript(
      "budget-bounded.cjs",
      `    console.log(JSON.stringify({ event: "ready" }));
    console.log(JSON.stringify({ event: "segment", name: "first", start_t: 0, end_t: 10 }));
    console.log(JSON.stringify({ event: "segment", name: "branch-0", start_t: 10, end_t: 15 }));
    console.log(JSON.stringify({ event: "segment", name: "branch-1", start_t: 15, end_t: 20 }));
    console.log(JSON.stringify({ event: "done", recording: "/fake/session.mp4", billed_s: 20.5, fetch_s: 3.2 }));
    process.exit(0);`,
    );
    const budget = recordingBudget();
    Object.assign(budget, { capUsd: 0.35 });
    const logged: Array<Record<string, unknown>> = [];
    await makeReactorRender({
      python: process.execPath,
      sidecar,
      sessions: 1,
      workDir: path.join(dir, "work-budget-deadline"),
      store: recordingStore(),
      budget,
      ffmpeg: recordingFfmpeg().run,
      log: (m, extra) => void (m === "session deadline bounded by budget" && logged.push(extra ?? {})),
    }).render(ev);

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ wouldHaveBeenMs: 184_000 });
    // 0.35 / 0.007 is 49999.99... in binary, and the bound floors rather than rounds up so it can
    // never admit a millisecond the cap cannot pay for.
    expect(logged[0]!.deadlineMs as number).toBeCloseTo(50_000, -1);
    expect(logged[0]!.deadlineMs as number).toBeLessThanOrEqual(50_000);

    // Ticket 20: the reservation is that bounded deadline's own worst case, not the plain
    // estimate, so by construction it is never more than the cap.
    expect(budget.charges[0]!.what).toBe("reactor session reserve");
    expect(budget.charges[0]!.usd).toBeCloseTo(((logged[0]!.deadlineMs as number) / 1000) * 0.007, 6);
    expect(budget.charges[0]!.usd).toBeLessThanOrEqual(0.35);
  }, 20_000);

  it("leaves the watchdog alone when the cap affords more than the clock allows", async () => {
    const sidecar = await writeScript(
      "budget-roomy.cjs",
      `    console.log(JSON.stringify({ event: "ready" }));
    console.log(JSON.stringify({ event: "segment", name: "first", start_t: 0, end_t: 10 }));
    console.log(JSON.stringify({ event: "segment", name: "branch-0", start_t: 10, end_t: 15 }));
    console.log(JSON.stringify({ event: "segment", name: "branch-1", start_t: 15, end_t: 20 }));
    console.log(JSON.stringify({ event: "done", recording: "/fake/session.mp4", billed_s: 20.5, fetch_s: 3.2 }));
    process.exit(0);`,
    );
    const budget = recordingBudget(); // unbounded cap
    const logged: string[] = [];
    await makeReactorRender({
      python: process.execPath,
      sidecar,
      sessions: 1,
      workDir: path.join(dir, "work-budget-roomy"),
      store: recordingStore(),
      budget,
      ffmpeg: recordingFfmpeg().run,
      log: (m) => void logged.push(m),
    }).render(ev);

    expect(logged).not.toContain("session deadline bounded by budget");
    // Unbounded cap: the reservation is the plain worst case the untouched deadline permits.
    expect(budget.charges[0]).toEqual({ usd: RESERVED_USD, what: "reactor session reserve" });
  }, 20_000);

  it("refuses to start a render that would cross the spend cap, before any session is acquired", async () => {
    const cappedBudget: Budget = {
      capUsd: 0.01,
      spent: () => 0,
      assertAffordable(usd, what) {
        throw new SpendCapError(`spend cap: ${what} needs $${usd}`);
      },
      async charge() {},
    };
    const render = makeReactorRender({
      python: process.execPath,
      sidecar: path.join(dir, "unused.cjs"), // never spawned: assertAffordable throws first
      sessions: 1,
      workDir: path.join(dir, "work-capped"),
      store: recordingStore(),
      budget: cappedBudget,
      log: () => {},
    });
    await expect(render.render(ev)).rejects.toBeInstanceOf(SpendCapError);
  });

  it("a ready that never arrives: refunds the whole reservation (nothing was billed)", async () => {
    const sidecar = await writeScript(
      "no-ready.cjs",
      `    console.log(JSON.stringify({ event: "error", stage: "connect", reason: "ready not reached within 60s" }));
    process.exit(1);`,
    );
    const budget = recordingBudget();
    const render = makeReactorRender({
      python: process.execPath,
      sidecar,
      sessions: 1,
      workDir: path.join(dir, "work-no-ready"),
      store: recordingStore(),
      budget,
      log: () => {},
    });

    await expect(render.render(ev)).rejects.toThrow(/ready not reached/);
    expect(budget.charges).toHaveLength(2);
    expect(budget.charges[0]).toEqual({ usd: RESERVED_USD, what: "reactor session reserve" });
    expect(budget.charges[1]).toEqual({ usd: -RESERVED_USD, what: "reactor session true-up (error)" });
  }, 20_000);

  it("a clip fails mid-run: true-up uses the wall-clock/sidecar-reported billed_s at the error", async () => {
    const sidecar = await writeScript(
      "clip-failed.cjs",
      `    console.log(JSON.stringify({ event: "ready" }));
    console.log(JSON.stringify({ event: "segment", name: "first", start_t: 0, end_t: 10 }));
    console.log(JSON.stringify({ event: "error", stage: "clip", reason: "clip b0-0 failed", billed_s: 12.3 }));
    process.exit(1);`,
    );
    const budget = recordingBudget();
    const render = makeReactorRender({
      python: process.execPath,
      sidecar,
      sessions: 1,
      workDir: path.join(dir, "work-clip-failed"),
      store: recordingStore(),
      budget,
      log: () => {},
    });

    await expect(render.render(ev)).rejects.toThrow(/clip b0-0 failed/);
    expect(budget.charges).toHaveLength(2);
    expect(budget.charges[0]).toEqual({ usd: RESERVED_USD, what: "reactor session reserve" });
    expect(budget.charges[1]!.usd).toBeCloseTo(12.3 * 0.007 - RESERVED_USD, 6);
  }, 20_000);

  it("the deadline SIGTERMs a sidecar that never finishes and true-ups from time-since-ready", async () => {
    const sidecar = await writeScript(
      "hangs.cjs",
      `    console.log(JSON.stringify({ event: "ready" }));
    setInterval(() => {}, 1000); // keep the event loop alive; only the deadline's SIGTERM should end this`,
    );
    const budget = recordingBudget();
    const render = makeReactorRender({
      python: process.execPath,
      sidecar,
      sessions: 1,
      workDir: path.join(dir, "work-deadline"),
      store: recordingStore(),
      budget,
      deadlineMs: () => 1500, // short but enough for the child to spawn and reach ready reliably
      log: () => {},
    });

    await expect(render.render(ev)).rejects.toThrow(/deadline/);

    // The override makes the deadline, and so the reservation, much smaller than the real formula
    // ever would: 1.5s worst case at $0.007/s is $0.0105, independent of billing.
    const reservedUsd = 1.5 * 0.007;
    expect(budget.charges).toHaveLength(2);
    expect(budget.charges[0]).toEqual({ usd: reservedUsd, what: "reactor session reserve" });
    // ready arrived before the 1.5s deadline fired, so billedS is time-since-ready and strictly
    // under 1.5s; the true-up is therefore a refund strictly between -reservedUsd and 0.
    expect(budget.charges[1]!.usd).toBeLessThan(0);
    expect(budget.charges[1]!.usd).toBeGreaterThan(-reservedUsd);
  }, 20_000);

  it("SIGKILLs a sidecar that ignores SIGTERM, and holds the session slot until it is really gone", async () => {
    // A sidecar wedged in the SDK's native FFI ignores SIGTERM. It still holds a Reactor session
    // billing by the second, so the slot must not be handed to the next event before it dies.
    const sidecar = await writeScript(
      "ignores-sigterm.cjs",
      `    process.on("SIGTERM", () => {});
    console.log(JSON.stringify({ event: "ready" }));
    setInterval(() => {}, 1000);`,
    );
    const render = makeReactorRender({
      python: process.execPath,
      sidecar,
      sessions: 1,
      workDir: path.join(dir, "work-sigkill"),
      store: recordingStore(),
      budget: recordingBudget(),
      deadlineMs: () => 500,
      log: () => {},
    });

    const started = Date.now();
    await expect(render.render(ev)).rejects.toThrow(/deadline/);
    // Settling had to wait out SIGKILL_AFTER_MS (3 s) on top of the 500 ms deadline, rather than
    // rejecting the moment SIGTERM went unanswered.
    expect(Date.now() - started).toBeGreaterThan(3_000);

    // The slot is free again, so the next render runs instead of blocking forever.
    const ok = await writeScript(
      "quick-done.cjs",
      `    console.log(JSON.stringify({ event: "ready" }));
    console.log(JSON.stringify({ event: "error", stage: "connect", reason: "no session" }));
    process.exit(1);`,
    );
    const second = makeReactorRender({
      python: process.execPath,
      sidecar: ok,
      sessions: 1,
      workDir: path.join(dir, "work-sigkill-2"),
      store: recordingStore(),
      budget: recordingBudget(),
      log: () => {},
    });
    await expect(second.render(ev)).rejects.toThrow(/no session/);
  }, 30_000);

  it("frees the session slot at disconnected rather than holding it through the fetch, so a second render overlaps the first's download", async () => {
    // Ticket 27: a 66.7 s fetch tied up a whole session slot moving bytes for a session that was
    // already disconnected and no longer billing. With sessions: 1, a second render must be able
    // to start and finish while the first is still "downloading" its recording, not wait behind it.
    const sidecar = await writeScript(
      "slow-fetch.cjs",
      `    console.log(JSON.stringify({ event: "ready" }));
    console.log(JSON.stringify({ event: "segment", name: "first", start_t: 0, end_t: 10 }));
    console.log(JSON.stringify({ event: "segment", name: "branch-0", start_t: 10, end_t: 15 }));
    console.log(JSON.stringify({ event: "segment", name: "branch-1", start_t: 15, end_t: 20 }));
    console.log(JSON.stringify({ event: "disconnected", billed_s: 20.5 }));
    setTimeout(() => {
      console.log(JSON.stringify({ event: "done", recording: "/fake/session.mp4", billed_s: 20.5, fetch_s: 3.2 }));
      process.exit(0);
    }, 1500);`,
    );
    const render = makeReactorRender({
      python: process.execPath,
      sidecar,
      sessions: 1,
      workDir: path.join(dir, "work-slot-free"),
      store: recordingStore(),
      budget: recordingBudget(),
      ffmpeg: recordingFfmpeg().run,
      log: () => {},
    });
    const ev2: EventRow = { ...ev, id: "0xreactortest2" } as EventRow;

    const started = Date.now();
    const [r1, r2] = await Promise.all([render.render(ev), render.render(ev2)]);
    // Serialized (the pre-ticket-27 behaviour), the second render could not even spawn until the
    // first's fetch and cleanup finished, so two 1.5 s "downloads" back to back take at least 3 s.
    // Overlapped, both finish close to the length of a single one.
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(r1.costUsd).toBeCloseTo(20.5 * 0.007, 6);
    expect(r2.costUsd).toBeCloseTo(20.5 * 0.007, 6);
  }, 20_000);

  it("a fetch failure trues up from the disconnected line's billed_s, not wall-clock-since-ready, and is not a SidecarError", async () => {
    const sidecar = await writeScript(
      "fetch-failed.cjs",
      `    console.log(JSON.stringify({ event: "ready" }));
    console.log(JSON.stringify({ event: "segment", name: "first", start_t: 0, end_t: 10 }));
    console.log(JSON.stringify({ event: "segment", name: "branch-0", start_t: 10, end_t: 15 }));
    console.log(JSON.stringify({ event: "segment", name: "branch-1", start_t: 15, end_t: 20 }));
    console.log(JSON.stringify({ event: "disconnected", billed_s: 20.5 }));
    setTimeout(() => {
      console.log(JSON.stringify({ event: "error", stage: "fetch", reason: "connection reset by peer" }));
      process.exit(1);
    }, 300);`,
    );
    const budget = recordingBudget();
    const render = makeReactorRender({
      python: process.execPath,
      sidecar,
      sessions: 1,
      workDir: path.join(dir, "work-fetch-failed"),
      store: recordingStore(),
      budget,
      log: () => {},
    });

    let caught: unknown;
    try {
      await render.render(ev);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RenderFetchError);
    expect(caught).not.toBeInstanceOf(SidecarError);
    expect((caught as RenderFetchError).billedS).toBeCloseTo(20.5, 6);

    // Trued up from the reported 20.5 s (disconnected), not the ~0.3 s wall clock since ready.
    expect(budget.charges).toHaveLength(2);
    expect(budget.charges[0]).toEqual({ usd: RESERVED_USD, what: "reactor session reserve" });
    expect(budget.charges[1]!.usd).toBeCloseTo(20.5 * 0.007 - RESERVED_USD, 6);
  }, 20_000);

  it("two concurrent sessions cannot between them push spend past the cap", async () => {
    // Ticket 20's own REAL-round numbers: firstHalfSec=40, secondHalfSec=40+40=80 ->
    // estimateSec=9+40+80+3=132 ($0.924); default deadline 2*132+120=384s, worst case at
    // $0.007/s is $2.688. That is exactly what the four-channel REAL round of 2026-09-12
    // overshot: $6.563 against a $6.50 cap, because each session's bound was computed from
    // spent() before the others' true-ups landed. A cap sized for one worst case must refuse a
    // second concurrent session outright, not admit it and true it up afterwards.
    const realScript: Authored = {
      ...script,
      firstHalf: [
        { prompt: "shot one", seconds: 20 },
        { prompt: "shot two", seconds: 20 },
      ],
      branches: [
        [{ prompt: "branch A", seconds: 40 }],
        [{ prompt: "branch B", seconds: 40 }],
      ],
    };
    const realEv: EventRow = { ...ev, id: "0xreactorreal", script: realScript } as EventRow;
    // A clean two-decimal cap, like a real MAX_SPEND_USD, rather than the raw 384 * 0.007: spend
    // is logged rounded to cents (budget.ts), and an exact-cent cap keeps that rounding from
    // making a logged datapoint read as a hair over the cap when the real spend was not.
    const capUsd = 2.69;

    const spendLog: Array<Record<string, unknown>> = [];
    const budget = makeBudget({
      capUsd,
      spentUsd: 0,
      persist: async () => {},
      log: (msg, extra) => void (msg === "spend" && spendLog.push(extra ?? {})),
    });

    const sidecarA = await writeScript(
      "concurrent-a.cjs",
      `    console.log(JSON.stringify({ event: "ready" }));
    console.log(JSON.stringify({ event: "segment", name: "first", start_t: 0, end_t: 40 }));
    console.log(JSON.stringify({ event: "segment", name: "branch-0", start_t: 40, end_t: 80 }));
    console.log(JSON.stringify({ event: "segment", name: "branch-1", start_t: 80, end_t: 120 }));
    console.log(JSON.stringify({ event: "done", recording: "/fake/session.mp4", billed_s: 45, fetch_s: 1 }));
    process.exit(0);`,
    );
    const renderA = makeReactorRender({
      python: process.execPath,
      sidecar: sidecarA,
      sessions: 1,
      workDir: path.join(dir, "work-concurrent-a"),
      store: recordingStore(),
      budget,
      ffmpeg: recordingFfmpeg().run,
      log: () => {},
    });
    const renderB = makeReactorRender({
      python: process.execPath,
      sidecar: path.join(dir, "unused-concurrent-b.cjs"), // never spawned: B is refused up front
      sessions: 1,
      workDir: path.join(dir, "work-concurrent-b"),
      store: recordingStore(),
      budget,
      log: () => {},
    });

    // No await between these two calls: renderA runs synchronously up to its own first await
    // (inside its reservation's charge()), which is exactly what commits A's reservation before
    // renderB's synchronous prefix (assertAffordable) ever runs. That ordering is Node's own
    // single-threaded scheduling, not a race the test has to force.
    const [resA, resB] = await Promise.allSettled([renderA.render(realEv), renderB.render(realEv)]);

    expect(resA.status).toBe("fulfilled");
    expect(resB.status).toBe("rejected");
    expect((resB as PromiseRejectedResult).reason).toBeInstanceOf(SpendCapError);

    // The whole claim: B's reservation never happened, because A's up-front worst-case reservation
    // already left no room even for B's estimate, so total spend never crossed the cap at any point.
    expect(budget.spent()).toBeLessThanOrEqual(capUsd);
    for (const s of spendLog) expect(s.totalUsd as number).toBeLessThanOrEqual(capUsd);
  }, 20_000);

  it("a session that hangs to its deadline cannot push spend past the cap (ticket 20's Done when)", async () => {
    const sidecar = await writeScript(
      "hangs-capped.cjs",
      `    console.log(JSON.stringify({ event: "ready" }));
    setInterval(() => {}, 1000); // keep the event loop alive; only the deadline's SIGTERM should end this`,
    );
    const spendLog: Array<Record<string, unknown>> = [];
    const budget = makeBudget({
      capUsd: 0.5,
      spentUsd: 0,
      persist: async () => {},
      log: (msg, extra) => void (msg === "spend" && spendLog.push(extra ?? {})),
    });
    const render = makeReactorRender({
      python: process.execPath,
      sidecar,
      sessions: 1,
      workDir: path.join(dir, "work-hang-capped"),
      store: recordingStore(),
      budget,
      deadlineMs: () => 2000, // short but enough for the child to spawn and reach ready reliably
      log: () => {},
    });

    await expect(render.render(ev)).rejects.toThrow(/deadline/);

    // A DEMO session rode its watchdog to $1.58 against a $1.35 cap on 2026-09-12 because nothing
    // sampled spend mid-session; this is the same failure mode (a sidecar that hangs to its
    // deadline) proved against the real budget module rather than the test's no-op fake.
    expect(budget.spent()).toBeLessThanOrEqual(0.5);
    for (const s of spendLog) expect(s.totalUsd as number).toBeLessThanOrEqual(0.5);
  }, 20_000);

  it("SIGTERM during a live session trues up what Reactor billed instead of stranding the reservation", async () => {
    // Ticket 31: shutdown aborted the channels and hard-exited, but nothing reached the sidecar, so
    // the session's up-front reservation was charged and never trued up. Four kills on 2026-09-12
    // put $9.69 of phantom spend on World.spendUsd, more than the four rounds actually cost.
    const sidecar = await writeScript(
      "aborted.cjs",
      `    console.log(JSON.stringify({ event: "ready" }));
    setInterval(() => {}, 1000); // only the abort's SIGTERM should end this`,
    );
    const budget = recordingBudget();
    const ac = new AbortController();
    const render = makeReactorRender({
      python: process.execPath,
      sidecar,
      sessions: 1,
      workDir: path.join(dir, "work-abort"),
      store: recordingStore(),
      budget,
      signal: ac.signal,
      log: () => {},
    });

    const pending = render.render(ev);
    await new Promise((r) => setTimeout(r, 800)); // long enough for the child to spawn and reach ready
    ac.abort();

    const caught = await pending.then(() => null, (e: unknown) => e);
    expect(caught).toBeInstanceOf(SidecarError);
    expect(caught).toHaveProperty("message", expect.stringMatching(/shutting down/));

    // The whole point: `ready` had arrived, so the session really was billing, and what is left on
    // the counter is that billing and nothing else.
    const billedS = (caught as SidecarError).billedS;
    expect(billedS).not.toBeNull();
    const spent = budget.charges.reduce((n, c) => n + c.usd, 0);
    expect(spent).toBeCloseTo(billedS! * 0.007, 6);
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThan(RESERVED_USD); // a fraction of a second billed, not the 184 s reserved

    // And a shutting-down engine never opens another session: produce() retries a failed render,
    // which before this check reserved again inside the grace period and stranded that instead.
    const before = budget.charges.length;
    await expect(render.render(ev)).rejects.toThrow(/shutting down/);
    expect(budget.charges).toHaveLength(before);
  }, 20_000);

  it("an abort during the download trues up from the disconnected billed_s, not the wall clock", async () => {
    // The session stops billing at `disconnected` and the download that follows is free, so an
    // abort partway through one must not charge it. Round D's region fetch ran 176.7 s, which is
    // $1.24 of wall clock that Reactor never billed for.
    const sidecar = await writeScript(
      "abort-in-fetch.cjs",
      `    console.log(JSON.stringify({ event: "ready" }));
    console.log(JSON.stringify({ event: "segment", name: "first", start_t: 0, end_t: 10 }));
    console.log(JSON.stringify({ event: "disconnected", billed_s: 20.5 }));
    setInterval(() => {}, 1000); // "downloading" until the abort's SIGTERM`,
    );
    const budget = recordingBudget();
    const ac = new AbortController();
    const render = makeReactorRender({
      python: process.execPath,
      sidecar,
      sessions: 1,
      workDir: path.join(dir, "work-abort-fetch"),
      store: recordingStore(),
      budget,
      signal: ac.signal,
      log: () => {},
    });

    const pending = render.render(ev);
    await new Promise((r) => setTimeout(r, 800));
    ac.abort();
    await expect(pending).rejects.toThrow(/shutting down/);

    expect(budget.charges.reduce((n, c) => n + c.usd, 0)).toBeCloseTo(20.5 * 0.007, 6);
  }, 20_000);

  it("sends the plan at the length the author wrote, however long", async () => {
    // Ticket 33: the 131.7 s ceiling this used to trim to does not exist. Ticket 32's paid probe
    // recorded 162.042383 s, so a plan goes to the sidecar as written. Five outcomes at a 30 s
    // second half is 160 s, the shape that used to be refused outright before a session opened.
    const planFile = path.join(dir, "untrimmed-plan.json");
    const sidecar = await writePlanCapturingScript(
      "untrimmed.cjs",
      planFile,
      `    console.log(JSON.stringify({ event: "ready" }));
    console.log(JSON.stringify({ event: "segment", name: "first", start_t: 0, end_t: 10 }));
    for (let b = 0; b < 5; b++) {
      console.log(JSON.stringify({ event: "segment", name: "branch-" + b, start_t: 10 + b * 30, end_t: 40 + b * 30 }));
    }
    console.log(JSON.stringify({ event: "done", recording: "/fake/session.mp4", billed_s: 160, fetch_s: 3 }));
    process.exit(0);`,
    );
    const wideScript: Authored = {
      ...script,
      outcomes: ["A", "B", "C", "D", "E"],
      firstHalf: [{ prompt: "first", seconds: 10 }],
      branches: [0, 1, 2, 3, 4].map((b) => [{ prompt: `branch ${b}`, seconds: 30 }]),
      canonUpdates: [["A"], ["B"], ["C"], ["D"], ["E"]],
    };
    const wideEv: EventRow = { ...ev, id: "0xreactorwide", script: wideScript } as EventRow;
    const store = recordingStore();
    await makeReactorRender({
      python: process.execPath,
      sidecar,
      sessions: 1,
      workDir: path.join(dir, "work-wide"),
      store,
      budget: recordingBudget(),
      ffmpeg: recordingFfmpeg().run,
      log: () => {},
    }).render(wideEv);

    const sent = JSON.parse(await readFile(planFile, "utf8")) as {
      segments: { name: string; clips: { seconds: number }[] }[];
    };
    const total = sent.segments.reduce((n, s) => n + s.clips.reduce((m, c) => m + c.seconds, 0), 0);
    expect(total).toBe(160);
    expect(store.stored).toHaveLength(6);
  }, 20_000);

  it("logs the recording's shortfall against the plan's last segment when it comes up short (ticket 32)", async () => {
    // Round D's region branch, from ticket 32: the plan's last segment ended at 142.0 s but the
    // recording measured 131.70905 s. The sidecar still reports `done` (ticket 26) rather than
    // fail the paid session, so this has to be caught by comparing the two numbers, not by a
    // protocol error.
    const sidecar = await writeScript(
      "short-recording.cjs",
      `    console.log(JSON.stringify({ event: "ready" }));
    console.log(JSON.stringify({ event: "segment", name: "first", start_t: 0, end_t: 10 }));
    console.log(JSON.stringify({ event: "segment", name: "branch-0", start_t: 10, end_t: 15 }));
    console.log(JSON.stringify({ event: "segment", name: "branch-1", start_t: 15, end_t: 142.0 }));
    console.log(JSON.stringify({ event: "done", recording: "/fake/session.mp4", billed_s: 142, fetch_s: 176.7, recording_s: 131.70905 }));
    process.exit(0);`,
    );
    const logged: Array<Record<string, unknown>> = [];
    await makeReactorRender({
      python: process.execPath,
      sidecar,
      sessions: 1,
      workDir: path.join(dir, "work-short-recording"),
      store: recordingStore(),
      budget: recordingBudget(),
      ffmpeg: recordingFfmpeg().run,
      log: (m, extra) => void (m === "recording short of plan" && logged.push(extra ?? {})),
    }).render(ev);

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ channelId: "sports", seq: 1 });
    expect(logged[0]!.recordingS).toBeCloseTo(131.70905, 5);
    expect(logged[0]!.shortfallS as number).toBeCloseTo(142.0 - 131.70905, 2);
  }, 20_000);

  it("does not log a shortfall when the recording covers the plan's last segment (over, not short)", async () => {
    // A normal session, also from ticket 32: asked for 131.4 s and recorded 131.70905 s, over by
    // 0.3 s. That is not a shortfall, so nothing should fire.
    const sidecar = await writeScript(
      "over-recording.cjs",
      `    console.log(JSON.stringify({ event: "ready" }));
    console.log(JSON.stringify({ event: "segment", name: "first", start_t: 0, end_t: 10 }));
    console.log(JSON.stringify({ event: "segment", name: "branch-0", start_t: 10, end_t: 15 }));
    console.log(JSON.stringify({ event: "segment", name: "branch-1", start_t: 15, end_t: 131.4 }));
    console.log(JSON.stringify({ event: "done", recording: "/fake/session.mp4", billed_s: 131.4, fetch_s: 3.2, recording_s: 131.70905 }));
    process.exit(0);`,
    );
    const logged: string[] = [];
    await makeReactorRender({
      python: process.execPath,
      sidecar,
      sessions: 1,
      workDir: path.join(dir, "work-over-recording"),
      store: recordingStore(),
      budget: recordingBudget(),
      ffmpeg: recordingFfmpeg().run,
      log: (m) => void logged.push(m),
    }).render(ev);

    expect(logged).not.toContain("recording short of plan");
  }, 20_000);

  it("SidecarError carries null billedS only when the error happens before ready", () => {
    const before = new SidecarError("x", null);
    const after = new SidecarError("y", 5);
    expect(before.billedS).toBeNull();
    expect(after.billedS).toBe(5);
  });
});
