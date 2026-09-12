import { Authored, type Shot } from "./authored.js";
import { eventIdFor, type Author, type AuthorCtx } from "./machine.js";
import { SchemaError, type OpenRouter, type Reasoning } from "./openrouter.js";

/**
 * The house style of each channel: what it is about, what the camera is, how fast it moves, what is
 * on screen. This is the base prompt — the shot text the model writes on top of it is what reaches
 * the video vendor, prefixed again in `render.ts` (`clipPrompt`) so the style survives model drift.
 */
export const CHANNEL_STYLE: Record<string, string> = {
  sports: `Sports.
Subject: an actual competition in progress — a football match, an MMA bout, a sprint final, a basketball game, a cycling stage, a tennis match. Named clubs, fighters and athletes who recur from event to event.
Camera: broadcast positions — main side camera, tight follow, touchline, goal-line, cage-side, finish line.
On screen: players in kit, officials, a full crowd, floodlights or daylight exactly as they are.
Pacing: real time, at the speed the sport is actually played.`,
  politics: `Politics.
Subject: what is happening in the world right now, mirrored into this fictional world — global warming and climate, elections, inflation, migration, strikes, summits, wars, pandemics, tech regulation. Named parties, ministers and crises that recur.
Camera: a fixed studio camera, or a handheld news camera in the field.
On screen: a newsroom studio whose big screen behind the anchor carries CHARTS, GRAPHS, MAPS or GAUGES — bars rising, a line climbing, a map with red zones, a thermometer gauge — cut with field reportage: press conferences, the parliament floor, protests, flooded streets, wildfire lines. Data visuals are this channel's visual language: say what the chart shows in almost every studio shot. The numbers do not have to be legible.
Pacing: real time, live news.`,
  culture: `Culture.
Subject: live coverage of an event as it happens — award stages, red carpets, concert stages, gallery openings, talent-show finals. Named artists, hosts and works that recur.
Camera: an ENG press-pool camera — shoulder-held in the scrum, or a hard camera locked on the stage.
On screen: the stage and its lighting exactly as it is, presenters, nominees, the audience, photographers.
Pacing: real time, as it happens.`,
  region: `Region: one coastal city state.
Subject: local-news field reportage — the council chamber, harbour works, the seawall, the ferry, the market, storm damage, festivals, local disputes. The same landmarks, streets and councillors recur.
Camera: a reporter's news camera in the field, natural light.
On screen: the place itself, residents, workers, the weather as it is.
Pacing: real time.`,
};

