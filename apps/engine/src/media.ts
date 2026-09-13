import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { put } from "@vercel/blob";

export interface MediaStore {
  /** Copy/upload a finished file and return the URL a browser can play it from. */
  storeFile(eventId: string, name: string, localPath: string): Promise<string>;
}

/**
 * Published file name of branch `index`. The random suffix is what keeps an unrevealed ending
 * private: the URL exists nowhere but `Event.branchUrls`, which the web API discloses only from
 * REVEAL on. With the bare `branch-<i>.mp4` name anyone holding the (public) event id could
 * download every ending while betting was still open.
 */
export const branchFileName = (index: number) => `branch-${index}-${randomBytes(16).toString("hex")}.mp4`;

const contentType = (name: string) =>
  name.endsWith(".png") ? "image/png" : name.endsWith(".enc") ? "application/octet-stream" : "video/mp4";

export function makeMediaStore(cfg: {
  store: "local" | "blob";
  dir: string;
  baseUrl: string;
  token?: string;
}): MediaStore {
  if (cfg.store === "blob") {
    const token = cfg.token;
    if (!token) throw new Error("MEDIA_STORE=blob needs BLOB_READ_WRITE_TOKEN");
    return {
      async storeFile(eventId, name, localPath) {
        const res = await put(`${eventId}/${name}`, await readFile(localPath), {
          access: "public",
          token,
          contentType: contentType(name),
          allowOverwrite: true,
        });
        return res.url;
      },
    };
  }
  const root = path.resolve(cfg.dir);
  const base = cfg.baseUrl.replace(/\/$/, "");
  return {
    async storeFile(eventId, name, localPath) {
      const dest = path.join(root, eventId, name);
      await mkdir(path.dirname(dest), { recursive: true });
      if (path.resolve(localPath) !== dest) await copyFile(localPath, dest);
      return `${base}/${eventId}/${name}`;
    },
  };
}

/**
 * Delete the published media of events that have fallen out of the retention window, and return how
 * many directories went. Nothing re-reads a finished event's video, so without this `MEDIA_DIR` grows
 * for as long as the engine runs (~11 MB per event with stub footage, far more at 480p/768p).
 * Idempotent: an already-swept event is not an error. Local store only.
 */
export async function pruneEventMedia(dir: string, eventIds: string[]): Promise<number> {
  const root = path.resolve(dir);
  let removed = 0;
  for (const id of eventIds) {
    // Only ever delete a directory named like an event id, never `.work` and never a traversal.
    if (!/^0x[0-9a-f]{64}$/i.test(id)) continue;
    const target = path.join(root, id);
    try {
      await stat(target);
    } catch {
      continue;
    }
    await rm(target, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/**
 * Delete every directory left under `media/.work/` and report how many there were and how many
 * bytes they held. Call once at startup, after the pidfile is claimed and before anything is
 * authored or rendered: a directory here at boot belongs to no live session, because the engine is
 * the only writer and `claimPidFile` guarantees one engine per MEDIA_DIR. Both render
 * implementations sweep their own per-event directory in a `finally`, which a signal never runs; a
 * SIGTERM mid-render left four such directories behind on 2026-09-12, 81 MB (ticket 22), and
 * SIGKILL, a panic or a power cut leak the same way with no handler able to catch them. A missing
 * `.work/` (first boot) is not an error. Safe by construction rather than by regex: every path
 * joined here comes from a `readdir` of `dir` itself, never from outside input, so there is nothing
 * to traverse out with.
 */
export async function sweepWorkDir(dir: string): Promise<{ dirs: number; bytes: number }> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { dirs: 0, bytes: 0 };
  }
  let dirs = 0;
  let bytes = 0;
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    bytes += await dirBytes(target);
    await rm(target, { recursive: true, force: true });
    dirs++;
  }
  return { dirs, bytes };
}

async function dirBytes(target: string): Promise<number> {
  const s = await stat(target);
  if (!s.isDirectory()) return s.size;
  let total = 0;
  for (const entry of await readdir(target, { withFileTypes: true })) total += await dirBytes(path.join(target, entry.name));
  return total;
}

