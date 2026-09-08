# Shared contracts — read this before touching anything

Every agent working in this repo codes against the names, routes, env vars and rules below. If you must change one, change this file in the same commit and say so in your report.

## Packages

| Package | Role | Key exports / commands |
|---|---|---|
| `packages/contracts` (Foundry) | `Gate`, `MockUSDC`, `Arena` | `import { arenaAbi } from "contracts/abi/Arena"` (also `MockUSDC`, `Gate`). `pnpm --filter contracts abi` regenerates. `forge test`. |
| `packages/db` (Prisma 7 + adapter-pg) | schema, migrations, client | `import { makePrisma, Prisma, type Event } from "db"`. `pnpm --filter db generate|migrate|deploy|reset`. CLI reads `packages/db/.env`. |
| `apps/engine` | the autonomous loop | `pnpm --filter engine dev|start|typecheck`, `vitest run`. |
| `apps/web` | Next.js 16 app router | `pnpm --filter web dev|build|lint`. |
| `packages/subgraph` (to build) | The Graph subgraph for `Arena` | `graph codegen|build|test|deploy`. |
| `packages/cre` (to build) | Chainlink CRE confidential workflow | `cre workflow simulate`. |

## Sources of truth

- **Chain (`Arena`)** owns: `lockTime`, `drandRound`, `resolved`, `outcome`, `signature`, pools, stakes, `verified`.
- **Postgres** owns: event content (title, premise, outcomes, script, ticker, reasoning), video URLs, engine state, canon log, presence (`World.lastSeenAt`).
- **Subgraph** is a derived index of chain for the markets list, positions and stats. No mocks: when `NEXT_PUBLIC_SUBGRAPH_URL` is unset the pages that need it render an explicit "subgraph not configured" state.
- The engine is the only writer of `Event`/`Canon`/`Channel`. The web app writes only `World.lastSeenAt`.

## Event lifecycle (`Event.state`)

`RENDER → READY → BETTING → LOCKED → RESOLVE → REVEAL → CANON → PAUSE → DONE`, or `SKIPPED`.

- `BETTING`: first half plays from `startTime`; betting open until `lockTime`.
- `LOCKED`: lock passed; waiting for the drand round. Round time = `1692803367 + (round − 1) × 3` (unix seconds).
- `RESOLVE`: beacon fetched / resolve tx in flight (seconds).
- `REVEAL`, `CANON`, `PAUSE`, `DONE`: outcome known; winning branch plays from `revealTime`.
- **`branchUrls` must never reach a client before state ∈ {REVEAL, CANON, PAUSE, DONE}**, and then only `branchUrls[outcome]` as `winningBranchUrl`. Enforce in the web API layer; never pass a raw row to the client.

## Web ↔ data

Route handlers in `apps/web/src/app/api`:

| Route | Returns |
|---|---|
| `GET /api/channels` | `[{ id, name, current: EventPublic \| null, canon: string[] /* last 5 */ }]` |
| `GET /api/events/[id]` | `EventPublic`, 404 if unknown |
| `GET /api/events?channel=&limit=` | recent `EventPublic[]` (includes DONE), newest first |
| `POST /api/heartbeat` | sets `World.lastSeenAt = now()`; 204 |
| `POST /api/verify` | body `{ address, proof? , attest?: true }` → verifies (World when `WORLD_APP_ID` set, self-attest when `GATE_MODE=checkbox`) → `Gate.setVerified(address, true)` signed by `GATE_OWNER_PRIVATE_KEY` → `{ verified: true, tx }` |

```ts
type EventPublic = {
  id: `0x${string}`; channelId: string; seq: number; state: string;
  title: string; premise: string; outcomes: string[]; ticker: string[]; reasoning: string | null;
  firstHalfUrl: string | null; winningBranchUrl: string | null;
  startTime: string | null; lockTime: string | null; drandRound: string | null; revealTime: string | null;
  outcome: number | null; signature: string | null; createTx: string | null; resolveTx: string | null;
};
```

Clients read live pools, stakes, `verified` and balances straight from chain with a viem public client (`NEXT_PUBLIC_RPC_URL`), polling every 2–3 s while `BETTING`. Countdowns derive from on-chain `lockTime` and the drand round time, never from local timers alone.

## Wallet

