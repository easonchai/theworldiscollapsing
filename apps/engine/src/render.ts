import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Shot } from "./authored.js";
import type { EventRow, Render } from "./machine.js";
import type { MediaStore } from "./media.js";
import type { OpenRouter } from "./openrouter.js";

const run = promisify(execFile);

// Verified 2026-09-09 from GET /api/v1/videos/models (docs/RESEARCH.md): minimax/hailuo-3-max
// bills duration_seconds_480p 0.05 and duration_seconds_768p 0.08.
const RATE = { "480p": 0.05, "768p": 0.08 } as const;
type Res = keyof typeof RATE;

const CONCURRENCY = 8;
const CLIP_ATTEMPTS = 3; // 1 try + 2 retries

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
  log: (msg: string, extra?: Record<string, unknown>) => void;
}): Render {
  const work = (ev: EventRow, name: string) => path.join(cfg.workDir, ev.id, name);

  async function clip(ev: EventRow, shot: Shot, res: Res, frameUrl: string | null, name: string): Promise<string> {
    const out = work(ev, name);
    let last: unknown;
    for (let attempt = 1; attempt <= CLIP_ATTEMPTS; attempt++) {
      try {
        const job = await cfg.or.submitVideo({
          model: cfg.videoModel,
          prompt: shot.prompt,
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
      await writeFile(png, await cfg.or.generateImage(keyArtPrompt(ev)));
      return { url: await cfg.store.storeFile(ev.id, "key.png", png), costUsd: 0, clip0: null };
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

  async function renderList(ev: EventRow, shots: Shot[], res: Res, frameUrl: string, prefix: string, out: string) {
    const clips = await pool(CONCURRENCY, shots, (s, i) => clip(ev, s, res, frameUrl, `${prefix}-${i}.mp4`));
    await concat(clips, out);
    return clips.length;
  }

  return {
    async firstHalf(ev) {
      await mkdir(path.join(cfg.workDir, ev.id), { recursive: true });
      const shots = ev.script.firstHalf;
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
    },

    async branches(ev) {
      const dir = path.join(cfg.workDir, ev.id);
      await mkdir(dir, { recursive: true });
      const seed = work(ev, "last.png");
      await lastFrame(work(ev, "first.mp4"), seed).catch(() => {}); // idempotent; no-op if already extracted
      const seedUrl = await cfg.store.storeFile(ev.id, "last.png", seed);

      const lists = ev.script.branches;
      const flat = lists.flatMap((shots, b) => shots.map((s, i) => ({ s, b, i })));
      const paths = await pool(CONCURRENCY, flat, ({ s, b, i }) => clip(ev, s, "768p", seedUrl, `branch-${b}-${i}.mp4`));

      const urls: string[] = [];
      for (let b = 0; b < lists.length; b++) {
        const out = work(ev, `branch-${b}.mp4`);
        await concat(flat.map((f, k) => (f.b === b ? paths[k]! : null)).filter((p): p is string => !!p), out);
        urls.push(await cfg.store.storeFile(ev.id, `branch-${b}.mp4`, out));
      }

      const seconds = flat.reduce((n, f) => n + f.s.seconds, 0);
      const costUsd = seconds * RATE["768p"];
      cfg.log("rendered event", {
        channelId: ev.channelId,
        seq: ev.seq,
        clips: ev.script.firstHalf.length + flat.length,
        seconds: ev.script.firstHalf.reduce((n, s) => n + s.seconds, 0) + seconds,
        usd: round((ev.costUsd ?? 0) + costUsd),
      });
      return { urls, costUsd };
    },
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

const keyArtPrompt = (ev: EventRow) =>
  `Establishing key art frame for a live television broadcast. Channel: ${ev.channelId}. ` +
  `Event: ${ev.title}. ${ev.premise} ` +
  `Wide cinematic 16:9 establishing shot, broadcast camera, no text, no captions, no logos, no on-screen graphics.`;
