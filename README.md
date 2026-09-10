# theworldiscollapsing

An autonomous fictional universe broadcast as a wall of TV channels, with a provably-random parimutuel casino attached to every event. ETHOnline 2026. Testnet and play money only.

Four channels each run one event at a time. An event is an AI-generated video that *is* the event — a football match, an election night, an awards show — and its outcomes are the markets. The first half plays while betting is open. Betting locks on chain. A drand round that was fixed before the first bet lands, its signature picks the outcome, and the matching second half (rendered during the first half, withheld until then) plays immediately. Winners claim, the result becomes canon, the next event in that channel builds on it, and the loop repeats with nobody touching it.

## How it works

```mermaid
flowchart LR
  A[author<br/>GPT-6 Astra, strict JSON] --> R[render first half<br/>+ every second half, hidden]
  R --> C[createEvent<br/>lock time + drand round committed]
  C --> B[BETTING<br/>first half plays, pools open]
  B --> L[LOCKED<br/>round not yet published]
  L --> V[resolve<br/>beacon verified on chain<br/>outcome = keccak sig, id mod n]
  V --> P[REVEAL<br/>winning branch plays]
  P --> K[canon<br/>result becomes world history]
  K --> A
```

- **Randomness**: drand `evmnet` (BN254). The round is committed in `createEvent` and must land at least 10 s after betting locks. `resolve` verifies the BLS signature on chain (`packages/contracts/src/DrandVerifier.sol`) and derives the outcome with a keccak.
- **Markets**: every outcome of an event is a YES/NO parimutuel market. One beacon settles all of them. Payout is stake × total pool ÷ winning pool, less 2 %.
- **Video**: the first half is shared and ends level; one full second half is rendered per outcome during the first half and kept hidden. Only the winning branch URL ever leaves the API (`apps/web/src/lib/public.ts`), so nobody can skip ahead.
- **Engine**: one Node process, one state machine per channel, restart-safe against chain state, presence-gated so an empty site costs nothing. `apps/engine/src/machine.ts`.
- **World state**: canon lines in Postgres, injected into every authoring prompt. No simulation, just memory.

## Live

Base Sepolia (chain 84532), deployed 2026-09-10 from block 46631130. Testnet and play money — `MockUSDC.faucet` mints 1,000 a day to any verified address.