`useWallet(): { address, walletClient, publicClient, ready, login(), logout() }` is the single wallet hook. Behind it:
- Privy (`@privy-io/react-auth` 3.40) when `NEXT_PUBLIC_PRIVY_APP_ID` is set: email login, embedded wallets, default chain Base Sepolia (84532).
- Dev wallet when it is unset: a viem local account from `NEXT_PUBLIC_DEV_WALLET_KEY` (anvil key). Dev only; the build must refuse to start with it on chain 84532.

All writes go through `walletClient.writeContract`. Bet flow: `approve` (if allowance short) → `bet`. Claim: `claim(eventId)`. Faucet: `faucet()`.

## Web env

`NEXT_PUBLIC_CHAIN_ID` (31337 | 84532), `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_ARENA_ADDRESS`, `NEXT_PUBLIC_USDC_ADDRESS`, `NEXT_PUBLIC_GATE_ADDRESS`, `NEXT_PUBLIC_SUBGRAPH_URL?`, `NEXT_PUBLIC_PRIVY_APP_ID?`, `NEXT_PUBLIC_DEV_WALLET_KEY?`, `NEXT_PUBLIC_GATE_MODE` (world | checkbox), `NEXT_PUBLIC_WORLD_APP_ID?`, `NEXT_PUBLIC_WORLD_ACTION?`, `DATABASE_URL`, `GATE_OWNER_PRIVATE_KEY`, `WORLD_APP_ID?`, `WORLD_API_KEY?`.

## Engine env (`apps/engine/.env`)

`DATABASE_URL`, `RPC_URL`, `CHAIN_ID`, `RESOLVER_PRIVATE_KEY`, `ARENA_ADDRESS`, `DEMO_MODE`, `ALWAYS_ON`, `CHANNELS`, `MEDIA_DIR`, `MEDIA_BASE_URL`, `MEDIA_PORT` (static server with HTTP Range), `MEDIA_STORE` (local | blob), `BLOB_READ_WRITE_TOKEN?`, `STUB_MODE` (1 = canned author + ffmpeg renderer, no OpenRouter), `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` (default `https://openrouter.ai`; e2e points at the fake), `AUTHOR_MODEL` (`openai/gpt-6-astra`), `FILLER_MODEL` (`openai/gpt-5-nano`), `VIDEO_MODEL` (`minimax/hailuo-3-max`), `IMAGE_MODEL` (`google/gemini-3.1-flash-image`, key-art still), `SUBGRAPH_URL?` (previous event pool state for authoring).

## OpenRouter (engine, day 3)

Read the live docs before writing a line: chat completions with structured outputs (`response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }`, `provider: { require_parameters: true }`, reasoning capture), and the video generation guide at `openrouter.ai/docs/guides/overview/multimodal/video-generation` (`POST /api/v1/videos` → job id → poll → download). Mirror the exact request/response shapes in the fake.

Fake server `apps/engine/src/fake/openrouter.ts` (stdlib `node:http`, no deps): same paths as the real API; chat completions return a schema-valid `Authored` object per channel (vary by seq; include a `reasoning` field); video jobs complete after about 1 s with an ffmpeg `testsrc2` clip of the requested duration and resolution served from the fake itself. `pnpm --filter engine fake` starts it on `FAKE_PORT`.

## Video pipeline (engine, day 3)

