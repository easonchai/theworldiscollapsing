# Shared contracts — read this before touching anything

Every agent working in this repo codes against the names, routes, env vars and rules below. If you must change one, change this file in the same commit and say so in your report.

## Packages

| Package | Role | Key exports / commands |
|---|---|---|
| `packages/contracts` (Foundry) | `Gate`, `MockUSDC`, `Arena`, `DrandVerifier` | `import { arenaAbi } from "contracts/abi/Arena"` (also `MockUSDC`, `Gate`). `pnpm --filter contracts abi` regenerates. `forge test`. |
| `packages/db` (Prisma 7 + adapter-pg) | schema, migrations, client | `import { makePrisma, Prisma, type Event } from "db"`. `pnpm --filter db generate|migrate|deploy|reset`. CLI reads `packages/db/.env`. |
| `apps/engine` | the autonomous loop | `pnpm --filter engine dev|start|typecheck`, `vitest run`. |
| `apps/web` | Next.js 16 app router | `pnpm --filter web dev|build|lint`. |
| `packages/subgraph` | The Graph subgraph for `Arena` | `pnpm --filter subgraph run prepare:local\|prepare:base-sepolia\|codegen\|build\|test\|create-local\|deploy-local\|deploy:studio`. `prepare:*` renders `subgraph.yaml` from `subgraph.template.yaml` (both it and `abis/Arena.json` are generated + gitignored) — run it before `codegen`. See its README. |
| `packages/cre` | Chainlink CRE confidential workflow (branch-key release) | bun project, **outside the pnpm workspace**. `cd packages/cre/reveal-key && bun install && bun test`. `cre workflow build ./reveal-key --target local-settings` (no account); `cre workflow simulate` needs `cre login`. |

## Sources of truth

- **Chain (`Arena`)** owns: `lockTime`, `drandRound`, `resolved`, `outcome`, `signature`, pools, stakes, `verified`.
- **Postgres** owns: event content (title, premise, outcomes, script, ticker, reasoning), video URLs, engine state, canon log, presence (`World.lastSeenAt`).
- **Subgraph** is a derived index of chain for the markets list, positions and stats. No mocks: when `NEXT_PUBLIC_SUBGRAPH_URL` is unset the pages that need it render an explicit "subgraph not configured" state.
- The engine is the only writer of `Event`/`Canon`/`Channel`. The web app writes only `World.lastSeenAt`.

## Event lifecycle (`Event.state`)

`RENDER → READY → BETTING → LOCKED → RESOLVE → REVEAL → CANON → PAUSE → DONE`, or `SKIPPED`.

- `BETTING`: first half plays from `startTime`; betting open until `lockTime`.
- `LOCKED`: lock passed; waiting for the drand round. Round time = `1727521075 + (round − 1) × 3` (unix seconds) — drand **evmnet** genesis, see "Randomness" below.
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
| `POST /api/verify` | body `{ address, message, signature, attest?: true, proof? }` → **wallet signature required** (see below) → verifies (World when `GATE_MODE=world`, self-attest when `GATE_MODE=checkbox`) → `Gate.setVerified(address, true)` signed by `GATE_OWNER_PRIVATE_KEY` → `{ verified: true, tx }` |
| `GET /api/world/rp-context` | World mode only: `{ rp_id, nonce, created_at, expires_at, signature }` signed with `WORLD_RP_SIGNING_KEY`; IDKit 4.x refuses to open a request without it. 501 when unset. |

```ts
type EventPublic = {
  id: `0x${string}`; channelId: string; seq: number; state: string;
  title: string; premise: string; outcomes: string[]; ticker: string[]; reasoning: string | null;
  firstHalfUrl: string | null; winningBranchUrl: string | null;
  startTime: string | null; lockTime: string | null; drandRound: string | null; revealTime: string | null;
  outcome: number | null; signature: string | null; createTx: string | null; resolveTx: string | null;
};
```

`/api/channels`.`current` is the channel's live event (`BETTING`…`PAUSE`); when nothing is live it falls back to the newest `DONE` event so the wall replays instead of going dark.

Clients read live pools, stakes, `verified` and balances straight from chain with a viem public client (`NEXT_PUBLIC_RPC_URL`), polling every 2–3 s while `BETTING`. Note the generated getters take the array index: `pools(eventId, outcomeIdx, side)` and `stakes(eventId, outcomeIdx, bettor, side)` with `side` 0 = NO, 1 = YES, each returning one `uint256`. Countdowns derive from on-chain `lockTime` and the drand round time, never from local timers alone.