/** Body of `POST /internal/reveal-key`, sent by the Chainlink CRE confidential workflow. */
export type RevealKey = { eventId: string; outcome: number; key: string };

/** Constant-time compare of two secrets of any length. */
const sameSecret = (a: string, b: string) =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

/** Static server for MEDIA_DIR: Range requests (seeking), CORS, no directory listing. */
export function startMediaServer(cfg: {
  dir: string;
  port: number;
  /** BRANCH_SEAL=1 only: internal endpoint that accepts the released winning-branch key. */
  reveal?: { secret: string; handle(body: RevealKey): Promise<{ url: string }> };
}): http.Server {
  const root = path.resolve(cfg.dir);
  const server = http.createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "range");
    res.setHeader("access-control-expose-headers", "content-range, accept-ranges, content-length");
    if (req.method === "OPTIONS") return res.writeHead(204).end();

    if (cfg.reveal && req.method === "POST" && req.url === "/internal/reveal-key") {
      const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!sameSecret(auth, cfg.reveal.secret)) return res.writeHead(401).end();
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as RevealKey;
        if (typeof body.eventId !== "string" || typeof body.outcome !== "number" || typeof body.key !== "string") {
          throw new Error("expected { eventId, outcome, key }");
        }
        const out = await cfg.reveal.handle(body);
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
      } catch (e) {
        return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: String(e) }));
      }
    }

    if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405).end();

    // A malformed percent-escape (`/%E0%A4%A`) makes decodeURIComponent throw. Unhandled inside an
    // async request handler that is a crashed engine, not a bad request: answer 400 and keep serving.
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      return res.writeHead(400).end();
    }
    const file = path.resolve(root, `.${rel}`);
    if (file !== root && !file.startsWith(root + path.sep)) return res.writeHead(403).end();

    let size: number;
    try {
      const s = await stat(file);
      if (!s.isFile()) return res.writeHead(404).end(); // no directory listing
      size = s.size;
    } catch {
      return res.writeHead(404).end();
    }

    res.setHeader("accept-ranges", "bytes");
    res.setHeader("content-type", contentType(file));

    /**
     * A file that passed `stat` can still fail to open (permissions, deleted mid-flight, disk
     * error), and an unhandled `error` on the stream or the response takes the whole engine down.
     * Headers go out only once the fd is open — `writeHead` flushes immediately — so a failure can
     * still answer 500 instead of a truncated 200.
     */
    const sendFile = (status: number, headers: http.OutgoingHttpHeaders, opts?: { start: number; end: number }) => {
      const stream = createReadStream(file, opts);
      stream.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(500).end()));
      res.on("error", () => stream.destroy());
      stream.once("open", () => {
        res.writeHead(status, headers);
        stream.pipe(res);
      });
    };

    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range) {
      let start = range[1] === "" ? size - Number(range[2]) : Number(range[1]);
      let end = range[1] === "" || range[2] === "" ? size - 1 : Number(range[2]);
      start = Math.max(0, start);
      end = Math.min(size - 1, end);
      if (start > end) {
        res.setHeader("content-range", `bytes */${size}`);
        return res.writeHead(416).end();
      }
      if (req.method === "HEAD") {
        return res
          .writeHead(206, { "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 })
          .end();
      }
      return sendFile(206, { "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 }, { start, end });
    }
    if (req.method === "HEAD") return res.writeHead(200, { "content-length": size }).end();
    sendFile(200, { "content-length": size });
  });
  /**
   * A taken port (a second engine, or a node child that outlived a SIGKILLed `tsx` wrapper) emits
   * an unhandled `error` on the server, which takes the whole engine down with a raw stack trace
   * before any channel work starts. One sentence naming the port instead.
   */
  server.on("error", (e: NodeJS.ErrnoException) => {
    console.error(
      new Date().toISOString(),
      `media server cannot listen on port ${cfg.port}: ${e.code ?? e.message}`,
    );
    process.exit(1);
  });
  server.listen(cfg.port);
  return server;
}