- `Authored.firstHalf` shots (5–15 s each) → clips at 480p → concat → `first.mp4`. `Authored.branches[i]` → clips at 768p → `branch-<i>.mp4`. Clips within a list are generated in parallel (concurrency ≤ 8). Continuity: one key-art still per event as the image-to-video input for every first-half clip (image generation through OpenRouter if the docs offer it, else the first shot is text-to-video and its last frame, extracted with ffmpeg, becomes the key art); branch clips use the first half's last frame as their image-to-video input.
- No text burn-in (this machine's ffmpeg has no `drawtext`). The ticker is an HTML overlay in web from `Authored.ticker`.
- Concat with the ffmpeg concat demuxer; re-encode if clip parameters differ.
- Per-event cost log: clips × seconds × rate (480p $0.05/s, 768p $0.08/s) → log line and `Event.costUsd` (`Float?`, migration `20260908164147_event_cost`). `Render` returns `{ url, costUsd }` / `{ urls, costUsd }` and the machine accumulates into the column.
- `Author.author(ctx)` takes `{ channelId, seq, canon, firstHalfSec, secondHalfSec }`; the durations come from `Timing` and the shot lists must sum to them.
- Media store: `local` (engine serves `MEDIA_DIR` on `MEDIA_PORT` with Range support and CORS) or `blob` (`@vercel/blob` `put`, public access). `storeFile(eventId, name, localPath) → url`; intermediate clips live in `MEDIA_DIR/.work` and are never served. The key-art still is passed to the video API as a URL from this store, so **image-to-video against the real OpenRouter needs `MEDIA_STORE=blob`** (a `localhost` media URL is not reachable from their side).

## Subgraph entities (`packages/subgraph/schema.graphql`)

Web codes against exactly these names.

```graphql
type Event @entity { id: Bytes! nOutcomes: Int! lockTime: BigInt! drandRound: BigInt! resolved: Boolean! outcome: Int signature: Bytes createdAt: BigInt! createdTx: Bytes! totalPool: BigInt! betCount: Int! markets: [Market!]! @derivedFrom(field: "event") }
type Market @entity { id: Bytes! event: Event! outcomeIdx: Int! yesPool: BigInt! noPool: BigInt! positions: [Position!]! @derivedFrom(field: "market") }
type Position @entity { id: Bytes! market: Market! event: Event! bettor: Bytes! yesStake: BigInt! noStake: BigInt! claimed: Boolean! }
type Bet @entity(immutable: true) { id: Bytes! event: Event! market: Market! bettor: Bytes! yes: Boolean! amount: BigInt! timestamp: BigInt! tx: Bytes! }
type Claim @entity(immutable: true) { id: Bytes! event: Event! bettor: Bytes! payout: BigInt! fee: BigInt! timestamp: BigInt! tx: Bytes! }
type Bettor @entity { id: Bytes! betCount: Int! totalStaked: BigInt! totalClaimed: BigInt! }
type Protocol @entity { id: String! eventCount: Int! betCount: Int! totalVolume: BigInt! totalFees: BigInt! }
```

Ids: `Event.id` = eventId; `Market.id` = eventId ++ outcomeIdx (1 byte); `Position.id` = eventId ++ outcomeIdx ++ bettor; `Bet.id`/`Claim.id` = txHash ++ logIndex; `Protocol.id` = "1". Network name is templated (`subgraph.template.yaml` → `subgraph.yaml`) so the same mappings deploy to local graph-node and `base-sepolia`.

## Gate / verification

`Gate.setVerified(addr, bool)` is `onlyOwner`; the owner key is `GATE_OWNER_PRIVATE_KEY` (the deployer). The web verify route is its only caller. World Selfie Check uses `@worldcoin/idkit` 4.2 on the client → proof → `POST /api/verify` → World verify endpoint per the live docs → `setVerified`. 18+ is a self-attest checkbox at signup in both modes. Checkbox mode: `POST /api/verify { address, attest: true }` → `setVerified`. Faucet and bet are gated on chain; the UI explains why and how to fix it when a user is unverified.

## Timing

REAL: txBuffer 15 s, first half 60 s, second half 60 s, pause 30 s. DEMO: 3 / 15 / 10 / 5 s.

## Local stack

| Service | Port(s) | Notes |
|---|---|---|
| Postgres (docker) | 5433 | `docker compose up -d`. Use a separate database per agent: `CREATE DATABASE twic_web;` etc. via `docker exec theworldiscollapsing-db-1 psql -U twic -d twic -c ...`. |
| anvil | 8545 (web agent), 8546 (subgraph agent) | `anvil --port N`. Deploy: `RESOLVER=<acct0> TREASURY=<acct1> forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:N --private-key <acct0 key> --broadcast`; addresses in `broadcast/Deploy.s.sol/31337/run-latest.json`. |
| engine media | 4000 / 4001 | `MEDIA_PORT` |
| fake OpenRouter | 4100 / 4101 | `FAKE_PORT` |
| graph-node | 8000 (GraphQL), 8020 (admin), ipfs 5001 | docker, points at anvil via `host.docker.internal` |
| web | 3000 | `pnpm --filter web dev` |

anvil account 0: `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` / `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`. Account 1: `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` / `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d`.

## Rules

- No mocks in product code paths. Fakes only in tests and e2e, selected by env base URLs.
- Never commit `.env`. No co-author trailers on commits. Conventional commits, one concern per commit.
- Typecheck, tests and build of every package you touched must pass before you report done. Report the exact commands and their output. A claim without runnable evidence is not done.
- Do not add dependencies beyond what is installed unless the task cannot be done without them; if you must, run `pnpm add` and retry once on a lockfile error.
- Kill every process you started before you finish.
