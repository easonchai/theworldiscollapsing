import { describe, expect, it } from "vitest";
import { clock, splitClock } from "./clock";

describe("clock", () => {
  it("pads every field so the digits never move", () => {
    expect(clock(15_000)).toBe("00:15");
    expect(clock(65_000)).toBe("01:05");
    expect(clock(3_725_000)).toBe("1:02:05");
    expect(clock(-1)).toBe("00:00");
  });
});

describe("splitClock", () => {
  it("separates the fields that are not counting from the one that is", () => {
    expect(splitClock("00:15")).toEqual(["00:", "15"]);
    expect(splitClock("01:05")).toEqual(["0", "1:05"]);
    expect(splitClock("10:00")).toEqual(["", "10:00"]);
    expect(splitClock("1:02:05")).toEqual(["", "1:02:05"]);
  });

  it("always keeps a digit alive, and never drops a character", () => {
    for (const t of ["00:00", "00:15", "01:05", "10:00", "--:--"]) {
      const [dead, live] = splitClock(t);
      expect(dead + live).toBe(t);
      expect(live.length).toBeGreaterThan(0);
    }
  });
});
