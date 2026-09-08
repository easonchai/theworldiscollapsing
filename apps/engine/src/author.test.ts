import { describe, expect, it } from "vitest";
import { makeAuthor } from "./author.js";
import { makeOpenRouter, SchemaError } from "./openrouter.js";
import type { AuthorCtx } from "./machine.js";

const CTX: AuthorCtx = { channelId: "sports", seq: 3, canon: ["Week 2: Northgate won."], firstHalfSec: 60, secondHalfSec: 60 };

const shot = (seconds: number) => ({ prompt: "wide stadium shot", seconds });

const good = {
  title: "Matchday 3",
  premise: "Level at the break.",
  outcomes: ["Home win", "Away win"],
  firstHalf: [shot(15), shot(15), shot(15), shot(15)],
  branches: [[shot(15)], [shot(15)]],
  ticker: ["Sold out"],
  canonUpdates: [["Home won."], ["Away won."]],
  reasoning: "inline",
};
// one branch for two outcomes: fails Authored's refine
const bad = { ...good, branches: [[shot(15)]] };

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
    model: "openai/gpt-6-astra",
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
    expect(f.calls[0]!.model).toBe("openai/gpt-6-astra");
  });

  it("retries once with the validation error appended, then succeeds", async () => {
    const f = chatFetch([bad, good]);
    const a = await author(f).author(CTX);
    expect(a.outcomes).toEqual(["Home win", "Away win"]);
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

  it("queries the subgraph for the previous event's pools and puts them in the prompt", async () => {
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
    expect(calls[0]!.body.variables.id).toMatch(/^0x[0-9a-f]{64}$/);
    const prompt = calls[1]!.body.messages.map((m: { content: string }) => m.content).join("\n");
    expect(prompt).toContain("total pool 5000000 across 4 bets");
    expect(prompt).toContain("outcome 0: YES 3000000 / NO 2000000");
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
