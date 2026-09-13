import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Shot } from "./authored.js";
import type { EventRow, Render } from "./machine.js";
import { branchFileName, type MediaStore } from "./media.js";
import type { OpenRouter } from "./openrouter.js";
import type { Budget } from "./budget.js";

const run = promisify(execFile);

// Verified 2026-09-09 from GET /api/v1/videos/models (docs/RESEARCH.md): minimax/hailuo-3-max
// bills duration_seconds_480p 0.05 and duration_seconds_768p 0.08.
const RATE = { "480p": 0.05, "768p": 0.08 } as const;
type Res = keyof typeof RATE;

const CONCURRENCY = 8;
const CLIP_ATTEMPTS = 3; // 1 try + 2 retries

/** The footage type and camera of each channel, restated to the video model on every single clip. */
export const CHANNEL_PREFIX: Record<string, string> = {
  sports: "Live sports broadcast footage, broadcast camera, real-time speed:",
  politics:
    "Television news footage, handheld news camera or fixed studio camera, real-time, charts and graphs on the studio screen where the shot is in a studio:",
  culture: "Live event television coverage, press camera, stage light as it is, real-time:",
  region: "Local television news field footage, reporter's camera, natural light, real-time:",
};
const DEFAULT_PREFIX = "Live television broadcast footage, broadcast camera, real-time speed:";
/**
 * MiniMax has no negative-prompt field, so the constraints ride in the prompt as plain statements.
 * Every clip carries these once and `keyArtPrompt` no longer repeats them.
 *
 * v3, ticket 29: "No captions, no logos" was read as a rule about overlays, so scene text survived
 * on every channel and fast-h3 rendered it as nonsense letterforms — a gold awards screen reading
 * CHENNIU DORSTAWS RAPOOI was the brightest object in the culture clip. The rule now names what the
 * camera sees. "Too small, too distant or too oblique" rather than "out of focus" or "blurred" on
 * purpose: those two ask for a soft image, which is a different and worse picture. Signage stays in
 * frame, because politics needs a chart on the studio screen and the shape is what carries it.
 */
export const STYLE_SUFFIX =
  "Real-time speed. No slow motion. Not cinematic. No film look. Natural light as it is. " +
  "Signs, screens and hoardings may be in frame, but lettering on them is too small, too distant " +
  "or too oblique to read. No readable words anywhere in frame. No captions, no subtitles, " +
  "no broadcaster watermark, no logos.";
/**
 * Prompts over ~2000 chars are risky on MiniMax and short ones follow better; this is the ceiling.
 * 800, not 600: the v3 suffix is 195 chars longer than v2, and at 600 the shot text is what pays for
 * it — a two-sentence shot would start getting sliced mid-word. This leaves the shot the same room
 * it had before the suffix grew.
 */
const MAX_PROMPT = 800;

/**
 * The prompt actually sent to the video model: channel house style, the authored shot, the universal
 * constraints. Every clip goes through here — first half, branches and the key-art still.
 */
export function clipPrompt(channelId: string, prompt: string): string {
  const prefix = CHANNEL_PREFIX[channelId] ?? DEFAULT_PREFIX;
  const room = MAX_PROMPT - prefix.length - STYLE_SUFFIX.length - 2;
  return `${prefix} ${prompt.trim().slice(0, room)} ${STYLE_SUFFIX}`;
}

/** Bounded-concurrency map that keeps input order. */
async function pool<T, R>(n: number, items: T[], fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!, i);
    }),
  );
  return out;
}

async function probe(file: string): Promise<string> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,pix_fmt,r_frame_rate",
    "-of", "csv=p=0", file,
  ]);
  return stdout.trim();
}

