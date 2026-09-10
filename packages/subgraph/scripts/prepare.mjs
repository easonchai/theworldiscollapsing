// Renders subgraph.yaml from subgraph.template.yaml and mirrors the Arena ABI as JSON.
// Usage: node scripts/prepare.mjs <network> [address] [startBlock]
//   or   ARENA_ADDRESS=0x... START_BLOCK=123 node scripts/prepare.mjs base-sepolia
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [network, addressArg, startBlockArg] = process.argv.slice(2);
if (!network) throw new Error("usage: prepare.mjs <network> [address] [startBlock]");

const address = addressArg ?? process.env.ARENA_ADDRESS;
if (!address) throw new Error("missing Arena address (argv[2] or ARENA_ADDRESS)");
const startBlock = startBlockArg ?? process.env.START_BLOCK ?? "0";

const vars = { network, address, startBlock };
const yaml = readFileSync(path.join(root, "subgraph.template.yaml"), "utf8").replace(
  /\{\{(\w+)\}\}/g,
  (_, k) => {
    if (!(k in vars)) throw new Error(`unknown template var ${k}`);
    return vars[k];
  },
);
writeFileSync(path.join(root, "subgraph.yaml"), yaml);

// One source of truth for the ABI: packages/contracts/abi/Arena.ts, unwrapped to plain JSON.
const ts = readFileSync(path.join(root, "..", "contracts", "abi", "Arena.ts"), "utf8");
const json = ts.slice(ts.indexOf("["), ts.lastIndexOf("]") + 1);
mkdirSync(path.join(root, "abis"), { recursive: true }); // gitignored output dir, absent in a fresh clone
writeFileSync(path.join(root, "abis", "Arena.json"), JSON.stringify(JSON.parse(json), null, 2) + "\n");

console.log(`subgraph.yaml: network=${network} address=${address} startBlock=${startBlock}`);
