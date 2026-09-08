import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Authored } from "./authored.js";
import type { Author, EventRow, Render } from "./machine.js";
import { branchFileName, type MediaStore } from "./media.js";

// Day-2 stand-ins. Real authoring (GPT-6 Astra) and rendering (MiniMax via OpenRouter) replace these on day 3.

const shot = (prompt: string) => ({ prompt, seconds: 6 });

// Outcome lists are 3 to 5 long, the shape Authored enforces (PRD: three to five markets).
const CANNED: Record<string, (seq: number) => Authored> = {
  sports: (seq) => ({
    title: `Matchday ${seq}: Manchester United vs Chelsea`,
    premise: "League fixture at Old Trafford. Level at half time.",
    outcomes: ["Manchester United win", "Chelsea win", "Draw"],
    firstHalf: [shot("kickoff"), shot("midfield battle"), shot("half-time whistle, 0-0")],
    branches: [[shot("United score late")], [shot("Chelsea score late")], [shot("full time, still level")]],
    cards: [{ afterShot: 1, title: "Half time", stats: ["Possession 51-49", "Shots on target 2-2"] }],
    ticker: ["Old Trafford sold out", "Both managers under pressure"],
    canonUpdates: [
      [`Matchday ${seq}: United beat Chelsea.`],
      [`Matchday ${seq}: Chelsea beat United at Old Trafford.`],
      [`Matchday ${seq}: United and Chelsea drew.`],
    ],
    reasoning: "stub",
  }),
  politics: (seq) => ({
    title: `Election night ${seq}`,
    premise: "Three candidates, results too close to call at the half.",
    outcomes: ["Incumbent holds", "Challenger wins", "Recount ordered"],
    firstHalf: [shot("polls close"), shot("early count neck and neck")],
    branches: [[shot("incumbent declared")], [shot("challenger declared")], [shot("recount ordered")]],
    cards: [{ afterShot: 0, title: "The count so far", stats: ["Turnout 71%", "12 of 40 boxes counted"] }],
    ticker: ["Turnout at record high"],
    canonUpdates: [
      [`Election ${seq}: the incumbent held office.`],
      [`Election ${seq}: the challenger took office.`],
      [`Election ${seq}: the result went to a recount.`],
    ],
    reasoning: "stub",
  }),
  culture: (seq) => ({
    title: `Awards night ${seq}: Best Picture`,
    premise: "Three nominees. Envelope not yet opened.",
    outcomes: ["Nominee A", "Nominee B", "Nominee C"],
    firstHalf: [shot("red carpet"), shot("nominees announced")],
    branches: [[shot("A wins")], [shot("B wins")], [shot("C wins")]],
    cards: [{ afterShot: 0, title: "Best Picture", stats: ["3 nominees", "Last year: an upset"] }],
    ticker: ["Upset expected"],
    canonUpdates: [[`Awards ${seq}: A won.`], [`Awards ${seq}: B won.`], [`Awards ${seq}: C won.`]],
    reasoning: "stub",
  }),
  region: (seq) => ({
    title: `Council vote ${seq}: the harbour bill`,
    premise: "A contested vote on the waterfront redevelopment.",
    outcomes: ["Bill passes", "Bill fails", "Vote deferred"],
    firstHalf: [shot("council convenes"), shot("debate")],
    branches: [[shot("bill passes")], [shot("bill fails")], [shot("vote deferred")]],
    cards: [{ afterShot: 0, title: "The harbour bill", stats: ["18 councillors seated", "Third reading"] }],
    ticker: ["Protesters outside city hall"],
    canonUpdates: [
      [`Vote ${seq}: the harbour bill passed.`],
      [`Vote ${seq}: the harbour bill failed.`],
      [`Vote ${seq}: the harbour bill vote was deferred.`],
    ],
    reasoning: "stub",
  }),
};

export const stubAuthor: Author = {
  async author({ channelId, seq }) {
    const make = CANNED[channelId];
    if (!make) throw new Error(`no canned events for channel ${channelId}`);
    return make(seq);
  },
};

const run = promisify(execFile);

/** Renders real, playable placeholder MP4s with ffmpeg (test pattern with a running clock) so the player works end to end without OpenRouter. */
export function stubRender(cfg: {
  workDir: string;
  store: MediaStore;
  firstHalfSec: number;
  secondHalfSec: number;
}): Render {
  async function file(ev: EventRow, name: string, sec: number, hueDeg: number) {
    const dir = path.join(cfg.workDir, ev.id);
    await mkdir(dir, { recursive: true });
    const out = path.join(dir, name);
    await run("ffmpeg", [
      "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", `testsrc2=s=854x480:r=24:d=${sec}`,
      "-vf", `hue=h=${hueDeg}`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      out,
    ]);
    return cfg.store.storeFile(ev.id, name, out);
  }
  return {
    async firstHalf(ev) {
      return { url: await file(ev, "first.mp4", cfg.firstHalfSec, 0), costUsd: 0 };
    },
    async branches(ev) {
      const urls = [];
      for (const [i] of ev.outcomes.entries()) urls.push(await file(ev, branchFileName(i), cfg.secondHalfSec, 60 + i * 90));
      // Same sweep as the real renderer: the work directory is dead weight once the files are stored.
      await rm(path.join(cfg.workDir, ev.id), { recursive: true, force: true });
      return { urls, costUsd: 0 };
    },
  };
}
