import { describe, expect, it } from "vitest";
import { clientIp, sameOrigin } from "./request";

const req = (headers: Record<string, string>) => new Request("http://station.local/api/heartbeat", { headers });

describe("sameOrigin", () => {
  it("trusts the browser's own fetch metadata", () => {
    expect(sameOrigin(req({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(sameOrigin(req({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(sameOrigin(req({ "sec-fetch-site": "none" }))).toBe(false);
  });

  it("falls back to an Origin that matches the host we were asked on", () => {
    expect(sameOrigin(req({ origin: "http://station.local", host: "station.local" }))).toBe(true);
    expect(sameOrigin(req({ origin: "http://station.local" }))).toBe(true); // host from the url
    expect(sameOrigin(req({ origin: "http://evil.example", host: "station.local" }))).toBe(false);
    expect(sameOrigin(req({ origin: "not a url", host: "station.local" }))).toBe(false);
  });

  it("refuses a request that claims neither", () => {
    expect(sameOrigin(req({}))).toBe(false);
  });
});

describe("clientIp", () => {
  it("takes the first hop of x-forwarded-for", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
    expect(clientIp(req({ "x-real-ip": "203.0.113.8" }))).toBe("203.0.113.8");
    expect(clientIp(req({}))).toBe("unknown");
  });
});
