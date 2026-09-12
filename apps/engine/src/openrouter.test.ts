import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { makeOpenRouter, SchemaError } from "./openrouter.js";

// Fixtures copied from the shapes verified on 2026-09-09 (docs/RESEARCH.md → OpenRouter API shapes).

const CHAT = {
  id: "chatcmpl-123",
  object: "chat.completion",
  created: 1677652288,
  model: "openai/gpt-5-mini",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: '{"a":"hi","n":2}', reasoning: "I thought about it." },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 },
};

const SUBMIT = { id: "abc123", polling_url: "https://openrouter.ai/api/v1/videos/abc123", status: "pending" };
const IN_PROGRESS = { id: "abc123", polling_url: "https://openrouter.ai/api/v1/videos/abc123", status: "in_progress" };
const COMPLETED = {
  id: "abc123",
  generation_id: "gen-1234567890-abcdef",
  polling_url: "https://openrouter.ai/api/v1/videos/abc123",
  status: "completed",
  unsigned_urls: ["https://openrouter.ai/api/v1/videos/abc123/content?index=0"],
  usage: { cost: 0.25, is_byok: false },
};

const Schema = z.object({ a: z.string(), n: z.number(), extra: z.string().optional() });

/** Records every request and replies with the queued fixture. */
function fakeFetch(replies: unknown[]) {
  const calls: { url: string; body: any }[] = [];
  let i = 0;
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    const reply = replies[Math.min(i++, replies.length - 1)];
    if (reply instanceof Uint8Array) return new Response(Buffer.from(reply) as unknown as BodyInit, { status: 200 });
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const client = (f: ReturnType<typeof fakeFetch>) =>
  makeOpenRouter({ baseUrl: "https://openrouter.ai", apiKey: "k", imageModel: "google/gemini-3.1-flash-image", fetchImpl: f.impl });

const tmp = await mkdtemp(path.join(tmpdir(), "twic-or-"));
afterAll(() => rm(tmp, { recursive: true, force: true }));

describe("openrouter client", () => {
  it("sends a strict json_schema with require_parameters and parses object, reasoning and usage", async () => {
    const f = fakeFetch([CHAT]);
    const r = await client(f).chatJson("Thing", Schema, [{ role: "user", content: "go" }], {
      model: "openai/gpt-5-mini",
      reasoning: { effort: "medium" },
    });
    expect(r.object).toEqual({ a: "hi", n: 2 });
    expect(r.reasoning).toBe("I thought about it.");
    expect(r.usage).toEqual({ prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 });

    const body = f.calls[0]!.body;
    expect(f.calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("Thing");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.reasoning).toEqual({ effort: "medium" });
    // strict mode: every property required, no extras, no $schema key
    const schema = body.response_format.json_schema.schema;
    expect(schema.$schema).toBeUndefined();
    expect(schema.required.sort()).toEqual(["a", "extra", "n"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("throws SchemaError when the model's JSON does not match", async () => {
    const bad = { ...CHAT, choices: [{ ...CHAT.choices[0], message: { role: "assistant", content: '{"a":"hi"}' } }] };
    const f = fakeFetch([bad]);
    await expect(
      client(f).chatJson("Thing", Schema, [{ role: "user", content: "go" }], { model: "m" }),
    ).rejects.toBeInstanceOf(SchemaError);
  });

  it("submits a video job and polls past in_progress to the download url", async () => {
    const f = fakeFetch([SUBMIT, IN_PROGRESS, COMPLETED]);
    const or = client(f);
    const id = await or.submitVideo({ model: "minimax/hailuo-3-max", prompt: "p", duration: 6, resolution: "480p" });
    expect(id).toBe("abc123");
    const { url } = await or.pollVideo(id, { intervalMs: 1, timeoutMs: 5_000 });
    expect(url).toBe("https://openrouter.ai/api/v1/videos/abc123/content?index=0");
    expect(f.calls.map((c) => c.url)).toEqual([
      "https://openrouter.ai/api/v1/videos",
      "https://openrouter.ai/api/v1/videos/abc123",
      "https://openrouter.ai/api/v1/videos/abc123",
    ]);
  });

  it("fails a job that reports failed", async () => {
    const f = fakeFetch([{ id: "abc123", status: "failed", error: "Content policy violation" }]);
    await expect(client(f).pollVideo("abc123", { intervalMs: 1, timeoutMs: 100 })).rejects.toThrow(
      /failed: Content policy violation/,
    );
  });

  it("downloads bytes to a file and decodes a generated image", async () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 4]);
    const f = fakeFetch([bytes]);
    const out = path.join(tmp, "clip.mp4");
    await client(f).download("https://openrouter.ai/api/v1/videos/abc123/content?index=0", out);
    expect([...(await readFile(out))]).toEqual([0, 1, 2, 3, 4]);

    const g = fakeFetch([
      { created: 1, data: [{ b64_json: Buffer.from("png-bytes").toString("base64"), media_type: "image/png" }], usage: { cost: 0.04 } },
    ]);
    expect((await client(g).generateImage("key art")).toString()).toBe("png-bytes");
    expect(g.calls[0]!.url).toBe("https://openrouter.ai/api/v1/images");
    expect(g.calls[0]!.body.model).toBe("google/gemini-3.1-flash-image");
  });
});
