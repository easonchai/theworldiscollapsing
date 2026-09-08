# theworldiscollapsing

An autonomous fictional universe broadcast as a wall of TV channels, with a provably-random parimutuel casino attached to every event. ETHOnline 2026. Testnet and play money only.

Four channels each run one event at a time. An event is an AI-generated video that *is* the event — a football match, an election night, an awards show — and its outcomes are the markets. The first half plays while betting is open. Betting locks on chain. A drand round that was fixed before the first bet lands, its signature picks the outcome, and the matching second half (rendered during the first half, withheld until then) plays immediately. Winners claim, the result becomes canon, the next event in that channel builds on it, and the loop repeats with nobody touching it.

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

The markets list and positions pages read from the subgraph and stay in a "not configured" state until you point `NEXT_PUBLIC_SUBGRAPH_URL` at one — that is a separate graph-node stack, see [`packages/subgraph/README.md`](packages/subgraph/README.md). Everything else works without it.

## Trust model

The pitch is that nobody, including us, can know an outcome in advance. Here is exactly how much of that the code proves, and what you are still trusting us for.

### What the chain proves

- **The randomness is committed before the money.** `Arena.createEvent` stores the deciding drand round alongside the event and rejects it (`BadRound`) unless that round is published at least `SUSPENSE_GAP` = 10 s after `lockTime`. `bet` reverts (`BettingClosed`) at `lockTime`. So every bet is placed before the signature that decides it exists anywhere — not merely before anyone here has seen it.
- **The outcome is a public function of that signature.** `outcome = uint(keccak256(signature ‖ eventId)) % nOutcomes`, recomputable by anyone from the `Resolved` event. No operator input, no commit-reveal, no VRF, no oracle, no ZK.
- **`resolve` cannot run early, twice, or on a made-up signature.** It reverts before `lockTime` (`BettingOpen`), after resolution (`AlreadyResolved`), and — because `script/Deploy.s.sol` deploys `DrandVerifier` and calls `setVerifier` — unless the 64-byte BN254 signature verifies on chain against drand `evmnet`'s group key **for the round this event committed to at creation** (`BadSignature`). A genuine beacon from the wrong round fails the pairing, not just a length check; both directions are tested in `packages/contracts/test/DrandVerifier.t.sol`.
- **You do not have to take our word for the beacon.** The signature is stored and emitted, and the event page fetches that round from `api.drand.sh` in your browser, compares it byte for byte and re-derives the outcome (the verify badge).
- **The payout arithmetic is parimutuel and in the contract.** `stake × total pool ÷ winning pool`, less a flat 2 % (`FEE_BPS = 200`) to the treasury, rounding dust left behind. A market whose winning side has no stake refunds every staker on that market in full. The house is escrow; bettors are paid by other bettors.

### What it does not prove

- **Liveness.** Only the `resolver` address can call `resolve`, and `claim` requires a resolved event. The resolver cannot change an outcome, but it can stall one, and there is no permissionless resolve path and no timeout refund. The *amount* you are owed does not trust us; the *timing* does.
- **Admin keys.** `Arena` is `Ownable`: the owner can `setResolver`, `setTreasury`, and `setVerifier(address(0))`, which puts future events back into trusted mode where the submitted signature is only checked off chain. The `Gate` owner decides who is verified at all. In this deployment one key holds all of it.
- **The video vendor.** Every prompt, including the shot lists for branches that never air, goes to OpenRouter in plaintext while betting is open. The vendor learns what every ending looks like. It cannot learn or influence which one happens — that is drand's job — but the prompts are not confidential, and no TEE would change it, because TLS terminates at the vendor (`docs/RESEARCH.md`).
- **That the video matches the chain.** Nothing on chain commits to the video files. The engine reads the on-chain outcome and publishes the matching branch; a dishonest operator could publish a branch that contradicts it, and settlement would still follow the signature. The broadcast is the show, not the proof.
- **Branch sealing is a spoiler lock, not a fairness claim.** With `BRANCH_SEAL=1` the branch files are published as AES-256-GCM ciphertext and a Chainlink CRE confidential workflow releases only the winning key after `Resolved` (`key_i = keccak256(root ‖ eventId ‖ i)`). That stops a curious viewer reading the ending off the media server early. It says nothing about the outcome, which was already unknowable, and the operator holds the root either way. Off by default.
- **Anything about the odds being "right".** The outcome is uniform over the event's outcome space; the world model is canon injection, not a simulation. Prices are the pool ratio between bettors, and nothing more.
- **Identity.** World Selfie Check — or the checkbox fallback — gates the faucet and betting to slow bots down. It is per address, not per person, and it is not age verification: 18+ is self-attested.
- ⚠ **Scale of the claim.** This is testnet play money: `MockUSDC.faucet` mints 1,000 to any verified address once a day. Deployment status of the contracts, including whether the verifier has ever run outside anvil and `forge test`, is recorded in [`docs/RESEARCH.md`](docs/RESEARCH.md).

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
