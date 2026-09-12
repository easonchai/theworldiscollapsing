import { describe, expect, it } from "vitest";
import { CHANNEL_STYLE, makeAuthor } from "./author.js";
import { makeOpenRouter, SchemaError } from "./openrouter.js";
import { eventIdFor, type AuthorCtx } from "./machine.js";

const CTX: AuthorCtx = {
  channelId: "sports",
  seq: 3,
  canon: ["Week 2: Northgate won."],
  firstHalfSec: 60,
  secondHalfSec: 60,
  nOutcomes: 3,
};

const shot = (seconds: number) => ({ prompt: "wide stadium shot", seconds });

const good = {
  title: "Matchday 3",
  premise: "Level at the break.",
  outcomes: ["Home win", "Away win", "Draw"],
  firstHalf: [shot(15), shot(15), shot(15), shot(15)],
  branches: [[shot(15)], [shot(15)], [shot(15)]],
  cards: [{ afterShot: 1, title: "Half time", stats: ["Possession 51-49", "Shots 4-4"] }],
  ticker: ["Sold out"],
  canonUpdates: [["Home won."], ["Away won."], ["Level."]],
  reasoning: "inline",
};
// one branch for three outcomes: fails Authored's refine
const bad = { ...good, branches: [[shot(15)]] };
// two outcomes: passes the schema (min 2) but is the wrong count against nOutcomes: 3
const twoOutcomes = { ...good, outcomes: ["Home win", "Away win"], branches: [[shot(15)], [shot(15)]], canonUpdates: [["Home won."], ["Away won."]] };
// four outcomes, the right count against nOutcomes: 4
const good4 = {
  ...good,
  outcomes: ["Home win by 2+", "Home win by 1", "Away win", "Draw"],
  branches: [[shot(15)], [shot(15)], [shot(15)], [shot(15)]],
  canonUpdates: [["Home won big."], ["Home won."], ["Away won."], ["Level."]],
};

