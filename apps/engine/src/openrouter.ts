import { writeFile } from "node:fs/promises";
import { z } from "zod";

// Fetch-based OpenRouter client. Shapes verified 2026-09-09, see docs/RESEARCH.md
// "OpenRouter API shapes": chat completions + structured outputs, POST /api/v1/videos
// (submit → poll → download) and POST /api/v1/images.

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type Reasoning = { effort?: "max" | "xhigh" | "high" | "medium" | "low" | "minimal"; max_tokens?: number };

export type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;

export type FrameImage = {
  type: "image_url";
  image_url: { url: string };
  frame_type: "first_frame" | "last_frame";
};

export type VideoRequest = {
  model: string;
  prompt: string;
  duration: number;
  resolution: string;
  aspect_ratio?: string;
  frame_images?: FrameImage[];
};

/** Model returned JSON that does not match the schema. Retryable by feeding the message back. */
export class SchemaError extends Error {}

/** `strict: true` requires every property listed in `required` and additionalProperties:false. */
function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) if (k !== "$schema") out[k] = strictify(v);
    if (out.type === "object" && out.properties) {
      out.required = Object.keys(out.properties as Record<string, unknown>);
      out.additionalProperties = false;
    }
    return out;
  }
  return node;
}

export function makeOpenRouter(cfg: {
  baseUrl: string;
  apiKey: string;
  imageModel: string;
  fetchImpl?: typeof fetch;
  /** Called with usage.cost (USD) after every chat completion that reports one. */
  onUsage?: (usd: number, model: string) => Promise<void>;
}) {
  const doFetch = cfg.fetchImpl ?? fetch;
  const base = cfg.baseUrl.replace(/\/$/, "");
  const headers = { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" };

  /**
   * Authoring is one blocking call in the middle of a channel's production loop, and it had no
   * deadline: a request that never answers stalled a probe for ten minutes on 2026-09-12 and would
   * have stalled a live channel for as long as the socket stayed open. Two minutes is well past the
   * slowest observed authoring call (about 40 s on gpt-5-mini at medium effort) and well short of
   * the betting window, so a hung provider costs one skipped event rather than the channel.
   */
  const TIMEOUT_MS = 120_000;

  async function post(path: string, body: unknown): Promise<any> {
    const res = await doFetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`POST ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  return {
    async chatJson<T>(
      schemaName: string,
      schema: z.ZodType<T>,
      messages: ChatMessage[],
      opts: { model: string; reasoning?: Reasoning },
    ): Promise<{ object: T; reasoning: string | null; usage: Usage }> {
      const json = await post("/api/v1/chat/completions", {
        model: opts.model,
        messages,
        response_format: {
          type: "json_schema",
          json_schema: { name: schemaName, strict: true, schema: strictify(z.toJSONSchema(schema, { io: "input" })) },
        },
        provider: { require_parameters: true },
        usage: { include: true }, // usage.cost in USD comes back with the response
        ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
      });
      if (typeof json?.usage?.cost === "number") await cfg.onUsage?.(json.usage.cost, opts.model);
      const message = json?.choices?.[0]?.message;
      if (typeof message?.content !== "string") throw new SchemaError("no message content in chat completion");
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.content);
      } catch (e) {
        throw new SchemaError(`content is not JSON: ${String(e)}`);
      }
      const result = schema.safeParse(parsed);
      if (!result.success) throw new SchemaError(z.prettifyError(result.error));
      const inline = (parsed as { reasoning?: unknown }).reasoning;
      return {
        object: result.data,
        reasoning: message.reasoning ?? (typeof inline === "string" ? inline : null),
        usage: json.usage ?? null,
      };
    },

    /** POST /api/v1/videos → 202 { id, polling_url, status }. */
    async submitVideo(req: VideoRequest): Promise<string> {
      const json = await post("/api/v1/videos", req);
      if (typeof json?.id !== "string") throw new Error(`videos: no job id in ${JSON.stringify(json).slice(0, 200)}`);
      return json.id;
    },

    /** GET /api/v1/videos/{id} until status completed; returns unsigned_urls[0]. */
    async pollVideo(jobId: string, o: { intervalMs: number; timeoutMs: number }): Promise<{ url: string }> {
      const deadline = Date.now() + o.timeoutMs;
      for (;;) {
        const res = await doFetch(`${base}/api/v1/videos/${jobId}`, { headers });
        if (!res.ok) throw new Error(`poll ${jobId}: HTTP ${res.status}`);
        const json: any = await res.json();
        if (json.status === "completed") {
          const url = json.unsigned_urls?.[0];
          if (typeof url !== "string") throw new Error(`poll ${jobId}: completed with no unsigned_urls`);
          return { url };
        }
        if (json.status !== "pending" && json.status !== "in_progress") {
          throw new Error(`video job ${jobId} ${json.status}: ${json.error ?? "no error field"}`);
        }
        if (Date.now() > deadline) throw new Error(`video job ${jobId} timed out after ${o.timeoutMs}ms`);
        await new Promise((r) => setTimeout(r, o.intervalMs));
      }
    },

    async download(url: string, path: string): Promise<void> {
      const res = await doFetch(url, { headers: { authorization: headers.authorization } });
      if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
      await writeFile(path, Buffer.from(await res.arrayBuffer()));
    },

    /** POST /api/v1/images → { data: [{ b64_json, media_type }] }. Base64 bytes, never a URL. */
    async generateImage(prompt: string): Promise<Buffer> {
      const json = await post("/api/v1/images", {
        model: cfg.imageModel,
        prompt,
        aspect_ratio: "16:9",
      });
      const b64 = json?.data?.[0]?.b64_json;
      if (typeof b64 !== "string") throw new Error("images: no b64_json in response");
      return Buffer.from(b64, "base64");
    },
  };
}

export type OpenRouter = ReturnType<typeof makeOpenRouter>;
