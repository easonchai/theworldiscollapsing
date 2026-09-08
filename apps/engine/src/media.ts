import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { put } from "@vercel/blob";

export interface MediaStore {
  /** Copy/upload a finished file and return the URL a browser can play it from. */
  storeFile(eventId: string, name: string, localPath: string): Promise<string>;
}

const contentType = (name: string) => (name.endsWith(".png") ? "image/png" : "video/mp4");

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

/** Static server for MEDIA_DIR: Range requests (seeking), CORS, no directory listing. */
export function startMediaServer(cfg: { dir: string; port: number }): http.Server {
  const root = path.resolve(cfg.dir);
  const server = http.createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "range");
    res.setHeader("access-control-expose-headers", "content-range, accept-ranges, content-length");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405).end();

    const rel = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
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
      res.writeHead(206, { "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
      if (req.method === "HEAD") return res.end();
      return void createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { "content-length": size });
    if (req.method === "HEAD") return res.end();
    createReadStream(file).pipe(res);
  });
  server.listen(cfg.port);
  return server;
}
