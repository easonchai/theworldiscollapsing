#!/usr/bin/env node
// node docs/readme.check.mjs
//
// The README makes two kinds of promise: a trust model a reviewer can hold us to, and a local run a
// teammate can paste. Both rot silently. This asserts the trust-model sections are still there, that
// every `pnpm --filter` command in the README names a script that exists, and that every env var the
// README writes is one an .env example still documents.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
const readme = read("README.md");

// 1. trust model: what it proves and what it does not (PRD story 63, "Honest claims").
for (const heading of ["## Trust model", "### What the chain proves", "### What it does not prove"]) {
  assert.ok(readme.includes(heading), `README is missing the section "${heading}"`);
}
for (const claim of ["SUSPENSE_GAP", "BadSignature", "setVerifier", "plaintext", "spoiler lock", "self-attested"]) {
  assert.ok(readme.includes(claim), `README trust model no longer mentions ${claim}`);
}

// 2. the local run is there and every pnpm script it calls exists.
const body = [...readme.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
for (const cmd of ["docker compose up -d", "forge script script/Deploy.s.sol", "pnpm --filter engine start", "pnpm --filter web dev"]) {
  assert.ok(body.includes(cmd), `README no longer shows how to run \`${cmd}\``);
}
const dirs = { engine: "apps/engine", web: "apps/web", db: "packages/db", subgraph: "packages/subgraph", contracts: "packages/contracts" };
for (const [, pkg, script] of body.matchAll(/pnpm --filter (\S+) (?:run )?([a-z:-]+)/g)) {
  if (script === "exec" || script === "add") continue; // running a binary, not a script
  assert.ok(dirs[pkg], `README runs \`pnpm --filter ${pkg}\`, which is not a package`);
  const { scripts = {} } = JSON.parse(read(`${dirs[pkg]}/package.json`));
  assert.ok(scripts[script], `${dirs[pkg]}/package.json has no "${script}" script, but the README runs it`);
}

// 3. every env var the README sets is still a real one.
const examples = ["apps/engine/.env.example", "apps/web/.env.local.example", "packages/contracts/.env.example"].map(read).join("\n");
const known = new Set([...examples.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
for (const v of ["USDC_ADDRESS", "GATE_ADDRESS"]) known.add(v); // scripts/bettor.ts flags, see docs/CONTRACTS.md
for (const [, v] of body.matchAll(/^\s*([A-Z][A-Z0-9_]*)=/gm)) {
  assert.ok(known.has(v), `README sets ${v}, which no .env example documents`);
}

// 4. the treasury is not an account the README also hands out a key for. If it were, the 2 % fee
// would return to the wallet that paid it and the house take would look like it was never charged.
const accounts = new Map(
  [...read("docs/CONTRACTS.md").matchAll(/`(0x[0-9a-fA-F]{40})` \/ `(0x[0-9a-fA-F]{64})`/g)].map(([, addr, key]) => [
    key.toLowerCase(),
    addr,
  ]),
);
const treasury = body.match(/^\s*TREASURY=(0x[0-9a-fA-F]{40})/m)?.[1];
assert.ok(treasury, "README no longer sets TREASURY for the deploy");
const playable = [...body.matchAll(/=(0x[0-9a-fA-F]{64})\b/g)].map(([, key]) => accounts.get(key.toLowerCase())).filter(Boolean);
assert.ok(playable.length, "no key the README sets maps to an anvil account in docs/CONTRACTS.md");
for (const addr of playable) {
  assert.notEqual(
    addr.toLowerCase(),
    treasury.toLowerCase(),
    `README makes ${addr} the treasury and also publishes its private key, so the 2 % fee round-trips`,
  );
}

// 5. the story count reconciles. The PRD is GitHub issue #1: 65 numbered user stories, 1..65, no
// gaps — the README claimed "63 of 77", a denominator nothing in this project counts to.
const PRD_STORIES = 65;
const total = Number(readme.match(/is (\d+) user stories/)?.[1]);
const verified = Number(readme.match(/(\d+) of them are built and verified/)?.[1]);
const pending = readme.match(/The other (\d+) — stories ([\d, ]+) —/);
assert.equal(total, PRD_STORIES, `README counts ${total} PRD user stories; issue #1 lists ${PRD_STORIES}`);
assert.ok(pending, "README no longer names which PRD stories are not verified locally");
const gated = pending[2].split(",").map((n) => Number(n.trim()));
assert.equal(gated.length, Number(pending[1]), "README's pending story count does not match the list it prints");
assert.equal(new Set(gated).size, gated.length, "README lists a pending story twice");
assert.ok(
  gated.every((n) => n >= 1 && n <= PRD_STORIES),
  `README lists a pending story outside 1..${PRD_STORIES}`,
);
assert.equal(verified + gated.length, PRD_STORIES, `${verified} verified + ${gated.length} pending ≠ ${PRD_STORIES}`);

// 6. /verify tells the same liveness story as the README. `Arena.bail` shipped; the page went on
// telling bettors "there is no timeout refund".
const trust = read("apps/web/src/lib/trust.ts");
assert.ok(readme.includes("`bail(eventId)`"), "README no longer documents bail, the answer to a stalled resolver");
assert.ok(!/no timeout refund/.test(trust), "the /verify trust copy still says there is no timeout refund, but bail is one");
assert.ok(/bail/.test(trust), "the /verify trust copy no longer mentions bail, which the README says is the escape hatch");

// 7. /markets and /positions read the subgraph, not the database, so on the README's local stack they
// sit at "not configured" forever unless the README also says how to get one. It must keep pointing at
// where pools *are* visible without it, and at the local graph-node deploy that turns those pages on.
assert.ok(/wall tiles and the event page/.test(readme), "README no longer says where live pools show without a subgraph");
assert.ok(
  body.includes("pnpm --filter subgraph run deploy-local") && readme.includes("NEXT_PUBLIC_SUBGRAPH_URL"),
  "README no longer shows how to point /markets at a local subgraph",
);

console.log("README ok");