const system = (ctx: AuthorCtx) => `You are the showrunner of a fictional world broadcast as four live television channels: sports, politics, culture, region. The world is continuous: every event you write happens after everything in the canon log and must not contradict it.

This channel: ${CHANNEL_STYLE[ctx.channelId] ?? ctx.channelId}

You write one event as a single continuous broadcast in two parts.

House style, every shot on every channel: this is real footage as broadcast on television, in real time. Never cinematic, never slow motion, no film look, no dramatic colour grading, no drone hero shots, no music-video camera moves. It looks like the thing actually happening, not like a film about it.

Hard rules:
- The first half MUST end level. No outcome may be foreshadowed, hinted at or made more likely by anything in it. A viewer who has seen the whole first half must still believe every outcome is possible.
- Give exactly ${ctx.nOutcomes} outcomes. They are mutually exclusive and exhaustive: exactly one happens. Label them plainly, so nobody can misread which one they are betting on.
- title and outcomes are read by a viewer next to their money. Write the name of the thing only. No numbering, no "Event ${ctx.seq}", no "Outcome 1", no prefix of any kind.
- One second-half shot list per outcome, in the same order as the outcomes. Each branch continues from the last frame of the first half.
- Every shot is a video prompt of 6 to 15 seconds. Write one or two plain sentences, no paragraphs: start with the camera position of this channel, then what it sees. Short prompts render closer to what you asked for.
- No dialogue, no captions, no subtitles. On-screen graphics — scoreboards, tickers, charts, lower thirds — may be in frame as broadcast furniture, but nothing may depend on them being read: rendered text comes out as gibberish. On politics, put a chart, graph, map or gauge in shot in most studio shots and say what it shows.
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

// Must match `Shot.seconds`'s floor in authored.ts: Reactor fast-h3 rejects anything under
// 5.167 s, so trimming a shot down to 5 here would only move the failure to `enqueue`.
const MIN_SHOT_SEC = 6;
const OVERRUN = 1.1; // the tolerance the prompt asks for, enforced here because video is billed per second

const totalSec = (shots: Shot[]): number => shots.reduce((n, s) => n + s.seconds, 0);

/**
 * The prompt's own scaffolding leaks into the two strings a bettor reads next to their money:
 * two of the four REAL events came back as `Outcome 1 — Harbour City win` and
 * `Event 43 — National Film Gala` (ticket 29). Stripped here rather than asked for again, for the
 * same reason the shot lengths are: the model is inconsistent about it across calls.
 *
 * The separator is required, so a title that merely starts with one of these words survives
 * ("Option B", "Eventual Recount"). A string that is nothing but scaffolding is left alone.
 */
const SCAFFOLD = /^\s*(?:outcome|option|result|event|episode|part)\b\s*#?\d*\s*[-–—:.)]\s*/i;

function unlabel(s: string): string {
  const out = s.replace(SCAFFOLD, "").trim();
  return out.length ? out : s.trim();
}

/**
 * The model treats the target durations as a suggestion — a real probe against gpt-6-astra returned
 * 26 s of first half against a 15 s target and branches of 22/16/20 s against 10 s. Video is billed
 * per second, so the target has to be enforced in code, not in the prompt: trim the last shot down
 * to the 5 s floor, then drop trailing shots, keeping at least one. Under-length is left alone.
 */
function clampToTarget(shots: Shot[], targetSec: number): Shot[] {
  const cap = targetSec * OVERRUN;
  const out = shots.map((s) => ({ ...s }));
  while (totalSec(out) > cap) {
    const last = out[out.length - 1]!;
    if (last.seconds > MIN_SHOT_SEC) {
      last.seconds = Math.max(MIN_SHOT_SEC, last.seconds - Math.ceil(totalSec(out) - cap));
      continue;
    }
    if (out.length === 1) break; // one shot at the floor: nothing left to give
    out.pop();
  }
  return out;
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
          const fit = (shots: Shot[], targetSec: number, where: string): Shot[] => {
            if (totalSec(shots) <= targetSec * OVERRUN) return shots;
            const kept = clampToTarget(shots, targetSec);
            log("shot list over target, clamped", {
              channelId: ctx.channelId,
              seq: ctx.seq,
              where,
              targetSec,
              beforeSec: totalSec(shots),
              afterSec: totalSec(kept),
              beforeShots: shots.length,
              afterShots: kept.length,
            });
            return kept;
          };
          const a = { ...r.object, reasoning: r.reasoning ?? r.object.reasoning };
          if (a.outcomes.length !== ctx.nOutcomes) {
            throw new SchemaError(`expected exactly ${ctx.nOutcomes} outcomes, got ${a.outcomes.length}`);
          }
          const firstHalf = fit(a.firstHalf, ctx.firstHalfSec, "firstHalf");
          return {
            ...a,
            title: unlabel(a.title),
            outcomes: a.outcomes.map(unlabel),
            firstHalf,
            branches: a.branches.map((b, i) => fit(b, ctx.secondHalfSec, `branch ${i}`)),
            // Dropping trailing shots can orphan a card's cue; keep it on the last shot that survived.
            cards: a.cards.map((c) => ({ ...c, afterShot: Math.min(c.afterShot, firstHalf.length - 1) })),
          };
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
