import { beforeEach, describe, expect, it, vi } from "vitest";
import { heartbeat } from "@/lib/data";
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
});
