import { describe, expect, it } from "vitest";
import { CHANNEL_STYLE } from "./author.js";
import { authored } from "./fake/openrouter.js";
import type { EventRow } from "./machine.js";
import { CHANNEL_PREFIX, clipPrompt, keyArtPrompt, STYLE_SUFFIX } from "./render.js";

const CHANNELS = ["sports", "politics", "culture", "region"];

/**
 * The house style is a set of refusals, so the forbidden words legitimately appear in the prompt —
 * "Not cinematic", "No slow motion". What must never happen is one of them appearing as a request.
 */
function asksFor(text: string, look: string): boolean {
  for (const m of text.matchAll(new RegExp(`\\b${look}\\b`, "gi"))) {
    const before = text.slice(Math.max(0, m.index - 14), m.index).toLowerCase();
    if (!/\b(no|not|never|without)\b[\s,-]*$/.test(before)) return true;
  }
  return false;
}

const SHOT = "Main side camera at the halfway line, Harbour City break down the right, the keeper comes off his line.";

describe("clip prompts", () => {
  it("never asks the video model for a cinematic look or slow motion, on any channel", () => {
    for (const channelId of CHANNELS) {
      const built = clipPrompt(channelId, SHOT);
      for (const look of ["cinematic", "slow motion", "film look"]) {
        expect(asksFor(built, look), `${channelId}: ${look}`).toBe(false);
        expect(asksFor(CHANNEL_PREFIX[channelId]!, look), `${channelId} prefix: ${look}`).toBe(false);
        expect(asksFor(CHANNEL_STYLE[channelId]!, look), `${channelId} style: ${look}`).toBe(false);
      }
      // ...but it does say so out loud, which is the only way to say it: MiniMax has no negative prompt
      expect(built).toContain("No slow motion");
      expect(built).toContain("Not cinematic");
    }
  });

  it("puts the channel's footage type first and the universal constraints last", () => {
    for (const channelId of CHANNELS) {
      const built = clipPrompt(channelId, SHOT);
      expect(built.startsWith(CHANNEL_PREFIX[channelId]!)).toBe(true);
      expect(built.endsWith(STYLE_SUFFIX)).toBe(true);
      expect(built).toContain(SHOT);
    }
    // an unknown channel still gets a broadcast prefix and the same suffix
    const other = clipPrompt("weather", SHOT);
    expect(other).toContain("broadcast footage");
    expect(other.endsWith(STYLE_SUFFIX)).toBe(true);
  });

  it("tells the model to put charts on the politics studio screen", () => {
    expect(CHANNEL_PREFIX.politics).toMatch(/charts/i);
    expect(CHANNEL_PREFIX.politics).toMatch(/graphs/i);
    expect(clipPrompt("politics", SHOT)).toMatch(/charts and graphs/i);
  });

  it("stays under 600 characters even for a 300-character shot", () => {
    const long = "x".repeat(300);
    for (const channelId of [...CHANNELS, "weather"]) {
      expect(clipPrompt(channelId, long).length).toBeLessThanOrEqual(600);
    }
    // and for a shot far longer than any the author should write
    expect(clipPrompt("politics", "y".repeat(4000)).length).toBeLessThanOrEqual(600);
  });

  it("keeps the fake vendor's canned shots inside the house style, so a local soak is representative", () => {
    for (const channelId of CHANNELS) {
      const script = authored(channelId, 15, 10);
      const shots = [...script.firstHalf, ...script.branches.flat()];
      for (const { prompt } of shots) {
        const built = clipPrompt(channelId, prompt);
        for (const look of ["cinematic", "slow motion", "film look", "dolly", "push in", "drone", "crane"])
          expect(asksFor(built, look), `${channelId}: ${look} in "${built}"`).toBe(false);
      }
    }
    // politics is the channel that must show data, so its canned beat has to carry a chart
    expect(authored("politics", 15, 10).firstHalf[0]!.prompt).toMatch(/chart|graph|map|gauge/i);
  });

  it("seeds the key art in the same house style as the clips it seeds", () => {
    const ev = (channelId: string) =>
      ({ channelId, title: "Heat Emergency Debate", premise: "The chamber votes on the coastal levy." }) as EventRow;
    for (const channelId of CHANNELS) {
      const art = keyArtPrompt(ev(channelId));
      expect(art.startsWith(CHANNEL_PREFIX[channelId]!)).toBe(true);
      expect(asksFor(art, "cinematic")).toBe(false);
      expect(art).toContain("Heat Emergency Debate");
    }
    expect(keyArtPrompt(ev("politics"))).toMatch(/charts and graphs/i);
  });
});
