# Runbook: from the local stack to Base Sepolia

Prerequisite: the items in `docs/SETUP.md`. Commands marked ⚠ need a key and have not been run from this repo yet; everything else has.

## 0. Contract compatibility

Anything deployed before the day-7 change is incompatible: `Arena` now expects 64-byte drand `evmnet` signatures and a different genesis. Redeploy the whole set together (Gate, MockUSDC, Arena, DrandVerifier) and update every `ARENA_ADDRESS` / `NEXT_PUBLIC_*_ADDRESS`. If `forge script` says "No contract bytecode" after a contract was added, run `forge clean` first.

## 1. Database

```bash
printf 'DATABASE_URL=<neon pooled url>\n' > packages/db/.env
pnpm --filter db run generate
pnpm --filter db run deploy          # applies packages/db/prisma/migrations
```

Local reset (dev container only): `docker exec theworldiscollapsing-db-1 psql -U twic -d postgres -c 'DROP DATABASE IF EXISTS twic' -c 'CREATE DATABASE twic'`, then `pnpm --filter db run deploy`. Prisma 7's `migrate reset` asks an agent for a human consent string; a human at the keyboard can just run `pnpm --filter db run reset`.

Never reset a database that points at a live `Arena`: the engine would replay sequence numbers whose event ids already exist on chain and pick them up with a zero betting window (review item ENG-7). Fresh chain and fresh database go together.

## 2. Contracts on Base Sepolia ⚠

```bash
cd packages/contracts
cp .env.example .env                 # fill BASE_SEPOLIA_RPC_URL, BASESCAN_API_KEY, RESOLVER, TREASURY
set -a; source .env; set +a
forge clean
forge script script/Deploy.s.sol --rpc-url base_sepolia \
  --private-key <deployer key> --broadcast --verify
```

`foundry.toml` already maps `base_sepolia` to `BASE_SEPOLIA_RPC_URL` and the Etherscan key to chain 84532. The script deploys `DrandVerifier` and calls `setVerifier`, so resolution is verified on chain from the first event. Addresses print as `GATE= USDC= ARENA= VERIFIER=` and are also in `broadcast/Deploy.s.sol/84532/run-latest.json`. Fund `RESOLVER` with test ETH before starting the engine.

To change the resolver or treasury later: `cast send <ARENA> "setResolver(address)" <addr> --private-key <deployer>` (same for `setTreasury`).

## 3. Engine on the laptop

```bash
cd apps/engine
cp .env.example .env                 # see below for the production values
npx pm2 start ecosystem.config.cjs
npx pm2 logs twic-engine --lines 50
npx pm2 restart twic-engine
```

Production `.env` values that differ from the README's local block:

| Var | Value |
|---|---|
| `DATABASE_URL` | the Neon URL |
| `RPC_URL`, `CHAIN_ID` | a Base Sepolia RPC, `84532` |
| `RESOLVER_PRIVATE_KEY`, `ARENA_ADDRESS` | from step 2 |
| `DEMO_MODE` | `0` for real timing (60 s halves, 30 s pause); `1` for a 35-second demo cycle |
| `ALWAYS_ON` | `0` so nothing is generated while nobody is watching (the web app heartbeats presence); `1` for a soak |
| `STUB_MODE`, `OPENROUTER_API_KEY` | `0` and the key for real video |
| `MEDIA_STORE`, `BLOB_READ_WRITE_TOKEN` | `blob` and the token. `MEDIA_KEEP` only applies to the local store |
| `SUBGRAPH_URL` | the Studio query URL, once step 5 is done |

Stopping it: `pm2 stop twic-engine`, or Ctrl-C / `kill <pid>` for a foreground `pnpm --filter engine start`. The engine answers SIGINT/SIGTERM with a `shutting down` line and exits within 3 s (a second signal exits immediately) — in-flight steps are idempotent, so the next start resumes them.

**Never `kill -9` the `pnpm` or `tsx` wrapper.** `pnpm start` is three processes deep (pnpm → tsx → node); SIGKILL on the outer two reparents the node grandchild to PID 1, where it keeps authoring, rendering, resolving on chain and charging the OpenRouter key with nothing on screen. Kill the whole thing instead: `pkill -f 'src/index.ts'`. The engine keeps its pid in `$MEDIA_DIR/engine.pid`, so if a copy is already loose the next start refuses to run beside it — `engine already running as pid N` — instead of a bare `EADDRINUSE` (and with `MEDIA_STORE=blob` there is no media port to collide at all).

