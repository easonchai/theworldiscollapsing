import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Authored } from "./authored.js";
import { authored, startFake } from "./fake/openrouter.js";
import type { EventRow } from "./machine.js";
import { makeMediaStore, startMediaServer } from "./media.js";
import { makeOpenRouter } from "./openrouter.js";
import { makeRender } from "./render.js";

const run = promisify(execFile);

async function seconds(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Number(stdout.trim());
}

let dir: string;
let fake: ReturnType<typeof startFake>;
let mediaServer: ReturnType<typeof startMediaServer>;
let render: ReturnType<typeof makeRender>;
let mediaPort: number;
let script: Authored;
let ev: EventRow;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "twic-render-"));
  fake = startFake(0);
  await once(fake, "listening");
  mediaServer = startMediaServer({ dir, port: 0 });
  await once(mediaServer, "listening");
  mediaPort = (mediaServer.address() as AddressInfo).port;

  const or = makeOpenRouter({
    baseUrl: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`,
    apiKey: "fake",
    imageModel: "google/gemini-3.1-flash-image",
  });
  render = makeRender({
    or,
    store: makeMediaStore({ store: "local", dir, baseUrl: `http://127.0.0.1:${mediaPort}` }),
    // Relative on purpose: MEDIA_DIR defaults to "./media", and the ffmpeg concat demuxer
    // resolves relative list entries against the list file's directory, not the cwd.
    workDir: path.relative(process.cwd(), path.join(dir, ".work")),
    videoModel: "minimax/hailuo-3-max",
    pollIntervalMs: 200,
    pollTimeoutMs: 60_000,
    log: () => {},
  });

  // The fake authors against the same durations the engine would ask for in DEMO mode.
  script = authored("sports", 15, 10) as Authored;
  ev = {
    id: "0xrendertest",
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
}, 120_000);

afterAll(async () => {
  fake.close();
  mediaServer.close();
  await rm(dir, { recursive: true, force: true });
});

describe("render pipeline against the fake OpenRouter", () => {
  it("renders first.mp4 to the shot sum and bills 480p", async () => {
    const r = await render.firstHalf(ev);
    const want = script.firstHalf.reduce((n, s) => n + s.seconds, 0);
    expect(r.url).toMatch(/\/0xrendertest\/first\.mp4$/);
    expect(await seconds(path.join(dir, "0xrendertest", "first.mp4"))).toBeCloseTo(want, 0);
    expect(Math.abs((await seconds(path.join(dir, "0xrendertest", "first.mp4"))) - want)).toBeLessThan(1);
    expect(r.costUsd).toBeCloseTo(want * 0.05, 6);
    // key art still was generated and stored; last frame extracted for the branches
    await stat(path.join(dir, "0xrendertest", "key.png"));
    await stat(path.join(dir, ".work", "0xrendertest", "last.png"));
  }, 120_000);

  it("renders one branch per outcome from the first half's last frame and bills 768p", async () => {
    const r = await render.branches({ ...ev, costUsd: 1 });
    expect(r.urls).toHaveLength(script.outcomes.length);
    const want = script.branches[0]!.reduce((n, s) => n + s.seconds, 0);
    for (let i = 0; i < script.outcomes.length; i++) {
      // Random suffix: the only copy of this URL is Event.branchUrls, which is gated on state.
      expect(r.urls[i]).toMatch(new RegExp(`/0xrendertest/branch-${i}-[0-9a-f]{32}\\.mp4$`));
      const name = path.basename(new URL(r.urls[i]!).pathname);
      expect(Math.abs((await seconds(path.join(dir, "0xrendertest", name))) - want)).toBeLessThan(1);
      // the guessable path an unrevealed branch used to sit at
      const guess = await fetch(`http://127.0.0.1:${mediaPort}/0xrendertest/branch-${i}.mp4`);
      expect(guess.status).toBe(404);
    }
    const total = script.branches.flat().reduce((n, s) => n + s.seconds, 0);
    expect(r.costUsd).toBeCloseTo(total * 0.08, 6);
    // the per-event work directory is swept once the branches are stored
    await expect(stat(path.join(dir, ".work", "0xrendertest"))).rejects.toThrow();
  }, 180_000);
});
