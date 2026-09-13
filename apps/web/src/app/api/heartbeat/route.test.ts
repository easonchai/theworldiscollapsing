import { beforeEach, describe, expect, it, vi } from "vitest";
import { heartbeat } from "@/lib/data";
import { presenceCeiling } from "@/lib/limits";
import { POST } from "./route";

// The database is the thing being protected here, so it is the thing being counted.
vi.mock("@/lib/data", () => ({ heartbeat: vi.fn(async () => {}) }));

const beat = (headers: Record<string, string>) =>
  POST(new Request("http://station.local/api/heartbeat", { method: "POST", headers }));

const ours = (ip: string) => ({ "sec-fetch-site": "same-origin", "x-forwarded-for": ip });

beforeEach(() => vi.mocked(heartbeat).mockClear());

describe("POST /api/heartbeat", () => {
  it("refuses a call that is not from one of our pages", async () => {
    expect((await beat({ "sec-fetch-site": "cross-site", "x-forwarded-for": "1.1.1.1" })).status).toBe(403);
    expect((await beat({})).status).toBe(403);
    expect(heartbeat).not.toHaveBeenCalled();
  });

  it("records presence for our own page", async () => {
    expect((await beat(ours("203.0.113.1"))).status).toBe(204);
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });

  it("throttles a client to one write per 10 s, and still answers 204", async () => {
    expect((await beat(ours("203.0.113.2"))).status).toBe(204);
    for (let i = 0; i < 5; i++) expect((await beat(ours("203.0.113.2"))).status).toBe(204);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    // Another viewer is another client.
    expect((await beat(ours("203.0.113.3"))).status).toBe(204);
    expect(heartbeat).toHaveBeenCalledTimes(2);
  });

  it("caps total presence writes across the process, however many clients a caller rotates in", async () => {
    const ip = (i: number) => `198.51.100.${i}`;
    // A caller with a fresh IP on every request clears the per-key throttle every time, so only the
    // global ceiling is left standing between it and an unbounded number of writes.
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) statuses.push((await beat(ours(ip(i)))).status);
    expect(statuses.every((s) => s === 204)).toBe(true);
    const acceptedFirstBatch = vi.mocked(heartbeat).mock.calls.length;
    expect(acceptedFirstBatch).toBeLessThan(40);

    // More unique keys past the ceiling still answer 204, but stop adding writes: the ceiling, not
    // the per-key window, is what is binding here.
    for (let i = 40; i < 60; i++) expect((await beat(ours(ip(i)))).status).toBe(204);
    expect(vi.mocked(heartbeat).mock.calls.length).toBe(acceptedFirstBatch);
  });

  it("answers 204 without writing once the global ceiling is spent, so a caller can't measure it", async () => {
    while (presenceCeiling.take());
    expect((await beat(ours("203.0.113.9"))).status).toBe(204);
    expect(heartbeat).not.toHaveBeenCalled();
  });
});