Restarts are safe by construction: the loop reads chain state before sending `createEvent` or `resolve`, so a bounce never duplicates an event. Every production failure backs off exponentially, so a dead vendor cannot burn credits in a loop. Watch `Event.costUsd` in the database and the OpenRouter dashboard; the engine has no hard spend ceiling yet (review item ENG-3).

## 4. Web on Vercel ⚠

- Import the repo, set **Root Directory** to `apps/web`, framework Next.js. pnpm is detected from `packageManager`.
- Build command: `pnpm --filter db run generate && next build --webpack`. The Prisma client is generated into `packages/db/src/generated`, which is gitignored, so the build must generate it. Turbopack is off on purpose (`docs/CONTRACTS.md`, "Web env").
- Environment variables: everything in `apps/web/.env.local.example` with production values. `NEXT_PUBLIC_CHAIN_ID=84532`, the three contract addresses from step 2, `NEXT_PUBLIC_RPC_URL`, `DATABASE_URL`, `GATE_OWNER_PRIVATE_KEY` (deployer), `NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_SUBGRAPH_URL`. Leave `NEXT_PUBLIC_DEV_WALLET_KEY` empty.
- Pin the function region near the database (`vercel.json` `regions`), or every query crosses an ocean.

## 5. Subgraph on Studio ⚠

Follow `packages/subgraph/README.md`, "Deploying to Base Sepolia". In short: `ARENA_ADDRESS=<arena> START_BLOCK=<deploy block> pnpm --filter subgraph run prepare:base-sepolia`, `codegen`, `build`, `graph auth <deploy key>`, `pnpm --filter subgraph run deploy:studio`. Then set `NEXT_PUBLIC_SUBGRAPH_URL` (Vercel) and `SUBGRAPH_URL` (engine) to the query URL.

## 6. Turning real video on

1. `STUB_MODE=0`, `OPENROUTER_API_KEY`, `MEDIA_STORE=blob` + token in the engine `.env`; restart.
2. Watch one event end to end in the logs: `authored` → `render` cost line → `on-chain` → `resolved`. Confirm the first-half MP4 plays from the blob URL and that `Event.costUsd` is in the expected $6–9 range.
3. If a clip job times out, raise the poll timeout in `apps/engine/src/openrouter.ts` (`pollVideo`); the 15-minute default is a guess, not a measurement.

## 7. World mode ⚠

Fill the `WORLD_*` and `NEXT_PUBLIC_WORLD_*` vars, set `GATE_MODE=world` and `NEXT_PUBLIC_GATE_MODE=world` in Vercel, redeploy. `/verify` then shows the IDKit selfie-check widget; the proof is verified server-side at `POST /api/verify` before `Gate.setVerified`. Until beta access arrives the route returns 501 for world mode and the checkbox mode keeps working.

## 8. Branch sealing and the CRE workflow ⚠

Only with the local media store and a public `MEDIA_BASE_URL` (Tailscale Funnel or cloudflared in front of the media port). Engine: `BRANCH_SEAL=1`, `BRANCH_SEAL_ROOT`, `REVEAL_SECRET`, `MEDIA_STORE=local`. CRE: `packages/cre/README.md` (`cre login`, secrets, `cre workflow simulate`, then `deploy` once access is granted; `config.staging.json` needs the Arena address and the public reveal URL). The engine reveals the winning branch itself after a 3 s grace period if the workflow does not, so a sealed event never ends with a dead video.

## 9. Demo day checklist

- `DEMO_MODE=1`, `ALWAYS_ON=1` on the engine for the recording, `0`/`0` afterwards.
- Verified addresses: the deployer key signs `Gate.setVerified` through `/verify`; for a pre-verified demo wallet run `cast send <GATE> "setVerified(address,bool)" <addr> true --private-key <deployer>`.
- Faucet: 1,000 USDC per verified address per day (`MockUSDC.faucet`).
- Synthetic volume on testnet: `apps/engine/scripts/bettor.ts` works against any RPC given funded keys; on Base Sepolia the four accounts need ETH.

## 10. Rollback

- Contracts: deploy a fresh set and repoint the engine and web envs. Old events stay claimable on the old `Arena`; keep the old address in the README so bettors can claim.
- Engine: `pm2 stop twic-engine`. In-flight events resolve on the next start (the state machine resumes from the database and the chain).
- Web: Vercel "promote previous deployment".
