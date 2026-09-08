import { describe, expect, it } from "vitest";
import { channelIdents, identOf } from "./channels";

// The four channels the engine runs (docs/CONTRACTS.md, CHANNELS).
const CHANNELS = ["sports", "politics", "culture", "region"];

describe("identOf", () => {
  it("gives every channel its own accent and number", () => {
    const idents = CHANNELS.map(identOf);
    expect(new Set(idents.map((i) => i.accent)).size).toBe(CHANNELS.length);
    expect(new Set(idents.map((i) => i.num)).size).toBe(CHANNELS.length);
  });

  it("keeps the whole map distinct, so a new channel cannot reuse a look", () => {
    const all = Object.values(channelIdents);
    expect(new Set(all.map((i) => i.accent)).size).toBe(all.length);
    expect(new Set(all.map((i) => i.num)).size).toBe(all.length);
    expect(Object.keys(channelIdents).sort()).toEqual([...CHANNELS].sort());
  });

  it("falls back for a channel it has never heard of", () => {
    expect(identOf("weather")).toEqual(identOf("nothing-here"));
    expect(identOf("weather").accent).toBeTruthy();
  });
});
