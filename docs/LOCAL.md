# Run the whole thing locally

Needs Node 24 (`.nvmrc`), pnpm 9, [Foundry](https://getfoundry.sh), Docker and ffmpeg. Nothing below needs an API key or a funded account: video is stubbed with ffmpeg test patterns, the chain is anvil, the money is fake. Demo timing puts a full event (bet, lock, resolve, reveal, claim) at about 35 seconds.

**1. Install, database, migrations** (once):

```bash
pnpm install
docker compose up -d                       # Postgres on 5433
printf 'DATABASE_URL=postgresql://twic:twic@localhost:5433/twic\n' > packages/db/.env
pnpm --filter db run generate
pnpm --filter db run deploy                # applies packages/db/prisma/migrations
```

**2. Chain.** Leave anvil running in its own terminal:

```bash
anvil                                      # terminal 1: 127.0.0.1:8545
```

then deploy (anvil account 0 is the deployer, resolver and gate owner; account 9 is the treasury. Nobody bets from it, so the 2 % fee is a balance you can watch grow):

```bash
cd packages/contracts
RESOLVER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
TREASURY=0xa0Ee7A142d267C1f36714E4a8F75612F20a79720 \
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --broadcast
```

On a fresh anvil the addresses are deterministic and match the env below: Gate `0x5FbDB231…`, USDC `0xe7f1725E…`, Arena `0x9fE46736…`. The script also deploys `DrandVerifier` and calls `setVerifier`, so resolution is BLS-verified on chain from the first event.

**3. Env files.** Both are gitignored; paste them verbatim:

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

Those are anvil's published test keys, which is the only reason they can sit in a doc. Real keys go nowhere near a tracked file. The full variable lists (OpenRouter, Reactor, Privy, World, Vercel Blob, branch sealing) are in `apps/engine/.env.example` and `apps/web/.env.local.example`; set `STUB_MODE=0` with a `REACTOR_API_KEY` or an `OPENROUTER_API_KEY` for real video.

**4. Run**, one terminal each (if you want synthetic volume, start the bettor below *first*; the engine opens its first four events within seconds):

```bash
pnpm --filter engine start                 # terminal 2: the loop, and the media server on 4000
pnpm --filter web dev                      # terminal 3: http://localhost:3000
```

The wall fills in as the first four events author, render and go on chain.

## Synthetic bettors

They fund, verify and faucet themselves, then bet both sides of every market of every open event and claim when it resolves, perpetually, until Ctrl-C. Give them six keys in `BETTOR_KEYS` (anvil prints ten accounts at startup; 2 to 7 are unused by the rest of the stack) and the Gate owner in `GATE_OWNER_PRIVATE_KEY`. That account verifies them and pays their gas out of its own balance. **Start them before the engine**: a bettor that arrives after an event has opened misses that whole betting window, so the first event on each channel ends with empty pools.

```bash
BETTOR_KEYS=<six anvil keys, comma-separated> \
GATE_OWNER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
RPC_URL=http://127.0.0.1:8545 \
ARENA_ADDRESS=0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0 \
USDC_ADDRESS=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 \
GATE_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3 \
DATABASE_URL=postgresql://twic:twic@localhost:5433/twic \
BET_INTERVAL_MS=1500 BETTOR_SEED=424242 \
pnpm --filter engine bettor                # --events 2 stops after two events
```

Everything but the keys can live in `apps/engine/.env` instead; the script loads it itself, and the shell wins. `BETTOR_SEED` makes a run replayable; without it the seed is time-based and printed on the first line. Measured on 2026-09-10: 10 minutes of this against four channels put 776 bets on 68 events with both sides funded on every market, paid 222 claims and left 130.68 USDC of fees in the treasury.

The house take is that treasury's balance, so you can watch it accrue while they play:

```bash
cast call 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 \
  "balanceOf(address)(uint256)" 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720 \
  --rpc-url http://127.0.0.1:8545
```

## Local subgraph

Live pools are on the wall tiles and the event page, which read `Arena` directly, no extra stack. The markets list and positions pages read the **subgraph** instead, and stay in a "not configured" state until you point `NEXT_PUBLIC_SUBGRAPH_URL` at one. Locally that is graph-node in docker ([`packages/subgraph/README.md`](../packages/subgraph/README.md)), with the anvil of step 2 already up:

```bash
docker compose -f packages/subgraph/docker-compose.yml up -d   # graph-node 8000/8020/8030, ipfs 5001, pg 5434
ARENA_ADDRESS=0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0 pnpm --filter subgraph run prepare:local
pnpm --filter subgraph run codegen && pnpm --filter subgraph run build
pnpm --filter subgraph run create-local && pnpm --filter subgraph run deploy-local
printf 'NEXT_PUBLIC_SUBGRAPH_URL=http://localhost:8000/subgraphs/name/twic/arena\n' >> apps/web/.env.local
```

Restart `pnpm --filter web dev` afterwards and `/markets` fills in as events index. Everything else works without it.

## Turning the optional parts on

- **Real video**: `docs/RUNBOOK.md` sections 6 and 7 (Reactor, OpenRouter fallback, the Python sidecar).
- **World Selfie Check** instead of the checkbox: `docs/WORLD.md`, and `docs/RUNBOOK.md` section 8 for production.
- **Branch sealing and the Chainlink CRE workflow**: `docs/CRE.md`, and `docs/RUNBOOK.md` section 9 for production.
- **Which key or account unlocks what**: `docs/SETUP.md`.

## Checks

```bash
pnpm --filter contracts exec forge test
pnpm --filter engine test
pnpm --filter web test
node docs/readme.check.mjs                 # README and this file still name real scripts and env vars
```
