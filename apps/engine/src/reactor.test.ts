import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Authored } from "./authored.js";
import { SpendCapError, type Budget } from "./budget.js";
import type { EventRow } from "./machine.js";
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

// firstHalfSec=10, secondHalfSec=5+5=10 -> estimateSec=9+10+10+3=32 -> estimateUsd=0.224
const ESTIMATE_USD = 32 * 0.007;

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

    // charged the estimate up front, then trued up to what the sidecar actually billed
    expect(budget.charges).toHaveLength(2);
    expect(budget.charges[0]).toEqual({ usd: ESTIMATE_USD, what: "reactor session" });
    expect(budget.charges[1]!.usd).toBeCloseTo(20.5 * 0.007 - ESTIMATE_USD, 6);
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

  it("a ready that never arrives: refunds the whole estimate (nothing was billed)", async () => {
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
    expect(budget.charges[0]).toEqual({ usd: ESTIMATE_USD, what: "reactor session" });
    expect(budget.charges[1]).toEqual({ usd: -ESTIMATE_USD, what: "reactor session true-up (error)" });
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
    expect(budget.charges[0]).toEqual({ usd: ESTIMATE_USD, what: "reactor session" });
    expect(budget.charges[1]!.usd).toBeCloseTo(12.3 * 0.007 - ESTIMATE_USD, 6);
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
    expect(budget.charges).toHaveLength(2);
    expect(budget.charges[0]).toEqual({ usd: ESTIMATE_USD, what: "reactor session" });
    // ready arrived, so billedS is time-since-ready (well under a second here) rather than null
    expect(budget.charges[1]!.usd).toBeCloseTo(-ESTIMATE_USD, 1);
    expect(budget.charges[1]!.usd).toBeGreaterThan(-ESTIMATE_USD);
  }, 20_000);

  it("SidecarError carries null billedS only when the error happens before ready", () => {
    const before = new SidecarError("x", null);
    const after = new SidecarError("y", 5);
    expect(before.billedS).toBeNull();
    expect(after.billedS).toBe(5);
  });
});
