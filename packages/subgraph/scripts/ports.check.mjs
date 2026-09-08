#!/usr/bin/env node
// node packages/subgraph/scripts/ports.check.mjs
//
// graph-node dials one RPC port, baked in at `docker compose up`. If that is not the port the root
// README's anvil listens on, graph-node blocks on provider validation forever: 8020 never opens,
// `create-local` dies with ECONNRESET, and a stack that does come up reports synced:false with a
// null latestBlock — so /markets and /positions render empty with no error anywhere. Nothing else
// ties the two files together, so this does.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkg = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(path.join(pkg, p), "utf8");

// The port the root README tells everyone to run anvil on: `--rpc-url http://127.0.0.1:<port>`.
const readme = read("../../README.md");
const anvilPorts = new Set([...readme.matchAll(/127\.0\.0\.1:(\d{4})/g)].map((m) => m[1]));
assert.equal(anvilPorts.size, 1, `README names ${anvilPorts.size} anvil ports: ${[...anvilPorts]}`);
const [anvilPort] = anvilPorts;

// The port graph-node dials, and the env var that overrides it.
const compose = read("docker-compose.yml");
const rpc = compose.match(/ethereum:\s*"[^:]+:http:\/\/host\.docker\.internal:(\S+?)"/);
assert.ok(rpc, "docker-compose.yml has no `ethereum: <network>:http://host.docker.internal:<port>`");
assert.equal(
  rpc[1],
  "${ANVIL_PORT:-" + anvilPort + "}",
  `graph-node dials ${rpc[1]} but the README's anvil is on ${anvilPort} — graph-node will never sync`,
);

console.log(`subgraph ports ok (graph-node → anvil ${anvilPort}, override with ANVIL_PORT)`);
