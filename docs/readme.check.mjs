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
for (const [, pkg, script] of body.matchAll(/pnpm --filter (\S+) (?:run )?([a-z:]+)/g)) {
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

console.log("README ok");
