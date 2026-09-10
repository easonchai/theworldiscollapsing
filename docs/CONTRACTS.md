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

- **Chain (`Arena`)** owns: `lockTime`, `drandRound`, `resolved`, `outcome`, `signature`, `eventVerifier`, `bailed`, pools, stakes, `verified`.
- **Postgres** owns: event content (title, premise, outcomes, script, ticker, reasoning), video URLs, engine state, canon log, presence (`World.lastSeenAt`).
- **Subgraph** is a derived index of chain for the markets list, positions and stats. No mocks: when `NEXT_PUBLIC_SUBGRAPH_URL` is unset the pages that need it render an explicit "subgraph not configured" state. Only `/markets` and `/positions` read it (`apps/web/src/components/markets-list.tsx`, `positions-list.tsx`); the wall tiles and the event page read pools from `Arena` with a viem public client (`readMarket` in `apps/web/src/components/markets.tsx`). The README's local run does not start graph-node, so on that stack live pools are proved on `/` and `/e/<id>`, never on `/markets`: the markets and positions pages correctly stay "not configured" until you run the graph-node block in README "Run the whole thing locally" (the same steps are in the graph-node row of "Local stack" below) and set the var. An empty `/markets` on the default stack is the documented state, not a defect — a checklist that asserts pools there is checking the wrong page: check the wall tile and the event page, or do the graph-node bring-up first.
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
| `POST /api/heartbeat` | same-origin only (`Sec-Fetch-Site: same-origin`, else `Origin` matching the host; 403 otherwise) and one accepted beat per client IP per 10 s — sets `World.lastSeenAt = now()`; **204 whether or not the beat was throttled**, so the client never retries |
| `POST /api/verify` | body `{ address, message, signature, attest?: true, proof? }` → **wallet signature required** (see below) → already verified on chain? `{ verified: true, tx: null }`, no tx → verifies (World when `GATE_MODE=world`, self-attest when `GATE_MODE=checkbox`) → `Gate.setVerified(address, true)` signed by `GATE_OWNER_PRIVATE_KEY` → `{ verified: true, tx }` |
| `GET /api/world/rp-context` | World mode only: `{ rp_id, nonce, created_at, expires_at, signature }` signed with `WORLD_RP_SIGNING_KEY`; IDKit 4.x refuses to open a request without it. 501 when unset. |

