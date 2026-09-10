# `packages/subgraph` — Arena index

Indexes the four `Arena` events (`EventCreated`, `Bet`, `Resolved`, `Claimed`) into the entities
defined in [`docs/CONTRACTS.md`](../../docs/CONTRACTS.md#subgraph-entities-packagessubgraphschemagraphql).
`schema.graphql` is the binding shape; web and engine code against exactly those names.

Toolchain (pinned): `@graphprotocol/graph-cli` 0.98.1, `@graphprotocol/graph-ts` 0.38.2,
`matchstick-as` 0.6.0.

## Layout

| File | Role |
|---|---|
| `schema.graphql` | entities (verbatim from CONTRACTS.md) |
| `subgraph.template.yaml` | manifest with `{{network}}` / `{{address}}` / `{{startBlock}}` holes |
| `scripts/prepare.mjs` | fills the holes → `subgraph.yaml`, and mirrors `packages/contracts/abi/Arena.ts` → `abis/Arena.json` |
| `src/mapping.ts` | the four handlers |
| `tests/arena.test.ts` | matchstick unit tests |
| `matchstick.yaml` | points matchstick's `libsFolder` at pnpm's hoisted store (it needs `assemblyscript/bin/asc` and `@graphprotocol/graph-ts` under one folder, which pnpm's isolated `node_modules` does not give it) |
| `docker-compose.yml` | local graph-node + ipfs + its own postgres on 5434 |
| `scripts/ports.check.mjs` | asserts the compose default RPC port is the anvil port the root README starts |

`subgraph.yaml` and `abis/Arena.json` are generated and gitignored — run a `prepare:*` script first.

## Local run (graph-node in docker)

graph-node indexes **the anvil the root README starts, on 8545**. Start that first: graph-node blocks
on provider validation until the RPC answers, so bringing it up against a dead port leaves even the
admin port 8020 closed and `create-local` fails with `ECONNRESET`.

```bash
anvil                                                             # 127.0.0.1:8545
# deploy Gate/MockUSDC/Arena per the root README, then:
docker compose -f packages/subgraph/docker-compose.yml up -d      # graph-node 8000/8020/8030, ipfs 5001, pg 5434
cd packages/subgraph
ARENA_ADDRESS=0x… pnpm run prepare:local
pnpm run codegen && pnpm run build
pnpm run create-local && pnpm run deploy-local
```

Indexing anvil on another port (agents run their own — 8546, 8547, see `docs/CONTRACTS.md`) is one env
var, and it has to be set on the `up` because it is baked into the container:

```bash
ANVIL_PORT=8546 docker compose -f packages/subgraph/docker-compose.yml up -d
```

Queries: `http://localhost:8000/subgraphs/name/twic/arena`. Indexing status / errors:
`http://localhost:8030/graphql` (`{ indexingStatuses { health synced fatalError { message } } }`).
`synced: false` with a null `latestBlock` means graph-node is not talking to any chain — check the port.

Unit tests need no chain and no node:

```bash
pnpm --filter subgraph test        # graph test → matchstick
pnpm --filter subgraph run check   # compose RPC port still matches the root README's anvil
```

Teardown: `docker compose -f packages/subgraph/docker-compose.yml down -v`.

## Deploying to Base Sepolia (Subgraph Studio) — done 2026-09-10

Live at <https://api.studio.thegraph.com/query/1760049/twic-arena/0.0.1>, indexing
`Arena` `0xcC9D2B9A192a6Ff5F3C5950EcdFd4CaF958fFe1b` from block 46631130 with
`hasIndexingErrors: false`. The production `/markets` page reads it. Steps, as they actually ran
(docs: <https://thegraph.com/docs/en/subgraphs/developing/deploying-publishing/using-subgraph-studio/>):

1. Create the subgraph at <https://thegraph.com/studio/> (connect wallet), network **Base Sepolia**.
   Note its slug and deploy key. Each account is limited to 3 deployed (unpublished) subgraphs.
2. Point the manifest at the deployed Arena and the block it was created in:
   ```bash
   ARENA_ADDRESS=0x… START_BLOCK=<Arena deploy block> pnpm --filter subgraph run prepare:base-sepolia
   pnpm --filter subgraph run codegen && pnpm --filter subgraph run build
   ```
3. Authenticate and deploy, passing the version label on the command line:
   ```bash
   pnpm --filter subgraph exec graph auth <DEPLOY_KEY>
   pnpm --filter subgraph exec graph deploy twic-arena -l 0.0.1
   ```
   ⚠ Not `run deploy:studio`. That script is `graph deploy twic-arena` with no label, so it stops on
   an interactive prompt, and `pnpm run deploy:studio -- -l 0.0.1` prints the graph CLI's help and
   exits 2 — pnpm does not pass the flag through. Use the `exec` form above, or add `-l` to the
   script. Change the slug if Studio hands out a different one.
4. The query URL is `https://api.studio.thegraph.com/query/<account id>/<slug>/<version label>` — the
   label is in the path, so deploying `0.0.2` changes the URL and `NEXT_PUBLIC_SUBGRAPH_URL` /
   `SUBGRAPH_URL` have to move with it. On the first poll after a deploy the endpoint answers with
   `hasIndexingErrors: false`, a `_meta.block` past the start block and an **empty** `events` list:
   that is a healthy index with nothing indexed yet, not a failure. Development URL is rate-limited
   to 3,000 queries/day; publishing to the network (`graph publish`) is a separate, optional step.

Once events existed, every `Event`, its `Market` rows and `Protocol.eventCount` matched `cast` reads
against `Arena` exactly.

The network name in `subgraph.template.yaml` is `base-sepolia`, which is what graph-node and Studio
call Base Sepolia; `prepare:local` writes `localhost`, matching the `ethereum:` env in
`docker-compose.yml`.

## How the rest of the repo consumes it

- **web** (`NEXT_PUBLIC_SUBGRAPH_URL`): the markets list and positions views. Live pools during
  `BETTING` still come from a viem public client reading `Arena` directly — the subgraph is the
  fast, cross-event view, not the tick source. When the env var is unset those pages render an
  explicit "subgraph not configured" state (no mocks).
- **engine** (`SUBGRAPH_URL`): `apps/engine/src/author.ts` reads the *previous* event's pool state
  so authoring can lean into what bettors cared about. Exact query it sends:

  ```graphql
  query Prev($id: Bytes!) {
    event(id: $id) { totalPool betCount markets { outcomeIdx yesPool noPool } }
  }
  ```

  It is best-effort: authoring never fails because the index is down.

## Subgraph MCP — how a judge can query this subgraph from an AI client

The Graph ships a hosted MCP server so an agent can hit subgraphs without hand-writing GraphQL
(<https://thegraph.com/docs/en/subgraphs/tooling/subgraph-mcp/introduction/>). Per the docs it lets a
client:

- "Access GraphQL schemas for any Subgraph on The Graph Network"
- "Run GraphQL queries on any Subgraph deployment"
- "Discover top Subgraph deployments by keyword or contract address"
- "Retrieve 30-day query volumes for Subgraph deployments"
- "Ask questions about Subgraph data without writing GraphQL manually"

Endpoint: `https://subgraphs.mcp.thegraph.com/sse`. Config for Claude, verbatim from
<https://thegraph.com/docs/en/subgraphs/tooling/subgraph-mcp/claude/> (Cline and Cursor have their
own pages with the same server):

```json
{
  "mcpServers": {
    "subgraph": {
      "command": "npx",
      "args": ["mcp-remote", "--header", "Authorization:${AUTH_HEADER}", "https://subgraphs.mcp.thegraph.com/sse"],
      "env": {
        "AUTH_HEADER": "Bearer GATEWAY_API_KEY"
      }
    }
  }
}
```

`GATEWAY_API_KEY` is the judge's own API key from Subgraph Studio. With it configured, "find the
subgraph indexing contract 0x… on base-sepolia, then show me the markets with the largest pools"
resolves to a deployment and a query without anyone writing GraphQL.

⚠ Not exercised: we have no gateway API key and the Studio deployment is not *published* to the
network, so this section is documentation, not a verified run. The server addresses deployments on
The Graph Network — a graph-node on `localhost:8000` is not reachable from it, and an unpublished
Studio subgraph is unlikely to be either. Judges pointing an agent at this project should use the
Studio development query URL in the "Deploying to Base Sepolia" section directly.
