import { Authored } from "./authored.js";
import { eventIdFor, type Author, type AuthorCtx } from "./machine.js";
import { SchemaError, type OpenRouter, type Reasoning } from "./openrouter.js";

const CHANNEL_BIBLE: Record<string, string> = {
  sports: "Sports: leagues, fixtures, finals, transfers. Named clubs and players who recur week to week.",
  politics: "Politics: elections, votes of no confidence, cabinet reshuffles, referenda. Named parties and figures.",
  culture: "Culture: awards ceremonies, album releases, gallery openings, talent finals. Named artists and works.",
  region: "Region: a coastal city state — council votes, harbour works, storms, festivals, local disputes.",
};

const system = (ctx: AuthorCtx) => `You are the showrunner of a fictional world broadcast as four live television channels: sports, politics, culture, region. The world is continuous: every event you write happens after everything in the canon log and must not contradict it.

This channel: ${CHANNEL_BIBLE[ctx.channelId] ?? ctx.channelId}

You write one event as a single continuous broadcast in two parts.

Hard rules:
- The first half MUST end level. No outcome may be foreshadowed, hinted at or made more likely by anything in it. A viewer who has seen the whole first half must still believe every outcome is possible.
- Give 3 to 5 outcomes. They are mutually exclusive and exhaustive: exactly one happens. Label them plainly, so nobody can misread which one they are betting on.
- One second-half shot list per outcome, in the same order as the outcomes. Each branch continues from the last frame of the first half.
- Every shot is a video prompt of 5 to 15 seconds. Describe what the camera sees; no dialogue, no on-screen text, no captions or scoreboards (text cannot be rendered).
- The first-half shot seconds must total ${ctx.firstHalfSec} seconds (within 10%).
- Each branch's shot seconds must total ${ctx.secondHalfSec} seconds (within 10%).
- cards: 1 or 2 studio cards, the graphics the broadcast cuts to between first-half clips. Each has afterShot (the 0-based index of the first-half shot it follows, so it must be smaller than the number of first-half shots), a title under 48 characters, and exactly two short stat lines, also under 48 characters. Write them as a studio would: a heading and two numbers or facts about this event.
- ticker: 3 to 6 short broadcast strap lines, under 60 characters each.
- canonUpdates: one list per outcome, 1 to 3 flat factual sentences stating what became true in the world if that outcome happens. They are appended to the world log and every later event reads them.
- reasoning: two or three sentences on how this event follows from the canon and why the first half gives nothing away.

Return only the JSON object.`;

const user = (ctx: AuthorCtx, pools: string | null) =>
  [
    `Channel: ${ctx.channelId}`,
    `Event number: ${ctx.seq}`,
    ctx.canon.length ? `Canon so far (oldest first):\n${ctx.canon.map((l) => `- ${l}`).join("\n")}` : "Canon so far: none, this is the first event on this channel.",
    pools ? `Betting on the previous event (viewers put money here, lean into what they cared about):\n${pools}` : "",
    `Target lengths: first half ${ctx.firstHalfSec}s, each branch ${ctx.secondHalfSec}s.`,
  ]
    .filter(Boolean)
    .join("\n\n");

/**
 * Pool state of the last *settled* event on this channel. Best effort: authoring never fails
 * because the index is down.
 *
 * seq − 2, not seq − 1: this event is authored during seq − 1's betting window (the machine primes
 * the next production the moment betting opens), so seq − 1 has no bets yet and the subgraph has
 * not even indexed its creation. seq − 2 locked and resolved before seq − 1 went on air.
 */
async function previousPools(
  subgraphUrl: string,
  ctx: AuthorCtx,
  fetchImpl: typeof fetch,
  log: (msg: string, extra?: Record<string, unknown>) => void,
): Promise<string | null> {
  if (ctx.seq <= 2) return null;
  const id = eventIdFor(ctx.channelId, ctx.seq - 2);
  const quiet = (why: string) => {
    log("no previous pool state for authoring", { channelId: ctx.channelId, seq: ctx.seq, prev: ctx.seq - 2, id, why });
    return null;
  };
  try {
    const res = await fetchImpl(subgraphUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "query Prev($id: Bytes!) { event(id: $id) { totalPool betCount markets { outcomeIdx yesPool noPool } } }",
        variables: { id },
      }),
    });
    if (!res.ok) return quiet(`subgraph HTTP ${res.status}`);
    const ev = ((await res.json()) as any)?.data?.event;
    if (!ev?.markets?.length) return quiet("subgraph has no markets for that event");
    const lines = ev.markets
      .map((m: any) => `- outcome ${m.outcomeIdx}: YES ${m.yesPool} / NO ${m.noPool}`)
      .join("\n");
    return `total pool ${ev.totalPool} across ${ev.betCount} bets\n${lines}`;
  } catch (e) {
    return quiet(String(e).slice(0, 200));
  }
}

export function makeAuthor(cfg: {
  or: OpenRouter;
  model: string;
  reasoning?: Reasoning;
  subgraphUrl?: string;
  fetchImpl?: typeof fetch;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}): Author {
  const log = cfg.log ?? (() => {});
  return {
    async author(ctx) {
      const pools = cfg.subgraphUrl ? await previousPools(cfg.subgraphUrl, ctx, cfg.fetchImpl ?? fetch, log) : null;
      const messages = [
        { role: "system" as const, content: system(ctx) },
        { role: "user" as const, content: user(ctx, pools) },
      ];
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await cfg.or.chatJson("Authored", Authored, messages, {
            model: cfg.model,
            reasoning: cfg.reasoning,
          });
          return { ...r.object, reasoning: r.reasoning ?? r.object.reasoning };
        } catch (e) {
          // One correction round: hand the model its own validation errors. Then give up — produce() skips the event.
          if (attempt > 1 || !(e instanceof SchemaError)) throw e;
          messages.push({
            role: "user" as const,
            content: `Your previous answer was rejected by the schema validator:\n${e.message}\n\nReturn a corrected JSON object that satisfies every rule.`,
          });
        }
      }
    },
  };
}