```ts
type EventPublic = {
  id: `0x${string}`; channelId: string; seq: number; state: string;
  title: string; premise: string; outcomes: string[]; ticker: string[]; reasoning: string | null;
  cards: { at: number; title: string; stats: string[] }[]; // studio cards, `at` = seconds into the first half
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

All writes go through `publicClient.simulateContract` → `walletClient.writeContract(request)` → `confirmed(hash, …)` (`apps/web/src/lib/tx.ts`), never `writeContract` on its own: the simulation turns a revert into a sentence before the wallet opens, and `confirmed` treats `receipt.status !== "success"` as a failure — viem resolves the receipt of a reverted transaction, so a caller that skips it announces a revert as "Bet confirmed in block N". `txMessage(e)` maps the contracts' custom errors (`BettingClosed`, `NotVerified` → links to `/verify`, `BadOutcome`, `ZeroAmount`, `BelowMinBet`, `NothingToClaim`, `NotResolved`, `UnknownEvent`, `FaucetCooldown`) to viewer copy and falls back to viem's short message. Bet flow: `approve` (if allowance short) → `bet`. Claim: `claim(eventId)`. Faucet: `faucet()`.

## Web env

`NEXT_PUBLIC_CHAIN_ID` (31337 | 84532), `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_ARENA_ADDRESS`, `NEXT_PUBLIC_USDC_ADDRESS`, `NEXT_PUBLIC_GATE_ADDRESS`, `NEXT_PUBLIC_SUBGRAPH_URL?`, `NEXT_PUBLIC_PRIVY_APP_ID?`, `NEXT_PUBLIC_DEV_WALLET_KEY?`, `NEXT_PUBLIC_GATE_MODE` (world | checkbox), `NEXT_PUBLIC_WORLD_APP_ID?`, `NEXT_PUBLIC_WORLD_ACTION?`, `DATABASE_URL`, `GATE_OWNER_PRIVATE_KEY`, `GATE_MODE?` (server-side override of the gate mode), `WORLD_APP_ID?`, `WORLD_API_KEY?`, `WORLD_RP_ID?`, `WORLD_RP_SIGNING_KEY?`. Template: `apps/web/.env.local.example`; the real file is `apps/web/.env.local` (gitignored).

`apps/web` runs on **webpack**, not Turbopack (`next dev --webpack` / `next build --webpack` plus `experimental.extensionAlias`): Prisma 7 generates TypeScript that imports itself with `.js` specifiers, which Turbopack cannot resolve. Setting `importFileExtension = "ts"` on the `db` generator would let Turbopack back in.

## Engine env (`apps/engine/.env`)

`DATABASE_URL`, `RPC_URL`, `CHAIN_ID`, `RESOLVER_PRIVATE_KEY`, `ARENA_ADDRESS`, `DEMO_MODE`, `ALWAYS_ON`, `CHANNELS`, `MEDIA_DIR`, `MEDIA_BASE_URL`, `MEDIA_PORT` (static server with HTTP Range), `MEDIA_STORE` (local | blob), `MEDIA_KEEP` (published media retained per channel, default 20), `BLOB_READ_WRITE_TOKEN?`, `STUB_MODE` (1 = canned author + ffmpeg renderer, no OpenRouter), `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` (default `https://openrouter.ai`; e2e points at the fake), `AUTHOR_MODEL` (`openai/gpt-5-mini`), `FILLER_MODEL` (`openai/gpt-5-nano`), `VIDEO_MODEL` (`minimax/hailuo-3-max`), `IMAGE_MODEL` (`google/gemini-3.1-flash-image`, key-art still), `MAX_SPEND_USD` (hard ceiling in USD on everything ever bought from OpenRouter, persisted in `World.spendUsd`; default 20; the engine pauses production with "spend cap reached" instead of crossing it — but the meter is only attached when `OPENROUTER_BASE_URL` is a billing host: a loopback vendor (the fake) runs uncapped and records nothing, so a fake soak cannot die of imaginary spend, `billsRealMoney` in `apps/engine/src/budget.ts`), `IMAGE_COST_USD` (per-image estimate for the key-art still, default 0.04), `SUBGRAPH_URL?` (pool state of the last settled event — `seq − 2`, because `seq − 1` is still taking bets when `seq` is authored — fed to authoring), `BRANCH_SEAL` (`1` = seal branch videos, default off), `BRANCH_SEAL_ROOT` (32 bytes of 0x-hex; required when `BRANCH_SEAL=1`), `REVEAL_SECRET` (bearer token for `/internal/reveal-key`; required when `BRANCH_SEAL=1`).

## OpenRouter (engine, day 3)

Read the live docs before writing a line: chat completions with structured outputs (`response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }`, `provider: { require_parameters: true }`, reasoning capture), and the video generation guide at `openrouter.ai/docs/guides/overview/multimodal/video-generation` (`POST /api/v1/videos` → job id → poll → download). Mirror the exact request/response shapes in the fake.

Fake server `apps/engine/src/fake/openrouter.ts` (stdlib `node:http`, no deps): same paths as the real API; chat completions return a schema-valid `Authored` object per channel (vary by seq; include a `reasoning` field); video jobs complete after about 1 s with an ffmpeg `testsrc2` clip of the requested duration and resolution served from the fake itself. `pnpm --filter engine fake` starts it on `FAKE_PORT`.

## Video pipeline (engine, day 3)

