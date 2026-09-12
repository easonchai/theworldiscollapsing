import { execFile } from "node:child_process";
import { appendFileSync, createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

// A local stand-in for the OpenRouter endpoints the engine uses, mirroring the shapes verified
// on 2026-09-09 (docs/RESEARCH.md → "OpenRouter API shapes"). No dependencies, no API key.
// Video clips are ffmpeg testsrc2 patterns of exactly the requested duration and resolution.

const run = promisify(execFile);
const CACHE = path.join(os.tmpdir(), "twic-fake-openrouter");

const SIZES: Record<string, string> = { "480p": "854x480", "768p": "1366x768", "720p": "1280x720", "1080p": "1920x1080" };

/** Shot lengths that sum to `total`, every shot inside the 5–15 s clip range. */
export function planShots(total: number): number[] {
  // ponytail: totals under 5s cannot be split into legal shots; the engine never asks for one.
  const n = Math.max(1, Math.min(Math.round(total / 8), Math.floor(total / 5) || 1));
  const base = Math.floor(total / n);
  const rem = total - base * n;
  return Array.from({ length: n }, (_, i) => Math.max(5, Math.min(15, base + (i < rem ? 1 : 0))));
}

// Outcome sets are 3 or 4 long; authored() picks the one matching nOutcomes, or falls back to the
// first set truncated or padded when neither length matches.
const CHANNELS: Record<string, { title: (n: number) => string; premise: string; outcomes: string[][]; beat: string }> = {
  sports: {
    title: (n) => `Matchday ${n}: Harbour City vs Northgate`,
    premise: "Top of the table clash at the Basin. Level at the interval.",
    outcomes: [
      ["Harbour City win", "Northgate win", "Draw"],
      ["Harbour City win by two or more", "Harbour City win by one", "Draw", "Northgate win"],
    ],
    beat: "main side camera, wide of the stadium, both teams in kit contesting midfield",
  },
  politics: {
    title: (n) => `Election night ${n}: the Basin seat`,
    premise: "Three candidates, the count is too close to call.",
    outcomes: [
      ["Incumbent holds", "Challenger wins", "Recount ordered"],
      ["Incumbent holds", "Challenger wins", "Independent takes the seat", "Recount ordered"],
    ],
    beat: "studio camera on the anchor desk, big screen behind carrying a rising bar chart and a map with red zones",
  },
  culture: {
    title: (n) => `Awards night ${n}: Best Picture`,
    premise: "Three nominees, the envelope is still sealed.",
    // Real names, not "Nominee A": the author prompt forbids placeholders (ticket 29) and a local
    // soak is only representative if the canned labels look like what the model now returns.
    outcomes: [
      ["Lina Cho wins", "Marta Ruiz wins", "Kei Nakamura wins"],
      ["Lina Cho wins", "Marta Ruiz wins", "Kei Nakamura wins", "Aria Solace wins", "No award given"],
    ],
    beat: "press-pool camera in the photographers' pen, hard camera locked on the stage",
  },
  region: {
    title: (n) => `Council vote ${n}: the harbour bill`,
    premise: "A contested vote on the waterfront redevelopment.",
    outcomes: [
      ["Bill passes", "Bill fails", "Vote deferred"],
      ["Bill passes unamended", "Bill passes amended", "Bill fails", "Vote deferred"],
    ],
    beat: "reporter's camera on the seawall, contractors working, grey daylight",
  },
};

const FALLBACK = {
  title: (n: number) => `Event ${n}`,
  premise: "Something is about to happen.",
  outcomes: [["Yes", "No", "Neither"]],
  beat: "wide establishing shot",
};

/**
 * The scorebug is sports-only and needs one final per outcome, so it is derived from whichever
 * canned outcome set was picked rather than written next to one of them.
 */
const finalFor = (o: string): string =>
  /two or more/i.test(o) ? "3 - 1" : /^harbour/i.test(o) ? "2 - 1" : /^northgate/i.test(o) ? "1 - 2" : "1 - 1";

let counter = 0;

/** Truncates or pads (repeating the last entry, labeled) the first canned set to exactly `n` long. */
function fitOutcomes(list: string[], n: number): string[] {
  if (n <= list.length) return list.slice(0, n);
  const out = [...list];
  while (out.length < n) out.push(`${list[list.length - 1]} (extra ${out.length})`);
  return out;
}

export function authored(channelId: string, firstHalfSec: number, secondHalfSec: number, nOutcomes = 3) {
  const ch = CHANNELS[channelId] ?? FALLBACK;
  const seq = ++counter;
  const outcomes = ch.outcomes.find((o) => o.length === nOutcomes) ?? fitOutcomes(ch.outcomes[0]!, nOutcomes);
  const first = planShots(firstHalfSec);
  const second = planShots(secondHalfSec);
  return {
    title: ch.title(seq),
    premise: ch.premise,
    outcomes,
    firstHalf: first.map((seconds, i) => ({ prompt: `${ch.beat}, part ${i + 1}, nothing decided yet`, seconds })),
    branches: outcomes.map((o) =>
      second.map((seconds, i) => ({ prompt: `${ch.beat}, resolution: ${o}, part ${i + 1}`, seconds })),
    ),
    cards: [{ afterShot: 0, title: `${channelId} desk`, stats: [`${outcomes.length} markets open`, "Level at the break"] }],
    ticker: [`${channelId} desk live`, "Pools open until lock", "Level at the break"],
    canonUpdates: outcomes.map((o) => [`${ch.title(seq)}: ${o}.`]),
    score: channelId === "sports" ? { sides: ["HAR", "NOR"], atBreak: "1 - 1", atEnd: outcomes.map(finalFor) } : null,
    reasoning: `Fake showrunner: picked ${outcomes.length} outcomes for ${channelId} #${seq}; the first half runs ${firstHalfSec}s and stays level so no branch is foreshadowed.`,
  };
}

type Job = { at: number; duration: number; resolution: string; prompt: string };

// ponytail: FAKE_MEDIA_DIR=<dir> replays real clips already paid for instead of test patterns.
// Files are named <channel|any>-<resolution>-<anything>.mp4; the channel is read off the prompt's
// house-style prefix, resolution must match, and a pool is walked round-robin so a three-shot first
// half gets three different clips when three exist. No match → the ffmpeg pattern as before.
const MEDIA_DIR = process.env.FAKE_MEDIA_DIR;
const replayCursor = new Map<string, number>();
async function replay(prompt: string, resolution: string): Promise<string | null> {
  if (!MEDIA_DIR) return null;
  const all = (await readdir(MEDIA_DIR)).filter((f) => f.endsWith(".mp4") && f.includes(`-${resolution}-`)).sort();
  const channel = /reporter's camera|field footage/i.test(prompt)
    ? "region"
    : /press-pool|event television/i.test(prompt)
      ? "culture"
      : /news footage|studio/i.test(prompt)
        ? "politics"
        : /sports/i.test(prompt)
          ? "sports"
          : "any";
  const own = all.filter((f) => f.startsWith(`${channel}-`));
  const pool = own.length ? own : all;
  if (!pool.length) return null;
  const key = `${channel}-${resolution}`;
  const i = replayCursor.get(key) ?? 0;
  replayCursor.set(key, i + 1);
  return path.join(MEDIA_DIR, pool[i % pool.length]!);
}

const clips = new Map<string, Promise<string>>();
function clip(duration: number, resolution: string): Promise<string> {
  const key = `${duration}-${resolution}`;
  let p = clips.get(key);
  if (!p) {
    p = (async () => {
      await mkdir(CACHE, { recursive: true });
      const out = path.join(CACHE, `${key}.mp4`);
      try {
        await stat(out);
      } catch {
        await run("ffmpeg", [
          "-y", "-loglevel", "error",
          "-f", "lavfi", "-i", `testsrc2=s=${SIZES[resolution] ?? "854x480"}:r=24:d=${duration}`,
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out,
        ]);
      }
      return out;
    })();
    clips.set(key, p);
  }
  return p;
}

let keyArt: Promise<Buffer> | null = null;
function png(): Promise<Buffer> {
  keyArt ??= (async () => {
    await mkdir(CACHE, { recursive: true });
    const out = path.join(CACHE, "key.png");
    await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:d=1", "-frames:v", "1", out]);
    return readFile(out);
  })();
  return keyArt;
}

// ponytail: set FAKE_LOG=<file> to append every request body as JSONL, for prompt inspection.
const FAKE_LOG = process.env.FAKE_LOG;
const record = (kind: string, body: unknown) => {
  if (FAKE_LOG) appendFileSync(FAKE_LOG, `${JSON.stringify({ at: new Date().toISOString(), kind, body })}\n`);
};

export function startFake(port: number): http.Server {
  const jobs = new Map<string, Job>();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `127.0.0.1:${port}`}`);
    const json = (code: number, body: unknown) =>
      res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
    const read = async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      return JSON.parse(Buffer.concat(chunks).toString() || "{}");
    };

    try {
      if (req.method === "POST" && url.pathname === "/api/v1/chat/completions") {
        const body = await read();
        record("chat", body);
        const schema = body.response_format?.json_schema?.schema;
        if (!schema?.properties) return json(400, { error: { message: "expected response_format.json_schema.schema" } });
        const prompt = (body.messages ?? []).map((m: { content: string }) => m.content).join("\n");
        const channelId = /^Channel:\s*(\S+)/m.exec(prompt)?.[1] ?? "sports";
        const lengths = /first half (\d+)s, each branch (\d+)s/.exec(prompt);
        const nOutcomes = Number(/Give exactly (\d+) outcomes/.exec(prompt)?.[1] ?? 3);
        const object = authored(channelId, Number(lengths?.[1] ?? 60), Number(lengths?.[2] ?? 60), nOutcomes);
        const missing = (schema.required ?? Object.keys(schema.properties)).filter(
          (k: string) => !(k in object) && k in schema.properties,
        );
        if (missing.length) return json(400, { error: { message: `fake cannot fill required keys: ${missing}` } });
        return json(200, {
          id: `chatcmpl-fake-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: JSON.stringify(object), reasoning: object.reasoning },
            },
          ],
          usage: { prompt_tokens: prompt.length >> 2, completion_tokens: 512, total_tokens: (prompt.length >> 2) + 512 },
        });
      }

      if (req.method === "POST" && url.pathname === "/api/v1/images") {
        record("image", await read());
        const buf = await png();
        return json(200, {
          created: Math.floor(Date.now() / 1000),
          data: [{ b64_json: buf.toString("base64"), media_type: "image/png" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0 },
        });
      }

      if (req.method === "POST" && url.pathname === "/api/v1/videos") {
        const body = await read();
        record("video", body);
        const id = `vid_${Math.random().toString(36).slice(2, 10)}`;
        jobs.set(id, {
          at: Date.now(),
          duration: Number(body.duration ?? 6),
          resolution: String(body.resolution ?? "480p"),
          prompt: String(body.prompt ?? ""),
        });
        return json(202, { id, polling_url: `${url.origin}/api/v1/videos/${id}`, status: "pending" });
      }

      const content = /^\/api\/v1\/videos\/([^/]+)\/content$/.exec(url.pathname);
      if (req.method === "GET" && content) {
        const job = jobs.get(content[1]!);
        if (!job) return json(404, { error: { message: "no such job" } });
        const file = (await replay(job.prompt, job.resolution)) ?? (await clip(job.duration, job.resolution));
        res.writeHead(200, { "content-type": "video/mp4" });
        return void createReadStream(file).pipe(res);
      }

      const poll = /^\/api\/v1\/videos\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && poll) {
        const id = poll[1]!;
        const job = jobs.get(id);
        if (!job) return json(404, { error: { message: "no such job" } });
        const polling_url = `${url.origin}/api/v1/videos/${id}`;
        if (Date.now() - job.at < 1000) return json(200, { id, polling_url, status: "in_progress" });
        if (!MEDIA_DIR) await clip(job.duration, job.resolution); // ready before we advertise the URL
        return json(200, {
          id,
          generation_id: `gen-fake-${id}`,
          polling_url,
          status: "completed",
          unsigned_urls: [`${polling_url}/content?index=0`],
          usage: { cost: job.duration * (job.resolution === "768p" ? 0.08 : 0.05), is_byok: false },
        });
      }

      json(404, { error: { message: `fake openrouter: no route ${req.method} ${url.pathname}` } });
    } catch (e) {
      json(500, { error: { message: String(e) } });
    }
  });
  server.listen(port);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.FAKE_PORT ?? 4100);
  startFake(port);
  console.log(`fake openrouter on http://127.0.0.1:${port}`);
}
