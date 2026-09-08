import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeMediaStore, startMediaServer } from "./media.js";
import { branchKey, parseRoot, revealBranch, seal, sealingStore, unseal } from "./seal.js";

const ROOT = parseRoot(`0x${"07".repeat(32)}`);
const EVENT = `0x${"ab".repeat(32)}` as const;
const OTHER = `0x${"cd".repeat(32)}` as const;
const PLAIN = Buffer.from("pretend this is branch-1.mp4");

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "twic-seal-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("branch key schedule", () => {
  it("is deterministic and separates branch, event and root", () => {
    expect(branchKey(ROOT, EVENT, 0)).toEqual(branchKey(ROOT, EVENT, 0));
    expect(branchKey(ROOT, EVENT, 0)).not.toEqual(branchKey(ROOT, EVENT, 1));
    expect(branchKey(ROOT, EVENT, 0)).not.toEqual(branchKey(ROOT, OTHER, 0));
    expect(branchKey(ROOT, EVENT, 0)).not.toEqual(branchKey(parseRoot(`0x${"08".repeat(32)}`), EVENT, 0));
    expect(branchKey(ROOT, EVENT, 0)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  // packages/cre/reveal-key derives the same keys inside the TEE from a viem-only reimplementation.
  // The scheme dies silently if the two drift, so both sides assert these exact vectors.
  it("matches the vectors the CRE workflow asserts", () => {
    expect(branchKey(ROOT, EVENT, 0)).toBe("0x8f5ca72428d63b4a71ac46b28dde4c8279f099bc193db966f03ec0be900fb3cb");
    expect(branchKey(ROOT, EVENT, 1)).toBe("0xc8d0be9d9fc04bf205029f2be501360f4aae319f53868c641358ce7e8b9129f1");
  });

  it("rejects a root that is not 32 bytes", () => {
    expect(() => parseRoot(`0x${"00".repeat(16)}`)).toThrow(/32 bytes/);
  });
});

describe("seal / unseal", () => {
  it("round-trips and fails closed on the wrong key or a tampered byte", () => {
    const key = branchKey(ROOT, EVENT, 1);
    const sealed = seal(PLAIN, key);
    expect(sealed).not.toEqual(PLAIN);
    expect(unseal(sealed, key)).toEqual(PLAIN);
    expect(() => unseal(sealed, branchKey(ROOT, EVENT, 0))).toThrow();
    const bad = Buffer.from(sealed);
    bad[20] ^= 1;
    expect(() => unseal(bad, key)).toThrow();
  });
});

describe("sealing store + reveal endpoint", () => {
  it("publishes ciphertext for branches, plaintext for everything else, and only reveals with the right key", async () => {
    const root = path.join(dir, "media");
    const store = sealingStore(makeMediaStore({ store: "local", dir: root, baseUrl: "http://x" }), ROOT);

    const src = path.join(dir, "branch-1.mp4");
    await writeFile(src, PLAIN);
    const first = path.join(dir, "first.mp4");
    await writeFile(first, PLAIN);

    expect(await store.storeFile(EVENT, "branch-1.mp4", src)).toBe(`http://x/${EVENT}/branch-1.mp4.enc`);
    expect(await store.storeFile(EVENT, "first.mp4", first)).toBe(`http://x/${EVENT}/first.mp4`);

    // the served branch file is ciphertext; the plaintext beside it is gone
    const served = await readFile(path.join(root, EVENT, "branch-1.mp4.enc"));
    expect(served).not.toEqual(PLAIN);
    await expect(readFile(path.join(root, EVENT, "branch-1.mp4"))).rejects.toThrow();

    // reveal over the internal endpoint, exactly as the CRE workflow calls it
    const server = startMediaServer({
      dir: root,
      port: 0,
      reveal: {
        secret: "s3cret",
        async handle({ eventId, outcome, key }) {
          return { url: await revealBranch(root, eventId, outcome, key) };
        },
      },
    });
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/reveal-key`;
    const post = (key: string, secret: string) =>
      fetch(base, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ eventId: EVENT, outcome: 1, key }),
      });

    const right = branchKey(ROOT, EVENT, 1);
    expect((await post(right, "wrong")).status).toBe(401);
    expect((await post(branchKey(ROOT, EVENT, 0), "s3cret")).status).toBe(400);
    expect((await post(right, "s3cret")).status).toBe(200);
    expect(await readFile(path.join(root, EVENT, "branch-1.mp4"))).toEqual(PLAIN);

    // eventId and outcome become a path, so they are validated before the join
    const traversal = await fetch(base, {
      method: "POST",
      headers: { authorization: "Bearer s3cret" },
      body: JSON.stringify({ eventId: "../../../etc/passwd", outcome: 1, key: right }),
    });
    expect(traversal.status).toBe(400);

    server.close();
  });
});