function chatFetch(objects: unknown[], reasoning: (string | null)[] = []) {
  const calls: any[] = [];
  const impl = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    const i = Math.min(calls.length - 1, objects.length - 1);
    return new Response(
      JSON.stringify({
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: JSON.stringify(objects[i]), reasoning: reasoning[i] ?? null },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const author = (f: { impl: typeof fetch }, subgraphUrl?: string) =>
  makeAuthor({
    or: makeOpenRouter({ baseUrl: "http://or", apiKey: "k", imageModel: "img", fetchImpl: f.impl }),
    model: "openai/gpt-5-mini",
    reasoning: { effort: "medium" },
    subgraphUrl,
    fetchImpl: f.impl,
  });

describe("author", () => {
  it("prompts with the channel, canon and target durations, and prefers the model's reasoning trace", async () => {
    const f = chatFetch([good], ["traced"]);
    const a = await author(f).author(CTX);
    expect(a.title).toBe("Matchday 3");
    expect(a.reasoning).toBe("traced");

    const prompt = f.calls[0]!.messages.map((m: { content: string }) => m.content).join("\n");
    expect(prompt).toContain("Channel: sports");
    expect(prompt).toContain("Week 2: Northgate won.");
    expect(prompt).toContain("first half 60s, each branch 60s");
    expect(prompt).toContain("Give exactly 3 outcomes");
    expect(prompt).toContain("cards: 1 or 2 studio cards");
    expect(f.calls[0]!.model).toBe("openai/gpt-5-mini");
  });

  it("gives every channel its house style and the never-cinematic rule", async () => {
    for (const channelId of ["sports", "politics", "culture", "region"]) {
      const f = chatFetch([good]);
      await author(f).author({ ...CTX, channelId });
      const sys: string = f.calls[0]!.messages[0]!.content;
      expect(sys).toContain(CHANNEL_STYLE[channelId]!);
      expect(sys).toContain("Never cinematic, never slow motion");
      expect(sys).toMatch(/real footage as broadcast on television, in real time/);
      // graphics are allowed in frame now, but nothing may depend on reading them
      expect(sys).toMatch(/nothing may depend on them being read/);
    }
  });

  it("tells politics to put charts on the screen, and sports to shoot an actual match", async () => {
    const politics = chatFetch([good]);
    await author(politics).author({ ...CTX, channelId: "politics" });
    const sys: string = politics.calls[0]!.messages[0]!.content;
    expect(sys).toMatch(/CHARTS, GRAPHS, MAPS or GAUGES/);
    expect(sys).toMatch(/chart, graph, map or gauge in shot in most studio shots/);
    expect(sys).toMatch(/global warming/i);

    const sports = chatFetch([good]);
    await author(sports).author({ ...CTX, channelId: "sports" });
    const sportsSys: string = sports.calls[0]!.messages[0]!.content;
    expect(sportsSys).toMatch(/an actual competition in progress/i);
    expect(sportsSys).toMatch(/broadcast positions/i);
    expect(sportsSys).toMatch(/real time/i);
  });

  it("rejects an outcome count that is not N_OUTCOMES, on every channel", async () => {
    for (const channelId of ["sports", "politics", "culture", "region"]) {
      const f = chatFetch([twoOutcomes, twoOutcomes]);
      await expect(author(f).author({ ...CTX, channelId, nOutcomes: 3 })).rejects.toBeInstanceOf(SchemaError);

      // three outcomes is a valid schema shape, but still the wrong count against nOutcomes: 4
      const f4 = chatFetch([good, good]);
      await expect(author(f4).author({ ...CTX, channelId, nOutcomes: 4 })).rejects.toBeInstanceOf(SchemaError);
    }
  });

  it("accepts a matching outcome count at nOutcomes: 4", async () => {
    const f = chatFetch([good4]);
    const a = await author(f).author({ ...CTX, nOutcomes: 4 });
    expect(a.outcomes).toHaveLength(4);
  });

  it("retries once when the count is wrong, then succeeds with a matching count", async () => {
    const f = chatFetch([good, good4]);
    const a = await author(f).author({ ...CTX, nOutcomes: 4 });
    expect(a.outcomes).toHaveLength(4);
    expect(f.calls).toHaveLength(2);
    const retry = f.calls[1]!.messages.at(-1);
    expect(retry.role).toBe("user");
    expect(retry.content).toContain("rejected by the schema validator");
    expect(retry.content).toContain("expected exactly 4 outcomes, got 3");
  });

  it("rejects a studio card that points past the first half", async () => {
    const f = chatFetch([{ ...good, cards: [{ afterShot: 9, title: "Half time", stats: ["a", "b"] }] }]);
    await expect(author(f).author(CTX)).rejects.toThrow(/afterShot/);
  });

  it("retries once with the validation error appended, then succeeds", async () => {
    const f = chatFetch([bad, good]);
    const a = await author(f).author(CTX);
    expect(a.outcomes).toEqual(["Home win", "Away win", "Draw"]);
    expect(f.calls).toHaveLength(2);
    const retry = f.calls[1]!.messages.at(-1);
    expect(retry.role).toBe("user");
    expect(retry.content).toContain("rejected by the schema validator");
    expect(retry.content).toContain("one branch and one canon update list per outcome");
  });

  it("throws after the second invalid answer instead of committing money", async () => {
    const f = chatFetch([bad, bad]);
    await expect(author(f).author(CTX)).rejects.toBeInstanceOf(SchemaError);
    expect(f.calls).toHaveLength(2);
  });

  it("clamps shot lists the model made too long — video is billed per second", async () => {
    // The shapes a real probe came back with at firstHalfSec=15 / secondHalfSec=10.
    const overlong = {
      ...good,
      firstHalf: [shot(10), shot(8), shot(8)], // 26s
      branches: [[shot(12), shot(10)], [shot(8), shot(8)], [shot(15), shot(5)]], // 22 / 16 / 20s
      cards: [{ afterShot: 2, title: "Half time", stats: ["Possession 51-49", "Shots 4-4"] }],
    };
    const logged: Array<Record<string, unknown>> = [];
    const f = chatFetch([overlong]);
    const a = await makeAuthor({
      or: makeOpenRouter({ baseUrl: "http://or", apiKey: "k", imageModel: "img", fetchImpl: f.impl }),
      model: "openai/gpt-5-mini",
      log: (_m, extra) => void logged.push(extra ?? {}),
    }).author({ ...CTX, firstHalfSec: 15, secondHalfSec: 10 });

    const total = (shots: { seconds: number }[]) => shots.reduce((n, s) => n + s.seconds, 0);
    expect(total(a.firstHalf)).toBeLessThanOrEqual(15 * 1.1);
    expect(a.firstHalf.length).toBeGreaterThanOrEqual(1);
    for (const b of a.branches) {
      expect(total(b)).toBeLessThanOrEqual(10 * 1.1);
      expect(b.length).toBeGreaterThanOrEqual(1);
    }
    for (const s of [...a.firstHalf, ...a.branches.flat()]) {
      expect(s.seconds).toBeGreaterThanOrEqual(5);
      expect(s.seconds).toBeLessThanOrEqual(15);
    }
    for (const c of a.cards) expect(c.afterShot).toBeLessThan(a.firstHalf.length);
    // one log line per adjusted list, with the seconds before and after
    expect(logged).toHaveLength(4);
    expect(logged[0]).toMatchObject({ where: "firstHalf", targetSec: 15, beforeSec: 26 });
    expect(logged[3]).toMatchObject({ where: "branch 2", targetSec: 10, beforeSec: 20 });
  });

  it("leaves a shot list that is within the target alone", async () => {
    const f = chatFetch([good]);
    const a = await author(f).author(CTX); // good is exactly 60s / 15s per branch against 60s targets
    expect(a.firstHalf).toEqual(good.firstHalf);
    expect(a.branches).toEqual(good.branches);
    expect(a.cards).toEqual(good.cards);
  });

  it("queries the last settled event (seq-2) for pools and puts them in the prompt", async () => {
    const calls: any[] = [];
    const impl = (async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url: String(url), body });
      if (String(url) === "http://subgraph") {
        return new Response(
          JSON.stringify({
            data: { event: { totalPool: "5000000", betCount: 4, markets: [{ outcomeIdx: 0, yesPool: "3000000", noPool: "2000000" }] } },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(good) } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await author({ impl }, "http://subgraph").author(CTX);
    expect(calls[0]!.url).toBe("http://subgraph");
    // seq-1 is still open for betting when this event is authored, so its pools are always empty:
    // the pool state that exists is the event before it.
    expect(calls[0]!.body.variables.id).toBe(eventIdFor(CTX.channelId, CTX.seq - 2));
    const prompt = calls[1]!.body.messages.map((m: { content: string }) => m.content).join("\n");
    expect(prompt).toContain("total pool 5000000 across 4 bets");
    expect(prompt).toContain("outcome 0: YES 3000000 / NO 2000000");
  });

  it("skips the subgraph for the first two events of a channel", async () => {
    const f = chatFetch([good]);
    await author(f, "http://subgraph").author({ ...CTX, seq: 2 });
    expect(f.calls).toHaveLength(1); // the model call only
  });

  it("authors anyway when the subgraph is down", async () => {
    const impl = (async (url: string | URL, init?: RequestInit) => {
      if (String(url) === "http://subgraph") throw new Error("ECONNREFUSED");
      return new Response(
        JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(good) } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    expect((await author({ impl }, "http://subgraph").author(CTX)).title).toBe("Matchday 3");
  });
});