## Wallet

`useWallet(): { address, walletClient, publicClient, ready, login(), logout() }` is the single wallet hook. Behind it:
- Privy (`@privy-io/react-auth` 3.40) when `NEXT_PUBLIC_PRIVY_APP_ID` is set: email login, embedded wallets, default chain Base Sepolia (84532).
- Dev wallet when it is unset: a viem local account from `NEXT_PUBLIC_DEV_WALLET_KEY` (anvil key). Dev only; the build must refuse to start with it on chain 84532.

All writes go through `walletClient.writeContract`. Bet flow: `approve` (if allowance short) → `bet`. Claim: `claim(eventId)`. Faucet: `faucet()`.

## Web env

`NEXT_PUBLIC_CHAIN_ID` (31337 | 84532), `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_ARENA_ADDRESS`, `NEXT_PUBLIC_USDC_ADDRESS`, `NEXT_PUBLIC_GATE_ADDRESS`, `NEXT_PUBLIC_SUBGRAPH_URL?`, `NEXT_PUBLIC_PRIVY_APP_ID?`, `NEXT_PUBLIC_DEV_WALLET_KEY?`, `NEXT_PUBLIC_GATE_MODE` (world | checkbox), `NEXT_PUBLIC_WORLD_APP_ID?`, `NEXT_PUBLIC_WORLD_ACTION?`, `DATABASE_URL`, `GATE_OWNER_PRIVATE_KEY`, `GATE_MODE?` (server-side override of the gate mode), `WORLD_APP_ID?`, `WORLD_API_KEY?`, `WORLD_RP_ID?`, `WORLD_RP_SIGNING_KEY?`. Template: `apps/web/.env.local.example`; the real file is `apps/web/.env.local` (gitignored).

`apps/web` runs on **webpack**, not Turbopack (`next dev --webpack` / `next build --webpack` plus `experimental.extensionAlias`): Prisma 7 generates TypeScript that imports itself with `.js` specifiers, which Turbopack cannot resolve. Setting `importFileExtension = "ts"` on the `db` generator would let Turbopack back in.

## Engine env (`apps/engine/.env`)

`DATABASE_URL`, `RPC_URL`, `CHAIN_ID`, `RESOLVER_PRIVATE_KEY`, `ARENA_ADDRESS`, `DEMO_MODE`, `ALWAYS_ON`, `CHANNELS`, `MEDIA_DIR`, `MEDIA_BASE_URL`, `MEDIA_PORT` (static server with HTTP Range), `MEDIA_STORE` (local | blob), `BLOB_READ_WRITE_TOKEN?`, `STUB_MODE` (1 = canned author + ffmpeg renderer, no OpenRouter), `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` (default `https://openrouter.ai`; e2e points at the fake), `AUTHOR_MODEL` (`openai/gpt-6-astra`), `FILLER_MODEL` (`openai/gpt-5-nano`), `VIDEO_MODEL` (`minimax/hailuo-3-max`), `IMAGE_MODEL` (`google/gemini-3.1-flash-image`, key-art still), `SUBGRAPH_URL?` (pool state of the last settled event — `seq − 2`, because `seq − 1` is still taking bets when `seq` is authored — fed to authoring), `BRANCH_SEAL` (`1` = seal branch videos, default off), `BRANCH_SEAL_ROOT` (32 bytes of 0x-hex; required when `BRANCH_SEAL=1`), `REVEAL_SECRET` (bearer token for `/internal/reveal-key`; required when `BRANCH_SEAL=1`).

## OpenRouter (engine, day 3)

Read the live docs before writing a line: chat completions with structured outputs (`response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }`, `provider: { require_parameters: true }`, reasoning capture), and the video generation guide at `openrouter.ai/docs/guides/overview/multimodal/video-generation` (`POST /api/v1/videos` → job id → poll → download). Mirror the exact request/response shapes in the fake.

Fake server `apps/engine/src/fake/openrouter.ts` (stdlib `node:http`, no deps): same paths as the real API; chat completions return a schema-valid `Authored` object per channel (vary by seq; include a `reasoning` field); video jobs complete after about 1 s with an ffmpeg `testsrc2` clip of the requested duration and resolution served from the fake itself. `pnpm --filter engine fake` starts it on `FAKE_PORT`.

