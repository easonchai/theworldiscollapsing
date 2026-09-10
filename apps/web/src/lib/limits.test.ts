import { describe, expect, it } from "vitest";
import { perKeyLimiter, windowLimiter } from "./limits";

describe("perKeyLimiter", () => {
  it("accepts one call per key per window", () => {
    const limit = perKeyLimiter(10_000);
    const t = 1_000_000;
    expect(limit.take("1.2.3.4", t)).toBe(true);
    expect(limit.take("1.2.3.4", t + 9_999)).toBe(false);
    expect(limit.take("1.2.3.4", t + 10_000)).toBe(true);
  });

  it("keeps one caller's window off another's", () => {
    const limit = perKeyLimiter(10_000);
    expect(limit.take("a", 0)).toBe(true);
    expect(limit.take("b", 0)).toBe(true);
  });

  it("sweeps expired keys instead of growing forever", () => {
    const limit = perKeyLimiter(10, 4);
    for (let i = 0; i < 100; i++) expect(limit.take(`ip-${i}`, i * 100)).toBe(true);
    // Everything that came before is long expired, so the newest key is still tracked.
    expect(limit.take("ip-99", 99 * 100 + 1)).toBe(false);
  });
});

describe("windowLimiter", () => {
  it("caps the total across every caller", () => {
    const limit = windowLimiter(30, 3_600_000);
    for (let i = 0; i < 30; i++) expect(limit.take(1000 + i)).toBe(true);
    expect(limit.take(2000)).toBe(false);
  });

  it("lets the window roll", () => {
    const limit = windowLimiter(2, 1000);
    expect(limit.take(0)).toBe(true);
    expect(limit.take(500)).toBe(true);
    expect(limit.take(900)).toBe(false);
    expect(limit.take(1001)).toBe(true);
  });
});