| | |
|---|---|
| Site | <https://theworldiscollapsing.vercel.app> |
| Subgraph (Studio) | <https://api.studio.thegraph.com/query/1760049/twic-arena/0.0.1> |
| `Arena` | [`0xcC9D2B9A192a6Ff5F3C5950EcdFd4CaF958fFe1b`](https://sepolia.basescan.org/address/0xcc9d2b9a192a6ff5f3c5950ecdfd4caf958ffe1b#code) |
| `DrandVerifier` | [`0x1cdD3198E323BC816125CF40B22A11c65111a405`](https://sepolia.basescan.org/address/0x1cdd3198e323bc816125cf40b22a11c65111a405#code) |
| `MockUSDC` | [`0x763CD7478F3d4D2320c01C383dD8CF57119cf970`](https://sepolia.basescan.org/address/0x763cd7478f3d4d2320c01c383dd8cf57119cf970#code) |
| `Gate` | [`0xF7ff820BBcD99fd59E47C50aAE1fAa7DBbdC5527`](https://sepolia.basescan.org/address/0xf7ff820bbcd99fd59e47c50aae1faa7dbbdc5527#code) |

All four are source-verified on Basescan. Three events have resolved on chain under that verifier against real drand `evmnet` beacons; the one with real generated video is [`0x4734962d…`](https://theworldiscollapsing.vercel.app/e/0x4734962dd63171cb92e109ac5d31cbb5cf27ca797f94c647084ec8e71a006019) — "United–Chelsea: The Fourth Meeting", round 20503772, outcome 1. Open it and the verify badge fetches that round from `api.drand.sh` in your browser, compares the signature with the one stored on chain and re-derives the outcome. Its winning branch does not play, for the reason in [Known issues](#known-issues).

## Run the whole thing locally

Needs Node 24 (`.nvmrc`), pnpm 9, [Foundry](https://getfoundry.sh), Docker and ffmpeg. Nothing below needs an API key or a funded account: video is stubbed with ffmpeg test patterns, the chain is anvil, the money is fake. Demo timing puts a full event — bet, lock, resolve, reveal, claim — at about 35 seconds.

**1 — install, database, migrations** (once):

```bash
pnpm install
docker compose up -d                       # Postgres on 5433
printf 'DATABASE_URL=postgresql://twic:twic@localhost:5433/twic\n' > packages/db/.env
pnpm --filter db run generate
pnpm --filter db run deploy                # applies packages/db/prisma/migrations
```

**2 — chain.** Leave anvil running in its own terminal:

```bash
anvil                                      # terminal 1 — 127.0.0.1:8545
```

then deploy (anvil account 0 is the deployer, resolver and gate owner; account 9 is the treasury — nobody bets from it, so the 2 % fee is a balance you can watch grow):

```bash
cd packages/contracts
RESOLVER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
TREASURY=0xa0Ee7A142d267C1f36714E4a8F75612F20a79720 \
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --broadcast
```

On a fresh anvil the addresses are deterministic and match the env below: Gate `0x5FbDB231…`, USDC `0xe7f1725E…`, Arena `0x9fE46736…`. The script also deploys `DrandVerifier` and calls `setVerifier`, so resolution is BLS-verified on chain from the first event.

**3 — env files.** Both are gitignored; paste them verbatim:

```bash
cat > apps/engine/.env <<'EOF'
DATABASE_URL=postgresql://twic:twic@localhost:5433/twic
RPC_URL=http://127.0.0.1:8545
CHAIN_ID=31337
RESOLVER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ARENA_ADDRESS=0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
DEMO_MODE=1
ALWAYS_ON=1
CHANNELS=sports,politics,culture,region
STUB_MODE=1
MEDIA_STORE=local
MEDIA_DIR=./media
MEDIA_PORT=4000
MEDIA_BASE_URL=http://localhost:4000
EOF

cat > apps/web/.env.local <<'EOF'
NEXT_PUBLIC_CHAIN_ID=31337
NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8545
NEXT_PUBLIC_ARENA_ADDRESS=0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
NEXT_PUBLIC_USDC_ADDRESS=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
NEXT_PUBLIC_GATE_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3
NEXT_PUBLIC_GATE_MODE=checkbox
NEXT_PUBLIC_DEV_WALLET_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
DATABASE_URL=postgresql://twic:twic@localhost:5433/twic
GATE_MODE=checkbox
GATE_OWNER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
EOF
```

Those are anvil's published test keys, which is the only reason they can sit in a README. Real keys go nowhere near a tracked file. The full variable lists — OpenRouter, Privy, World, Vercel Blob, branch sealing — are in `apps/engine/.env.example` and `apps/web/.env.local.example`; set `STUB_MODE=0` with an `OPENROUTER_API_KEY` for real video.

**4 — run**, one terminal each:

```bash
pnpm --filter engine start                 # terminal 2 — the loop, and the media server on 4000
pnpm --filter web dev                      # terminal 3 — http://localhost:3000
```

The wall fills in as the first four events author, render and go on chain. To put volume on it, four synthetic bettors (anvil accounts 2–5) will faucet, bet and claim through as many events as you ask for:

```bash
RPC_URL=http://127.0.0.1:8545 \
ARENA_ADDRESS=0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0 \
USDC_ADDRESS=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 \
GATE_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3 \
DATABASE_URL=postgresql://twic:twic@localhost:5433/twic \
pnpm --filter engine exec tsx scripts/bettor.ts --events 2
```

The house take is that treasury's balance, so you can watch it accrue while they play:

```bash
cast call 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 \
  "balanceOf(address)(uint256)" 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720 \
  --rpc-url http://127.0.0.1:8545
```

Live pools are on the wall tiles and the event page, which read `Arena` directly — no extra stack. The markets list and positions pages read the **subgraph** instead, and stay in a "not configured" state until you point `NEXT_PUBLIC_SUBGRAPH_URL` at one. Locally that is graph-node in docker ([`packages/subgraph/README.md`](packages/subgraph/README.md)), with the anvil of step 2 already up:

```bash
docker compose -f packages/subgraph/docker-compose.yml up -d   # graph-node 8000/8020/8030, ipfs 5001, pg 5434
ARENA_ADDRESS=0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0 pnpm --filter subgraph run prepare:local
pnpm --filter subgraph run codegen && pnpm --filter subgraph run build
pnpm --filter subgraph run create-local && pnpm --filter subgraph run deploy-local
printf 'NEXT_PUBLIC_SUBGRAPH_URL=http://localhost:8000/subgraphs/name/twic/arena\n' >> apps/web/.env.local
```

Restart `pnpm --filter web dev` afterwards and `/markets` fills in as events index. Everything else works without it.

## Trust model

The pitch is that nobody, including us, can know an outcome in advance. Here is exactly how much of that the code proves, and what you are still trusting us for.

### What the chain proves

- **The randomness is committed before the money.** `Arena.createEvent` stores the deciding drand round alongside the event and rejects it (`BadRound`) unless that round is published at least `SUSPENSE_GAP` = 10 s after `lockTime`. `bet` reverts (`BettingClosed`) at `lockTime`. So every bet is placed before the signature that decides it exists anywhere — not merely before anyone here has seen it.
- **The outcome is a public function of that signature.** `outcome = uint(keccak256(signature ‖ eventId)) % nOutcomes`, recomputable by anyone from the `Resolved` event. No operator input, no commit-reveal, no VRF, no oracle, no ZK.
- **`resolve` cannot run early, twice, or on a made-up signature.** It reverts before `lockTime` (`BettingOpen`), after resolution (`AlreadyResolved`), and — because `script/Deploy.s.sol` deploys `DrandVerifier` and calls `setVerifier` — unless the 64-byte BN254 signature verifies on chain against drand `evmnet`'s group key **for the round this event committed to at creation** (`BadSignature`). A genuine beacon from the wrong round fails the pairing, not just a length check; both directions are tested in `packages/contracts/test/DrandVerifier.t.sol`.
- **The verifier is pinned when the event opens, not when it settles.** `createEvent` records the verifier of the moment in `eventVerifier[eventId]` and `resolve` reads that one, so a later `setVerifier` — including `setVerifier(address(0))` — only changes events created after it. Nobody can move an event that is already taking bets into trusted mode, or under a verifier that waves anything through. In trusted mode (no verifier at creation, which is not how this is deployed) `resolve` still refuses to run until the committed round is actually published (`RoundNotPublished`).
- **An event that is never resolved refunds.** `bail(eventId)` is callable by anyone 3 days after `lockTime` (`BAIL_DELAY`) while the event is unresolved; after it, `resolve` is closed for good and `claim` hands every staker their stakes back in full on every market of that event, no fee. Being ignored is the worst the resolver can do to your money.
- **You do not have to take our word for the beacon.** The signature is stored and emitted, and the event page fetches that round from `api.drand.sh` in your browser, compares it byte for byte and re-derives the outcome (the verify badge).
- **The payout arithmetic is parimutuel and in the contract.** `stake × total pool ÷ winning pool`, less a flat 2 % (`FEE_BPS = 200`) to the treasury, rounding dust left behind. A market pays winner-take-all only while its winning side holds at least `1/nOutcomes` of the market's pool. Under that — an empty winning side and a dusted one alike — the market is **void**: both sides take their own stake back and no fee is charged. The outcome here is `keccak % nOutcomes`, so `1/nOutcomes` is not a guess at the odds, it is the true probability of any market's YES; paying more than `nOutcomes ×` a stake would be paying over true odds. That ceiling is also what closes the capture: buying the winning side of every outcome — the one sweep guaranteed to win a market — costs `nOutcomes ×` a stake and can never pay more back. The house is escrow; bettors are paid by other bettors.

### What it does not prove

- **Liveness.** Only the `resolver` address can call `resolve`, and `claim` requires a resolved event. The resolver cannot change an outcome, but it can stall one: there is no permissionless resolve path, so a stalled event pays nothing for three days, until anyone calls `bail` and it refunds instead of settling. The *amount* you are owed does not trust us; the *timing* does.
- **Admin keys.** `Arena` is `Ownable`: the owner can `setResolver`, `setTreasury`, and `setVerifier(address(0))`, which puts future events into trusted mode where the submitted signature is only checked off chain — events already open keep the verifier they were created under. The `Gate` owner decides who is verified at all. In this deployment one key holds all of it.
- **The video vendor.** Every prompt, including the shot lists for branches that never air, goes to OpenRouter in plaintext while betting is open. The vendor learns what every ending looks like. It cannot learn or influence which one happens — that is drand's job — but the prompts are not confidential, and no TEE would change it, because TLS terminates at the vendor (`docs/RESEARCH.md`).
- **That the video matches the chain.** Nothing on chain commits to the video files. The engine reads the on-chain outcome and publishes the matching branch; a dishonest operator could publish a branch that contradicts it, and settlement would still follow the signature. The broadcast is the show, not the proof.
- **Branch sealing is a spoiler lock, not a fairness claim.** With `BRANCH_SEAL=1` the branch files are published as AES-256-GCM ciphertext and a Chainlink CRE confidential workflow releases only the winning key after `Resolved` (`key_i = keccak256(root ‖ eventId ‖ i)`). That stops a curious viewer reading the ending off the media server early. It says nothing about the outcome, which was already unknowable, and the operator holds the root either way. Off by default.
- **Anything about the odds being "right".** The outcome is uniform over the event's outcome space; the world model is canon injection, not a simulation. Prices are the pool ratio between bettors, and nothing more.
- **Identity.** World Selfie Check — or the checkbox fallback — gates the faucet and betting to slow bots down. It is per address, not per person, and it is not age verification: 18+ is self-attested.
- ⚠ **Scale of the claim.** This is testnet play money: `MockUSDC.faucet` mints 1,000 to any verified address once a day. The contracts are live on Base Sepolia ([Live](#live)) and `DrandVerifier` has now checked real `evmnet` beacons there — 261,292 gas for a verified `resolve` — not only on anvil and in `forge test`. What has and has not run against a real vendor or a real chain is recorded in [`docs/RESEARCH.md`](docs/RESEARCH.md).

## Status

The PRD ([issue #1](https://github.com/easonchai/theworldiscollapsing/issues/1)) is 65 user stories; 61 of them are built and verified — on a local stack (anvil, docker Postgres, fake OpenRouter, local graph-node, Playwright) and, on 2026-09-10, on Base Sepolia with real OpenRouter authoring and real MiniMax video. The other 4 — stories 18, 23, 43, 44 — are the Pending column below: a first half that visibly *shows* the score level at the break (18 — the authored premise says level and the rendered football is real, but no generated frame carries a readable scoreboard, so this is asserted, not shown), Privy email login (23 — the production domain is not in the Privy app's allowed origins, see [Known issues](#known-issues)), and World Selfie Check (43, 44; the 18+ checkbox of story 46 is what runs). Open bugs are in [Known issues](#known-issues). What to obtain and what it turns on is in [`docs/SETUP.md`](docs/SETUP.md); deploying is [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

| Area | Verified | Pending |
|---|---|---|
| Contracts | 40 Foundry tests incl. real evmnet rounds verified on chain, tampered and wrong-round rejected, per-event verifier pinning, bail refunds, the minimum bet, void markets. Deployed to Base Sepolia and source-verified on Basescan; 3 events resolved there against live beacons (`createEvent` 77,368 gas, verified `resolve` 261,292) | — |
| Engine | 70 tests; 20-event unattended soak over 4 channels; SIGKILL mid-event and resume without duplicate events; presence gating. Real GPT-6 Astra authoring, real MiniMax clips and the Vercel Blob store, on anvil and on Base Sepolia — $3.27 an event, spend metered against `MAX_SPEND_USD` | bettor-sentiment authoring (`SUBGRAPH_URL`) has never run against a live index |
| Web | 79 tests; wall, channel, event, markets, positions, verify flows in a browser; bet → lock → reveal → claim with on-chain numbers checked. In production: the wall and the event page play real generated video from Blob, the verify badge re-derives the outcome from live drand, `/markets` reads the Studio subgraph | Privy login (CSP-blocked on the production domain), World Selfie Check |
| Subgraph | 5 matchstick tests; pools, outcomes, claims and totals equal `cast` reads against a local graph-node. Deployed to Studio, indexing Base Sepolia with no indexing errors, and read by `/markets` in production | Subgraph MCP (needs a published subgraph and a gateway key) |
| CRE | workflow compiles to WASM, 7 handler tests, engine seal/unseal round trip | `cre workflow simulate` and deploy (login-gated), Confidential Workflows beta |

## Sponsor integrations

| Sponsor | What | Where |
|---|---|---|
| The Graph | subgraph indexing every `Arena` event; the engine reads the previous event's pools from it when authoring; markets and positions pages read it | `packages/subgraph`, `apps/engine/src/author.ts`, `apps/web/src/app/markets`, `apps/web/src/app/positions` |
| Privy | email login + embedded wallet, Base Sepolia default, behind one `useWallet()` hook | `apps/web/src/components/wallet.tsx` |
| World | Selfie Check via IDKit 4 with signed `rp_context`, server-side v4 verify, then `Gate.setVerified` on chain; checkbox fallback | `apps/web/src/app/verify`, `apps/web/src/app/api/verify`, `apps/web/src/app/api/world/rp-context` |
| Chainlink CRE | confidential workflow releases only the winning branch key after `Resolved` | `packages/cre`, `apps/engine/src/seal.ts` |

## Known issues

Findings from the end-to-end validation, an adversarial review of the money path, and the first real-money runs. Struck lines are fixed and carry what the fix was; the rest are still open. Severity is the reviewer's.

**From the first real-video runs and the Base Sepolia deploy (2026-09-10)**

- ~~high, `apps/engine/src/machine.ts`: **the reveal can lose its branches.** `case "RESOLVE"` reads `branchUrls` off the row `produce()` handed it, so when the branch render finished *before* resolve — which real, fast rendering makes likely — `inflightBranches` has already dropped its entry and `ensureBranches` starts a *second* render. That one throws `ENOENT` on the already-swept `media/.work/<id>/last.png`, the step logs `branches unavailable at reveal`, and it then persists `branchUrls: null` over three URLs the database already held. Seen on Base Sepolia event `0x4734962d…`: branches finished at 09:26:36, resolve ran at 09:26:44, and the event page replayed the first half instead of the winning branch. Latent money bug too: had the work directory survived, the second render would have re-bought every branch clip (~$2.40).~~ Fixed: `RESOLVE` waits for a branch render that is still running, otherwise reads the URLs the render stored, and only renders again when nothing was stored; it never writes null over stored URLs. Reproduced by a test with the real timeline (`machine.test.ts`, "reveals branches that finished in the background"). The production row for `0x4734962d…` was repaired by hand from the Blob listing and its winning branch plays.
- ~~medium, `machine.ts` / `chain.ts`: **a `BlockNotFoundError` right after a write loses the transaction hash.** Public `https://sepolia.base.org` load-balances across nodes at different heights, so the block read that follows a receipt can be told the block does not exist. The step then retried and took the "event already exists on chain" resume path, which adopts the on-chain state with `tx: null`, so `Event.createTx` / `resolveTx` are NULL and the event page has no explorer link. It hit 4 of 4 chain writes on 2026-09-10.~~ Fixed: `chain.ts` retries the block read on `BlockNotFoundError` (up to 20 s) instead of failing the step, so the hash is kept. The five events already on Base Sepolia keep their NULL hashes. A keyed RPC is still the right choice.
- medium, `apps/web/src/lib/data.ts`: `getChannels` prefers *any* live event over the newest `DONE` one, so stopping the engine mid-cycle pins a tile at "Locked" forever instead of replaying the last finished event. Let the current event finish before stopping, or skip live events whose `lockTime` passed more than a grace period ago.
- medium, deployment: **Privy login cannot open on the production domain.** `https://theworldiscollapsing.vercel.app` is not in the Privy app's allowed origins, so the login iframe is refused by `frame-ancestors` and every page carries that CSP error in the console. A Privy dashboard change, not a code change (`docs/SETUP.md`, item 7). PRD story 23 is unmet until it is made.

**Open validation findings**

- ~~high, web: client writes report success without checking `receipt.status`, so a reverted bet shows "Bet confirmed". Root cause for PRD stories 29 and 30.~~ Fixed: approve, bet, claim and faucet simulate first (custom errors mapped to viewer copy, `NotVerified` links to `/verify`) and every write goes through `confirmed`, which fails on `receipt.status !== "success"`.
- ~~medium, web: the engine authors studio cards but nothing renders them (story 11).~~ Fixed: `EventPublic.cards` carries the cue in seconds and the event stage runs each card as a lower third from its cue.
- ~~medium, web: the ticker overlay shows authored lines only, no pool odds or countdown (story 12).~~ Fixed: `tickerLines` appends the lock countdown and the live implied-YES odds of every market to the authored straps.

**Review findings confirmed by two of three independent refuters**

- ~~critical, `Arena.sol`: one micro-USDC on the empty side of a market converts an "everyone refunded" market into "one bettor takes the whole pool". `MIN_BET` repriced that capture at 1 USDC per outcome; it did not close it.~~ Fixed: the ceiling is a ratio, not a floor. `claim` pays winner-take-all only while the winning side holds at least `1/nOutcomes` of the market's pool and voids the market below that, refunding both sides, so a market returns at most `nOutcomes ×` a stake and the sweep across every outcome always costs more than it pays. `test_MinBetOnEveryOutcomeCannotCaptureThePool` runs the capture at the stake `MIN_BET` actually permits — 1 USDC on all five outcomes against a 25 USDC-per-market crowd — and the sweep ends 4 USDC down instead of 20.48 up; `test_WinningSideIsPaidToItsUniformShareAndVoidedBelowIt` pins both sides of the line.
- ~~critical, `Arena.sol`: the verifier is not pinned per event, so the owner can switch to trusted mode after bets land.~~ Fixed: `createEvent` pins `eventVerifier[eventId]` and `resolve` reads that, so `setVerifier` only reaches future events.
- ~~critical, `apps/engine/src/media.ts`: a malformed percent-escape in a request URL kills the engine process.~~ Fixed: the decode is wrapped, a bad escape is a 400 and the server keeps serving.
- ~~high, `media.ts`: no error handler on the response stream, so a file-open failure crashes the engine.~~ Fixed: headers wait for the file descriptor, so a file that stats but will not open answers 500; the response's own errors close the stream.
- ~~high, `machine.ts` / `render.ts`: `costUsd` omits failed and retried generations; there is no spend ceiling.~~ Fixed: every clip attempt, key-art image and authoring call is charged against `MAX_SPEND_USD`, persisted in `World.spendUsd`.
- ~~high, `machine.ts` / `drand.ts`: beacon fetch retries forever with no timeout or abort.~~ Fixed: `fetchRound` carries an `AbortSignal.timeout` (10 s), so a hung request fails and the retry loop keeps its cadence.
- ~~medium, `machine.ts`: canon lines are appended twice if the CANON step re-runs.~~ Fixed: `appendCanon` is idempotent per event id.
- medium, `machine.ts`: `lockTime` is computed before the tx is mined, so tx latency eats the betting window. Live on Base Sepolia this once cost a whole window — a `BlockNotFoundError` step retry (since fixed, above) opened one event with about 5 s left to bet — and ordinary tx latency still shaves a few seconds off every window.
- low, `Arena.sol`: the ordering guarantee rests on the chain clock being within 10 s of drand's.

**Review candidates not yet adjudicated** (the refuters ran out of session budget)

- ~~high, `Arena.sol`: in trusted mode `resolve` never checks that the committed round has been published.~~ Fixed: a trusted-mode event reverts `RoundNotPublished` until `block.timestamp >= roundTime(drandRound)`.
- ~~medium, `Arena.sol`: no escape hatch if an event is never resolved; stakes stay locked.~~ Fixed: permissionless `bail(eventId)` 3 days after `lockTime` closes `resolve` and turns `claim` into a full, fee-free refund.
- low, `Arena.sol`: 2 % fee is charged on principal when nobody took the other side.
- ~~high, `api/verify`: per-address rate limit is bypassed with fresh addresses; gas drain on the gate owner; no already-verified short-circuit.~~ Fixed: an address the gate already knows returns `{ verified: true, tx: null }` without a transaction, and the instance sends at most 30 `setVerified` txs an hour (429 beyond) on top of the per-address minute.
- ~~medium, `api/verify` (world mode): the proof's signal is not bound to the target address.~~ Fixed: the widget signs the address as the signal and the route refuses any proof whose `responses[].signal_hash` is not `hashSignal(<the signed address>)`.
- ~~medium, `api/heartbeat`: unauthenticated and unthrottled, and it is the only thing gating paid generation.~~ Fixed: same-origin only (403 otherwise), one accepted beat per client IP per 10 s, 204 either way.
- ~~medium, `machine.ts`: a database reset against a live `Arena` replays stale on-chain events with a zero betting window.~~ Fixed: an on-chain twin whose lock has already passed marks the row `SKIPPED` and the channel moves on.
- medium, `chain.ts`: one global tx queue plus viem's receipt timeout; a stuck tx blocks all channels.
- ~~low, `index.ts`: mode flags are exact-string `1` comparisons, so `true` silently means off.~~ Fixed: `flag()` in `apps/engine/src/env.ts` accepts `1` and `true`, any case.

## Repo

| Path | What |
|---|---|
| `packages/contracts` | Foundry: `Arena` (parimutuel + drand resolve), `DrandVerifier` (BN254 BLS), `Gate`, `MockUSDC` |
| `packages/db` | Prisma schema and migrations — event content, canon, engine state |
| `apps/engine` | the unattended loop: author → render → create → bet → lock → resolve → reveal → canon → pause |
| `apps/web` | Next.js: the wall, channel and event pages, markets list, positions, verify |
| `packages/subgraph` | The Graph index of `Arena`, behind [its own README](packages/subgraph/README.md) |
| `packages/cre` | Chainlink CRE workflow that releases branch keys (stretch, off by default) |

[`docs/CONTRACTS.md`](docs/CONTRACTS.md) is the binding shared surface — names, routes, env vars, ports, the event lifecycle. [`docs/RESEARCH.md`](docs/RESEARCH.md) holds the verified vendor facts with sources.

## Checks

```bash
pnpm --filter contracts exec forge test
pnpm --filter engine test
pnpm --filter web test
node docs/readme.check.mjs                 # the commands and env vars above still exist
```