## Video pipeline (engine, day 3)

- `Authored.firstHalf` shots (5–15 s each) → clips at 480p → concat → `first.mp4`. `Authored.branches[i]` → clips at 768p → **`branch-<i>-<32 hex>.mp4`** (`branchFileName` in `apps/engine/src/media.ts`). The random suffix is fresh per render and exists only in `Event.branchUrls`: without it every unrevealed ending is downloadable at a guessable path while betting is open, since the event id and `MEDIA_BASE_URL` are both public. Clips within a list are generated in parallel (concurrency ≤ 8). Continuity: one key-art still per event as the image-to-video input for every first-half clip (image generation through OpenRouter if the docs offer it, else the first shot is text-to-video and its last frame, extracted with ffmpeg, becomes the key art); branch clips use the first half's last frame as their image-to-video input.
- No text burn-in (this machine's ffmpeg has no `drawtext`). The ticker is an HTML overlay in web from `Authored.ticker`.
- Concat with the ffmpeg concat demuxer; re-encode if clip parameters differ.
- Per-event cost log: clips × seconds × rate (480p $0.05/s, 768p $0.08/s) → log line and `Event.costUsd` (`Float?`, migration `20260908164147_event_cost`). `Render` returns `{ url, costUsd }` / `{ urls, costUsd }` and the machine accumulates into the column.
- `Author.author(ctx)` takes `{ channelId, seq, canon, firstHalfSec, secondHalfSec }`; the durations come from `Timing` and the shot lists must sum to them.
- Media store: `local` (engine serves `MEDIA_DIR` on `MEDIA_PORT` with Range support and CORS) or `blob` (`@vercel/blob` `put`, public access). `storeFile(eventId, name, localPath) → url`; intermediate clips live in `MEDIA_DIR/.work/<eventId>`, are never served, and the whole per-event directory is deleted once `branches()` has stored its outputs. The key-art still is passed to the video API as a URL from this store, so **image-to-video against the real OpenRouter needs `MEDIA_STORE=blob`** (a `localhost` media URL is not reachable from their side).

## Branch sealing + Chainlink CRE (engine + `packages/cre`, day 7 stretch)

Off by default; `BRANCH_SEAL=1` turns it on and needs `MEDIA_STORE=local`.

- Branch videos are published as AES-256-GCM ciphertext named **`branch-<i>-<32 hex>.mp4.enc`** (`iv(12) ‖ ct ‖ tag(16)`), served as `application/octet-stream`. The plaintext is deleted after sealing. `Event.branchUrls[i]` therefore points at the ciphertext until the key is released. `first.mp4` and stills are untouched. Implemented as a `MediaStore` decorator (`sealingStore` in `apps/engine/src/seal.ts`) so it covers the real renderer and the ffmpeg stub alike.
- Key schedule, shared by `apps/engine/src/seal.ts` and `packages/cre/reveal-key/workflow.ts`: **`key_i = keccak256(root ‖ eventId ‖ uint8(i))`**, `root` = `BRANCH_SEAL_ROOT`. Both sides assert the same two test vectors; do not change one without the other.
- `POST /internal/reveal-key` on the engine media server (`MEDIA_PORT`), `Authorization: Bearer $REVEAL_SECRET` (constant-time compare), body `{ eventId, outcome, key }` with `key` as 0x-hex → reads the sealed file name from `Event.branchUrls[outcome]` (it carries a random suffix, so it cannot be derived from the index), decrypts it in place, rewrites `Event.branchUrls[outcome]` to the plaintext URL, returns `{ url }`. 401 on a bad token, 400 on a bad key (GCM tag) or malformed body. The endpoint only exists when `BRANCH_SEAL=1`.
- **The reveal never waits on CRE forever.** At `RESOLVE` the engine gives the workflow a 3 s head start (`CRE_GRACE_MS`) and then, if `branchUrls[outcome]` still points at `.enc`, derives `key_outcome` from its own `BRANCH_SEAL_ROOT` and publishes the plaintext itself (`Deps.revealWinner`, wired in `apps/engine/src/index.ts`). The engine holds the root either way, so this costs no secrecy; CRE remains the demo of releasing that key from a TEE, and a sealed reveal is never a dead video.
- The CRE workflow (`packages/cre/reveal-key`) triggers on `Arena.Resolved`, re-reads `events(eventId)` through `usingTheDons()`, derives only `key_outcome` inside the TEE from the Vault DON secrets `BRANCH_SEAL_ROOT` and `REVEAL_SECRET`, and POSTs it. Secret ids are declared in `packages/cre/secrets.yaml` and must match the engine's env values exactly.

## Subgraph entities (`packages/subgraph/schema.graphql`)

Web codes against exactly these names.

```graphql
type Event @entity(immutable: false) { id: Bytes! nOutcomes: Int! lockTime: BigInt! drandRound: BigInt! resolved: Boolean! outcome: Int signature: Bytes createdAt: BigInt! createdTx: Bytes! totalPool: BigInt! betCount: Int! markets: [Market!]! @derivedFrom(field: "event") }
type Market @entity(immutable: false) { id: Bytes! event: Event! outcomeIdx: Int! yesPool: BigInt! noPool: BigInt! positions: [Position!]! @derivedFrom(field: "market") }
type Position @entity(immutable: false) { id: Bytes! market: Market! event: Event! bettor: Bytes! yesStake: BigInt! noStake: BigInt! claimed: Boolean! }
type Bet @entity(immutable: true) { id: Bytes! event: Event! market: Market! bettor: Bytes! yes: Boolean! amount: BigInt! timestamp: BigInt! tx: Bytes! }
type Claim @entity(immutable: true) { id: Bytes! event: Event! bettor: Bytes! payout: BigInt! fee: BigInt! timestamp: BigInt! tx: Bytes! }
type Bettor @entity(immutable: false) { id: Bytes! betCount: Int! totalStaked: BigInt! totalClaimed: BigInt! }
type Protocol @entity(immutable: false) { id: String! eventCount: Int! betCount: Int! totalVolume: BigInt! totalFees: BigInt! }
```

(`immutable: false` is spelled out because graph-cli 0.98.1 rejects a bare `@entity`: "@entity directive requires `immutable` argument". Field names are unchanged.)

Ids: `Event.id` = eventId; `Market.id` = eventId ++ outcomeIdx (1 byte); `Position.id` = eventId ++ outcomeIdx ++ bettor; `Bet.id`/`Claim.id` = txHash ++ logIndex (`concatI32`, 4-byte little-endian); `Protocol.id` = "1". Network name is templated (`subgraph.template.yaml` → `subgraph.yaml`) so the same mappings deploy to local graph-node and `base-sepolia`.

Subgraph name is `twic/arena` locally and `twic-arena` in Studio, so `NEXT_PUBLIC_SUBGRAPH_URL` / `SUBGRAPH_URL` = `http://localhost:8000/subgraphs/name/twic/arena` against the local graph-node. Semantics worth coding against: a `Market` row exists for every outcome index from `EventCreated`, before any bet (pools 0). `Position.claimed` flips to true for **every** position that bettor holds on the event, because `Arena.claim(eventId)` settles all of its markets in one call. `Event.outcome` and `Event.signature` are null until `Resolved`.

## Randomness — drand `evmnet`, verified on chain (day 7 stretch)

The beacon is **drand `evmnet`**, not quicknet. It is drand's BN254 network, built so the EVM can
check its signatures with the cheap bn254 precompiles (0x06 / 0x08).

| | |
|---|---|
| Beacon URL | `https://api.drand.sh/v2/beacons/evmnet/rounds/{round}` |
| Genesis / period | `1727521075` / `3 s` (`Arena.DRAND_GENESIS` / `DRAND_PERIOD`, `apps/engine/src/drand.ts`, `apps/web/src/lib/chain.ts` all mirror these) |
| Round math | `roundTime(r) = GENESIS + (r − 1) × 3`; `roundAt(t)` is the first round published at or after `t`; the committed round is `roundAt(lockTime + SUSPENSE_GAP)`, `SUSPENSE_GAP = 10 s` |
| Signature | **64 bytes**, an uncompressed BN254 G1 point (quicknet's were 48). `Arena.resolve` rejects any other length |
| Signed message | `keccak256(uint64be(round))`, hashed to G1 with DST `BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_` (scheme `bls-bn254-unchained-on-g1`) |
| Outcome | unchanged: `outcome = uint(keccak256(signature ‖ eventId)) % n` |

`Arena.verifier` (an `IDrandVerifier`, `setVerifier` is `onlyOwner`) decides how much resolution trusts
the resolver:

- `address(0)` — **trusted mode**, the pre-day-7 behaviour: the signature is stored as submitted and
  only checked off-chain (the web verify badge). This is still the default in a fresh `Arena`.
- a `DrandVerifier` — `resolve()` reverts `BadSignature` unless the BLS signature verifies against the
  evmnet group public key **for the round the event committed at creation**. `script/Deploy.s.sol`
  deploys one and sets it, so every deployed stack runs verified.

Gas: `resolve` costs ~73k in trusted mode and ~219k with the verifier (`DrandVerifier.verify` alone is
~153k). Numbers logged by `forge test -vv` (`test_ResolveGasInTrustedMode`, `test_ResolveWithVerifierAcceptsRealBeacon`).

## Gate / verification

`Gate.setVerified(addr, bool)` is `onlyOwner`; the owner key is `GATE_OWNER_PRIVATE_KEY` (the deployer). The web verify route is its only caller.

**Every `POST /api/verify` call must carry a wallet signature.** `message` is exactly `theworldiscollapsing verify <address> <unixSeconds>`, the timestamp must be within 5 minutes of the server clock, and viem `verifyMessage` must recover `address`. Without it anyone could spend the owner's gas verifying addresses they do not control. The route also rate-limits to one verification per address per minute (in-memory). World Selfie Check uses `@worldcoin/idkit` 4.2 on the client → proof → `POST /api/verify` → World verify endpoint per the live docs → `setVerified`. 18+ is a self-attest checkbox at signup in both modes. Checkbox mode: `POST /api/verify { address, attest: true }` → `setVerified`. Faucet and bet are gated on chain; the UI explains why and how to fix it when a user is unverified.

## Timing

REAL: txBuffer 15 s, first half 60 s, second half 60 s, pause 30 s. DEMO: 3 / 15 / 10 / 5 s.

## Local stack

| Service | Port(s) | Notes |
|---|---|---|
| Postgres (docker) | 5433 | `docker compose up -d`. Use a separate database per agent: `CREATE DATABASE twic_web;` etc. via `docker exec theworldiscollapsing-db-1 psql -U twic -d twic -c ...`. |
| anvil | 8545 (web agent), 8546 (subgraph agent), 8547 (cre agent) | `anvil --port N`. Deploy: `RESOLVER=<acct0> TREASURY=<acct1> forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:N --private-key <acct0 key> --broadcast`; addresses in `broadcast/Deploy.s.sol/31337/run-latest.json`. The script also deploys `DrandVerifier` and calls `arena.setVerifier(...)`. |
| engine media | 4000 / 4001 / 4002 (cre agent) | `MEDIA_PORT` |
| fake OpenRouter | 4100 / 4101 | `FAKE_PORT` |
| graph-node | 8000 (GraphQL), 8001, 8020 (admin), 8030 (status), 8040; ipfs 5001; its own postgres 5434 | `docker compose -f packages/subgraph/docker-compose.yml up -d`. Ethereum network name `localhost` → `host.docker.internal:8546`. Teardown with `down -v`. |
| web | 3000 | `pnpm --filter web dev` |

anvil account 0: `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` / `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`. Account 1: `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` / `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d`.

Synthetic bettors: `apps/engine/scripts/bettor.ts` (tsx + viem). Anvil account 0 is the Gate owner, so it verifies accounts 2–5; those four faucet, approve, bet on whatever event the DB has in `BETTING`, then claim after resolution and print payouts. It reads `RPC_URL`, `ARENA_ADDRESS`, `USDC_ADDRESS`, `GATE_ADDRESS`, `DATABASE_URL` from env (or `--rpc/--arena/--usdc/--gate/--db`), and `--events N` says how many events to play (default 2).

## Rules

- No mocks in product code paths. Fakes only in tests and e2e, selected by env base URLs.
- Never commit `.env`. No co-author trailers on commits. Conventional commits, one concern per commit.
- Typecheck, tests and build of every package you touched must pass before you report done. Report the exact commands and their output. A claim without runnable evidence is not done.
- Do not add dependencies beyond what is installed unless the task cannot be done without them; if you must, run `pnpm add` and retry once on a lockfile error.
- Kill every process you started before you finish.
