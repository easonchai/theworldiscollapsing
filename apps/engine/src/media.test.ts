import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeMediaStore, startMediaServer } from "./media.js";

const BODY = "0123456789abcdefghij"; // 20 bytes
let dir: string;
let base: string;
let server: ReturnType<typeof startMediaServer>;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "twic-media-"));
  await mkdir(path.join(dir, "0xevent"), { recursive: true });
  await writeFile(path.join(dir, "0xevent", "first.mp4"), BODY);
  await writeFile(path.join(dir, "secret.txt"), "not served");
  server = startMediaServer({ dir: path.join(dir, "0xevent"), port: 0 });
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

describe("media server", () => {
  it("answers a range request with 206 and the right Content-Range", async () => {
    const res = await fetch(`${base}/first.mp4`, { headers: { range: "bytes=5-9" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 5-9/${BODY.length}`);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("5");
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.text()).toBe("56789");
  });

  it("clamps an open-ended range and serves the whole file without one", async () => {
    const open = await fetch(`${base}/first.mp4`, { headers: { range: "bytes=15-" } });
    expect(open.status).toBe(206);
    expect(open.headers.get("content-range")).toBe(`bytes 15-19/${BODY.length}`);
    expect(await open.text()).toBe("fghij");

    const whole = await fetch(`${base}/first.mp4`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(await whole.text()).toBe(BODY);
  });

  it("rejects path traversal and does not list directories", async () => {
    for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt"]) {
      const res = await fetch(`${base}${p}`);
      expect([403, 404]).toContain(res.status);
      expect(await res.text()).not.toContain("not served");
    }
    expect((await fetch(`${base}/`)).status).toBe(404);
  });
});

describe("local media store", () => {
  it("copies a file under the event id and returns its public url", async () => {
    const src = path.join(dir, "src.mp4");
    await writeFile(src, BODY);
    const store = makeMediaStore({ store: "local", dir: path.join(dir, "out"), baseUrl: "http://localhost:4000/" });
    expect(await store.storeFile("0xabc", "first.mp4", src)).toBe("http://localhost:4000/0xabc/first.mp4");
    const served = startMediaServer({ dir: path.join(dir, "out", "0xabc"), port: 0 });
    await once(served, "listening");
    const res = await fetch(`http://127.0.0.1:${(served.address() as AddressInfo).port}/first.mp4`);
    expect(await res.text()).toBe(BODY);
    served.close();
  });
});
