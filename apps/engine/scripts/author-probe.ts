// Reads the real author against the real OpenRouter, no DB, no chain, no Reactor.
// Answers two things ticket 29 left open: do the labels still come back as "Nominee A",
// and does the shot text still name a logo or a backdrop. Four events cost about $0.03 of
// OpenRouter and nothing of Reactor, so this is the cheap way to check a prompt change.
//
//   set -a; . apps/engine/.env; set +a; pnpm --dir apps/engine exec tsx scripts/author-probe.ts
//
// Spend here bypasses budget.charge, so World.spendUsd does not record it.
import { makeAuthor } from "../src/author.js";
import { makeOpenRouter } from "../src/openrouter.js";

let spent = 0;
const or = makeOpenRouter({
  baseUrl: "https://openrouter.ai",
  apiKey: process.env.OPENROUTER_API_KEY!,
  imageModel: "google/gemini-3.1-flash-image",
  onUsage: async (usd) => {
    spent += usd;
  },
});
const author = makeAuthor({ or, model: process.env.AUTHOR_MODEL ?? "openai/gpt-5-mini", reasoning: { effort: "medium" } });

const CANON: Record<string, string[]> = {
  culture: ["Event 42: the Harbour Film Prize went to Mira Sandoval for Low Tide.", "Event 43: Jun Park won best score at the National Film Gala."],
  sports: ["Week 1: Harbour City beat Northgate 2-1.", "Week 2: Northgate won away at Seacliff."],
  region: ["The seawall works overran by three weeks.", "The east ferry pier reopened after storm damage."],
  politics: ["The coastal levy passed its second reading.", "Inflation held at 4.1 percent for a third month."],
};

const TEXTY = /\b(logo|logos|sign|signs|signage|banner|banners|backdrop|step-and-repeat|scoreboard|ticker|lower third|name card|hoarding|placard|marquee|nameplate|caption|text|lettering|words?)\b/i;

for (const channelId of ["culture", "sports", "region", "politics"]) {
  const a = await author.author({
    channelId,
    seq: 44,
    nOutcomes: 3,
    canon: CANON[channelId]!,
    firstHalfSec: 15,
    secondHalfSec: 10,
  });
  console.log(`\n=== ${channelId} ===`);
  console.log(`title:    ${a.title}`);
  console.log(`outcomes: ${JSON.stringify(a.outcomes)}`);
  for (const s of a.firstHalf) console.log(`  first  ${s.seconds}s ${TEXTY.test(s.prompt) ? "[TEXTY]" : "       "} ${s.prompt}`);
  a.branches.forEach((b, i) => b.forEach((s) => console.log(`  br${i}    ${s.seconds}s ${TEXTY.test(s.prompt) ? "[TEXTY]" : "       "} ${s.prompt}`)));
}
console.log(`\nOpenRouter spend this probe: $${spent.toFixed(4)}`);