/** ffmpeg concat demuxer; stream-copies when every clip has identical parameters, re-encodes otherwise. */
async function concat(clips: string[], out: string): Promise<void> {
  const list = `${out}.txt`;
  // The concat demuxer resolves relative entries against the list file's own directory, so absolutise.
  await writeFile(list, clips.map((c) => `file '${path.resolve(c).replace(/'/g, "'\\''")}'`).join("\n"));
  const params = await Promise.all(clips.map(probe));
  const same = params.every((p) => p === params[0]);
  const codec = same
    ? ["-c", "copy"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-r", "24"];
  await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, ...codec, "-movflags", "+faststart", out]);
}

async function lastFrame(video: string, out: string): Promise<void> {
  await run("ffmpeg", ["-y", "-loglevel", "error", "-sseof", "-1", "-i", video, "-update", "1", "-frames:v", "1", out]);
}

export function makeRender(cfg: {
  or: OpenRouter;
  store: MediaStore;
  workDir: string;
  videoModel: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  budget: Budget;
  /** Per-image estimate for the key-art still; OpenRouter does not publish the price (docs/RESEARCH.md). */
  imageCostUsd: number;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}): Render {
  const listCost = (shots: Shot[], res: Res) => shots.reduce((n, s) => n + s.seconds * RATE[res], 0);
  const work = (ev: EventRow, name: string) => path.join(cfg.workDir, ev.id, name);

  async function clip(ev: EventRow, shot: Shot, res: Res, frameUrl: string | null, name: string): Promise<string> {
    const out = work(ev, name);
    const usd = shot.seconds * RATE[res];
    let last: unknown;
    for (let attempt = 1; attempt <= CLIP_ATTEMPTS; attempt++) {
      // A submitted job may bill whether or not it succeeds, so every attempt is charged up front.
      cfg.budget.assertAffordable(usd, name);
      await cfg.budget.charge(usd, name);
      try {
        const job = await cfg.or.submitVideo({
          model: cfg.videoModel,
          prompt: clipPrompt(ev.channelId, shot.prompt),
          duration: shot.seconds,
          resolution: res,
          aspect_ratio: "16:9",
          ...(frameUrl
            ? { frame_images: [{ type: "image_url" as const, image_url: { url: frameUrl }, frame_type: "first_frame" as const }] }
            : {}),
        });
        const { url } = await cfg.or.pollVideo(job, { intervalMs: cfg.pollIntervalMs, timeoutMs: cfg.pollTimeoutMs });
        await cfg.or.download(url, out);
        return out;
      } catch (e) {
        last = e;
        cfg.log("clip failed", { seq: ev.seq, name, attempt, error: String(e).slice(0, 200) });
      }
    }
    throw new Error(`clip ${name} failed after ${CLIP_ATTEMPTS} attempts: ${String(last).slice(0, 200)}`);
  }

  /**
   * One key-art still per event is the image-to-video seed for every first-half clip, so the
   * clips look like one broadcast. If image generation is unavailable, fall back to rendering
   * the first shot text-to-video and using its last frame (that clip is then reused, not re-billed).
   */
  async function keyArt(ev: EventRow): Promise<{ url: string; costUsd: number; clip0: string | null }> {
    const png = work(ev, "key.png");
    try {
      cfg.budget.assertAffordable(cfg.imageCostUsd, "key art");
      await cfg.budget.charge(cfg.imageCostUsd, "key art");
      await writeFile(png, await cfg.or.generateImage(keyArtPrompt(ev)));
      return { url: await cfg.store.storeFile(ev.id, "key.png", png), costUsd: cfg.imageCostUsd, clip0: null };
    } catch (e) {
      cfg.log("image generation unavailable, seeding key art from the first shot", { seq: ev.seq, error: String(e).slice(0, 200) });
      const shot = ev.script.firstHalf[0]!;
      const c = await clip(ev, shot, "480p", null, "clip-0.mp4");
      await lastFrame(c, png);
      return {
        url: await cfg.store.storeFile(ev.id, "key.png", png),
        costUsd: shot.seconds * RATE["480p"],
        clip0: c,
      };
    }
  }

  async function firstHalf(ev: EventRow): Promise<{ url: string; costUsd: number }> {
    await mkdir(path.join(cfg.workDir, ev.id), { recursive: true });
    const shots = ev.script.firstHalf;
    // Refuse before the first clip rather than leave a half-rendered list behind.
    cfg.budget.assertAffordable(listCost(shots, "480p") + cfg.imageCostUsd, "first half");
    const ka = await keyArt(ev);

    let costUsd = ka.costUsd;
    const todo = shots.map((s, i) => ({ s, i })).filter(({ i }) => !(i === 0 && ka.clip0));
    const clips = new Map<number, string>();
    if (ka.clip0) clips.set(0, ka.clip0);
    await pool(CONCURRENCY, todo, async ({ s, i }) => {
      clips.set(i, await clip(ev, s, "480p", ka.url, `clip-${i}.mp4`));
      costUsd += s.seconds * RATE["480p"];
    });

    const out = work(ev, "first.mp4");
    await concat(shots.map((_, i) => clips.get(i)!), out);
    // Branch clips continue from this frame, so the second half is visually continuous.
    await lastFrame(out, work(ev, "last.png"));
    const seconds = shots.reduce((n, s) => n + s.seconds, 0);
    cfg.log("rendered first half", { channelId: ev.channelId, seq: ev.seq, clips: shots.length, seconds, usd: round(costUsd) });
    return { url: await cfg.store.storeFile(ev.id, "first.mp4", out), costUsd };
  }

  // firstHalfCostUsd is passed through rather than read off the row: `produce` no longer updates the
  // row between the two steps, so ev.costUsd is still whatever it was before this render started.
  async function branches(ev: EventRow, firstHalfCostUsd: number): Promise<{ urls: string[]; costUsd: number }> {
    const dir = path.join(cfg.workDir, ev.id);
    await mkdir(dir, { recursive: true });
    const seed = work(ev, "last.png");
    await lastFrame(work(ev, "first.mp4"), seed).catch(() => {}); // idempotent; no-op if already extracted
    const seedUrl = await cfg.store.storeFile(ev.id, "last.png", seed);

    const lists = ev.script.branches;
    const flat = lists.flatMap((shots, b) => shots.map((s, i) => ({ s, b, i })));
    cfg.budget.assertAffordable(listCost(flat.map((f) => f.s), "768p"), "branches");
    const paths = await pool(CONCURRENCY, flat, ({ s, b, i }) => clip(ev, s, "768p", seedUrl, `branch-${b}-${i}.mp4`));

    const urls: string[] = [];
    for (let b = 0; b < lists.length; b++) {
      const out = work(ev, `branch-${b}.mp4`);
      await concat(flat.map((f, k) => (f.b === b ? paths[k]! : null)).filter((p): p is string => !!p), out);
      urls.push(await cfg.store.storeFile(ev.id, branchFileName(b), out));
    }

    const seconds = flat.reduce((n, f) => n + f.s.seconds, 0);
    const costUsd = seconds * RATE["768p"];
    cfg.log("rendered event", {
      channelId: ev.channelId,
      seq: ev.seq,
      clips: ev.script.firstHalf.length + flat.length,
      seconds: ev.script.firstHalf.reduce((n, s) => n + s.seconds, 0) + seconds,
      usd: round(firstHalfCostUsd + costUsd),
    });
    // Every finished file is in the media store now; nothing reads this directory again. Without
    // the sweep it keeps ~18 MB of clips per event forever.
    await rm(dir, { recursive: true, force: true });
    return { urls, costUsd };
  }

  return {
    async render(ev) {
      const first = await firstHalf(ev);
      const second = await branches(ev, first.costUsd);
      return { firstHalfUrl: first.url, branchUrls: second.urls, costUsd: first.costUsd + second.costUsd };
    },
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

/** The still that seeds every first-half clip, so it has to be in the same house style as they are. */
export const keyArtPrompt = (ev: EventRow) =>
  clipPrompt(ev.channelId, `A still frame from live coverage of: ${ev.title}. ${ev.premise}`);
