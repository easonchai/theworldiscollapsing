import { describe, expect, it } from "vitest";
import type { EventPublic } from "./public";
import { rotate, type ChannelView } from "./rotation";

const event = (id: string, over: Partial<EventPublic> = {}): EventPublic =>
  ({ id: `0x${id}`, seq: 1, state: "BETTING", outcome: null, ...over }) as EventPublic;

const settled = event("aa", { state: "PAUSE", outcome: 1 });
const nextUp = event("bb", { seq: 2 });

describe("rotate", () => {
  it("keeps a resolved event on the page when the channel moves on", () => {
    const view: ChannelView = { current: settled, pinned: null };
    expect(rotate(view, nextUp)).toEqual({ current: nextUp, pinned: settled });
  });

  it("takes fresher data for the event on air without pinning anything", () => {
    const view: ChannelView = { current: event("aa"), pinned: null };
    expect(rotate(view, settled)).toEqual({ current: settled, pinned: null });
  });

  it("drops an event nobody could have claimed from", () => {
    const view: ChannelView = { current: event("aa", { state: "SKIPPED" }), pinned: null };
    expect(rotate(view, nextUp)).toEqual({ current: nextUp, pinned: null });
  });

  it("holds an unclaimed pin across a second rotation", () => {
    const view: ChannelView = { current: event("bb", { seq: 2 }), pinned: settled };
    expect(rotate(view, event("cc", { seq: 3 }))).toEqual({ current: event("cc", { seq: 3 }), pinned: settled });
  });

  it("pins the newer of two resolved events", () => {
    const done = event("bb", { seq: 2, state: "DONE", outcome: 0 });
    expect(rotate({ current: done, pinned: settled }, event("cc", { seq: 3 })).pinned).toBe(done);
  });

  it("never puts the pinned event back on air", () => {
    const view: ChannelView = { current: nextUp, pinned: settled };
    expect(rotate(view, event("aa", { state: "DONE", outcome: 1 }))).toBe(view);
  });
});