- `Authored.firstHalf` shots (5–15 s each) → clips at 480p → concat → `first.mp4`. `Authored.branches[i]` → clips at 768p → **`branch-<i>-<32 hex>.mp4`** (`branchFileName` in `apps/engine/src/media.ts`). The random suffix is fresh per render and exists only in `Event.branchUrls`: without it every unrevealed ending is downloadable at a guessable path while betting is open, since the event id and `MEDIA_BASE_URL` are both public. Clips within a list are generated in parallel (concurrency ≤ 8). Continuity: one key-art still per event as the image-to-video input for every first-half clip (image generation through OpenRouter if the docs offer it, else the first shot is text-to-video and its last frame, extracted with ffmpeg, becomes the key art); branch clips use the first half's last frame as their image-to-video input.
- **House style.** Two places, both exported and unit-tested: `CHANNEL_STYLE` (`apps/engine/src/author.ts`) is the per-channel Subject / Camera / On screen / Pacing block in the authoring system prompt, and `clipPrompt(channelId, shot)` (`apps/engine/src/render.ts`) wraps every prompt that reaches the video vendor — `CHANNEL_PREFIX[channel]` + the authored shot + `STYLE_SUFFIX` ("Real-time speed. No slow motion. Not cinematic. No film look. Natural light as it is."), trimmed to 600 chars. It is on the single `clip()` path, so first half, branches and `keyArtPrompt` all go through it. MiniMax has no negative-prompt field: constraints are plain positive sentences, never a negative list.
- No text burn-in (this machine's ffmpeg has no `drawtext`). The ticker is an HTML overlay in web from `Authored.ticker` plus the lock countdown and the live implied-YES odds of every market (`tickerLines` in `apps/web/src/lib/ticker.ts`, PRD story 12), and the studio cards (below) are an overlay too.
- Concat with the ffmpeg concat demuxer; re-encode if clip parameters differ.
- Per-event cost log: clips × seconds × rate (480p $0.05/s, 768p $0.08/s) → log line and `Event.costUsd` (`Float?`, migration `20260908164147_event_cost`). `Render` returns `{ url, costUsd }` / `{ urls, costUsd }` and the machine accumulates into the column.
- `Author.author(ctx)` takes `{ channelId, seq, canon, firstHalfSec, secondHalfSec }`; the durations come from `Timing` and the shot lists must sum to them.
- **The durations are clamped in code, not just asked for in the prompt.** A real probe of `openai/gpt-6-astra` at `firstHalfSec=15` / `secondHalfSec=10` came back with a 26 s first half and branches of 22/16/20 s. (The current default, `openai/gpt-5-mini`, came back at exactly 15 s and 10/10/10 on both probed channels, so the clamp did not fire — it is still the ceiling for whatever `AUTHOR_MODEL` is set to.) Video is billed per second, so after zod validation (and after the one validation retry) `apps/engine/src/author.ts` trims every list whose sum exceeds its target × 1.1: shorten the last shot down to the 5 s minimum, then drop trailing shots, always keeping at least one, and re-point any studio card whose `afterShot` was orphaned. Under-length is left as authored. Every adjustment logs before/after seconds. The video bill is bounded by `Timing`, never by what the model returns.
- `Authored.outcomes` is **3 to 5** labels (PRD: "three to five binary markets"); `Arena` accepts 2–8, the schema is the tighter of the two. Enforced in `apps/engine/src/authored.ts`, asked for in the authoring prompt, and matched by the fake and the stub author.
- **Studio cards** (PRD story 11): `Authored.cards` is 1 or 2 `{ afterShot: number; title: string; stats: [string, string] }`, the graphic the broadcast cuts to after first-half shot `afterShot` (an index into `Authored.firstHalf`). They are text, so web renders them as an overlay the way it renders the ticker — a left-aligned lower-third band inside the frame, not a full-frame card — timed off the shot boundaries in `Event.script`. `toPublic` turns `afterShot` into `EventPublic.cards[i].at` (seconds into the first half, summed from the shot durations — the shot list itself stays server-side) and `apps/web/src/components/event-stage.tsx` shows each card for `CARD_MS` (3.5 s, `apps/web/src/lib/playback.ts` → `cardAt`) from its cue while the event is `BETTING`.
- Media store: `local` (engine serves `MEDIA_DIR` on `MEDIA_PORT` with Range support and CORS) or `blob` (`@vercel/blob` `put`, public access). `storeFile(eventId, name, localPath) → url`; intermediate clips live in `MEDIA_DIR/.work/<eventId>`, are never served, and the whole per-event directory is deleted once `branches()` has stored its outputs. The key-art still is passed to the video API as a URL from this store, so **image-to-video against the real OpenRouter needs `MEDIA_STORE=blob`** (a `localhost` media URL is not reachable from their side).
- Single instance: the engine claims `MEDIA_DIR/engine.pid` at startup (both store kinds) and refuses to run beside a live pid — `engine already running as pid N`. It exits within 3 s of SIGINT/SIGTERM, saying `shutting down` first; a copy that outlived a SIGKILLed `pnpm`/`tsx` wrapper is stopped with `pkill -f 'src/index.ts'` (`docs/RUNBOOK.md` §3).
- Retention (`local` store only): when an event reaches `DONE` the engine deletes `MEDIA_DIR/<eventId>` for every event of that channel outside the newest **`MEDIA_KEEP`** (default 20) — `pruneEventMedia` in `apps/engine/src/media.ts`, driven by `Deps.pruneMedia`. Without it the published tree grows ~11 MB per event forever (1.9 GB after 25 minutes of DEMO on four channels). Video of an event older than the window 404s; the wall only replays the newest `DONE` event per channel, so keep `MEDIA_KEEP` above whatever history the UI shows. Blob storage is not swept.

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
  `resolve` still refuses to run before the committed round exists: it reverts `RoundNotPublished`
  until `block.timestamp >= roundTime(drandRound)`.
- a `DrandVerifier` — `resolve()` reverts `BadSignature` unless the BLS signature verifies against the
  evmnet group public key **for the round the event committed at creation**. `script/Deploy.s.sol`
  deploys one and sets it, so every deployed stack runs verified.

**The verifier is pinned per event.** `createEvent` copies the current `verifier` into
`eventVerifier[eventId]` (public getter, `address` in the ABI) and `resolve` reads that, never the
global. `setVerifier` therefore only changes how *future* events resolve: an owner cannot drop an
event that is already taking bets into trusted mode, nor swap in a permissive verifier under it.

**Minimum bet.** `Arena.MIN_BET` = `1e6` (1 USDC, 6 decimals); `bet` reverts `BelowMinBet` under it
(`ZeroAmount` still answers a stake of 0). It is a floor in dollars and nothing more.
`apps/web/src/lib/chain.ts` mirrors it as `MIN_BET` and the ticket refuses a smaller stake before it
asks for an approval.

**Void markets.** `claim` pays a market winner-take-all only while its winning side holds at least
`1/nOutcomes` of that market's pool. The outcome is `keccak % nOutcomes`, so that share is the true
probability of a market's YES and `nOutcomes ×` a stake is the true-odds payout ceiling. Below the
share
(`p[win] * nOutcomes < p[NO] + p[YES]`, which subsumes the old empty-winning-side case) the market is
**void**: both sides take their own stake back and no fee is charged. Two consequences to code
against: no market ever returns more than `nOutcomes ×` a stake, and buying the winning side of all
`nOutcomes` markets — the one sweep guaranteed to win a market — always costs more than it can pay,
which is what closes the dust-capture cliff `MIN_BET` only repriced. `apps/web/src/lib/chain.ts`
mirrors the rule and both helpers now take the outcome count:
`marketPayout(stake, pool, won, nOutcomes)` and `previewPayout(amount, yes, pool, nOutcomes)`, so a
price cell quotes `×1.00` for a stake that would leave its side under the share.

**Bail.** `bail(bytes32 eventId)` is permissionless and callable once an event exists, is unresolved
and `block.timestamp > lockTime + BAIL_DELAY` (3 days) — earlier reverts `BailTooEarly`, on a resolved
event `AlreadyResolved`, twice `EventBailed`. It sets `bailed[eventId]` and emits `Bailed(eventId)`.
After that `resolve` reverts `EventBailed` for good and `claim(eventId)` refunds every stake the caller
holds on every market of that event in full, no fee, zeroing the stakes (so a second `claim` reverts
`NothingToClaim`). It is the timeout escape hatch for a resolver that never shows up; nothing in the
engine calls it. (`EventBailed` rather than `Bailed` for the error because Solidity gives events and
errors one namespace.)

Gas: `resolve` costs ~73k in trusted mode and ~221k with the verifier (`DrandVerifier.verify` alone is
~153k). Numbers logged by `forge test -vv` (`test_ResolveGasInTrustedMode`, `test_ResolveWithVerifierAcceptsRealBeacon`).

## Gate / verification

`Gate.setVerified(addr, bool)` is `onlyOwner`; the owner key is `GATE_OWNER_PRIVATE_KEY` (the deployer). The web verify route is its only caller.

**Every `POST /api/verify` call must carry a wallet signature.** `message` is exactly `theworldiscollapsing verify <address> <unixSeconds>`, the timestamp must be within 5 minutes of the server clock, and viem `verifyMessage` must recover `address`. Without it anyone could spend the owner's gas verifying addresses they do not control. The route also rate-limits to one verification per address per minute **and** caps the whole instance at 30 `setVerified` transactions an hour (`verifyGasCap` in `apps/web/src/lib/limits.ts`, 429 beyond it) — the per-address limit alone is bypassed by generating fresh addresses, and every one of those costs the owner gas. World Selfie Check uses `@worldcoin/idkit` 4.2 on the client → proof → `POST /api/verify` → World verify endpoint per the live docs → `setVerified`. The widget is given `signal = address`, so every credential response carries `signal_hash = hashSignal(address)`; the route re-derives that hash **from the signed address, never from a client-supplied signal** and refuses a proof that does not carry it (`proofBoundTo` in `apps/web/src/lib/world.ts`), which is what stops one Selfie Check from verifying any number of addresses. See docs/RESEARCH.md for the field-by-field source. 18+ is a self-attest checkbox at signup in both modes. Checkbox mode: `POST /api/verify { address, attest: true }` → `setVerified`. Faucet and bet are gated on chain; the UI explains why and how to fix it when a user is unverified.

## Timing

REAL: txBuffer 15 s, first half 60 s, second half 60 s, pause 30 s. DEMO: 3 / 15 / 10 / 5 s.

## Local stack

| Service | Port(s) | Notes |
|---|---|---|
| Postgres (docker) | 5433 | `docker compose up -d`. Use a separate database per agent: `CREATE DATABASE twic_web;` etc. via `docker exec theworldiscollapsing-db-1 psql -U twic -d twic -c ...`. |
| anvil | 8545 (web agent), 8546 (subgraph agent), 8547 (cre agent) | `anvil --port N`. Deploy: `RESOLVER=<acct0> TREASURY=<acct9> forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:N --private-key <acct0 key> --broadcast`; addresses in `broadcast/Deploy.s.sol/31337/run-latest.json`. The script also deploys `DrandVerifier` and calls `arena.setVerifier(...)`. |
| engine media | 4000 / 4001 / 4002 (cre agent) | `MEDIA_PORT` |
| fake OpenRouter | 4100 / 4101 | `FAKE_PORT` |
| graph-node | 8000 (GraphQL), 8001, 8020 (admin), 8030 (status), 8040; ipfs 5001; its own postgres 5434 | `docker compose -f packages/subgraph/docker-compose.yml up -d`. Ethereum network name `localhost` → `host.docker.internal:${ANVIL_PORT:-8545}`, so it follows the root README's anvil by default and an agent's with `ANVIL_PORT=8546 docker compose … up -d`. Start anvil **before** graph-node: it blocks on provider validation until the RPC answers, leaving port 8020 closed. Teardown with `down -v`. Then `ARENA_ADDRESS=<arena> pnpm --filter subgraph run prepare:local`, `codegen`, `build`, `create-local`, `deploy-local`, and set `NEXT_PUBLIC_SUBGRAPH_URL=http://localhost:8000/subgraphs/name/twic/arena` — that opt-in is the only thing that makes `/markets` and `/positions` show anything. |
| web | 3000 | `pnpm --filter web dev` |

anvil account 0: `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` / `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`. Account 1: `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` / `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d`.

The treasury is anvil **account 9**, `0xa0Ee7A142d267C1f36714E4a8F75612F20a79720`: nothing else in the stack plays from it (account 1 is the dev wallet, the synthetic bettors have keys of their own), so its USDC balance is the accrued 2 % fee and a reviewer can check the house take against it. Never point `TREASURY` at an account that also bets — the fee round-trips and looks like it was never charged.

### Synthetic bettors

`pnpm --filter engine bettor` (`apps/engine/scripts/bettor.ts`, tsx + viem) keeps every open market busy: it discovers `BETTING` events across all channels through Prisma and, until three seconds before each `lockTime`, places bets — random bettor, market, side and log-uniform amount — so no market ends up void under `Arena.claim`. **Coverage is the void ratio, not "both sides non-zero"**: the planner (`apps/engine/src/bettor-plan.ts`, pure and seeded) sizes every bet so each side keeps at least its `1/nOutcomes` share, fills every short (market, side) slot before spending a tick on volume, and skips a slot it cannot fill rather than under-funding it. It funds, verifies, faucets and approves each bettor first, then claims once the event resolves and prints payouts and per-bettor P&L. Perpetual until SIGINT/SIGTERM; `--events N` stops after N events have been bet and claimed. It loads `apps/engine/.env` itself. Start it **before** the engine: it only bets on windows it is running for, and it only claims events it opened in its own process.

Env (flags `--rpc/--arena/--usdc/--gate/--db/--owner/--keys/--events` override): required `BETTOR_KEYS` (comma-separated private keys), `GATE_OWNER_PRIVATE_KEY` (the Gate owner — anvil account 0 locally, the deployer on testnet — which also verifies the bettors and pays their gas out of its own balance), `RPC_URL`, `CHAIN_ID`, `ARENA_ADDRESS`, `USDC_ADDRESS`, `GATE_ADDRESS`, `DATABASE_URL`. Optional: `BETTORS` (how many keys to use, default all), `BET_MIN_USDC` (1), `BET_MAX_USDC` (50), `BET_INTERVAL_MS` (3000 — the *slowest* gap; the plan jitters 0.6x–1.4x and speeds up on its own when the slots left do not fit in the window, floor 200 ms), `FUND_MIN_ETH` (0.005), `FUND_ETH` (0.01), `BETTOR_SEED` (default time-based; the same seed replays the same bets), `POLL_MS` (receipt polling: 200 ms on anvil, 2000 ms elsewhere — the engine applies the same rule without a knob, `apps/engine/src/chain.ts`).

## Rules

- No mocks in product code paths. Fakes only in tests and e2e, selected by env base URLs.
- Never commit `.env`. No co-author trailers on commits. Conventional commits, one concern per commit.
- Typecheck, tests and build of every package you touched must pass before you report done. Report the exact commands and their output. A claim without runnable evidence is not done.
- Do not add dependencies beyond what is installed unless the task cannot be done without them; if you must, run `pnpm add` and retry once on a lockfile error.
- Kill every process you started before you finish.
