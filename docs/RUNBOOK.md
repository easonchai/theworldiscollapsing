# Runbook: from the local stack to Base Sepolia

Prerequisite: the items in `docs/SETUP.md`. Steps 1–6 were run from this repo on 2026-09-10 and produced the deployment in the root README's [Live](../README.md#live) table; where reality differed from what this file said, the step now says what actually worked. Steps still marked ⚠ need a beta that has not arrived.

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

## 2. Contracts on Base Sepolia

```bash
cd packages/contracts
cp .env.example .env                 # fill BASE_SEPOLIA_RPC_URL, BASESCAN_API_KEY, RESOLVER, TREASURY
set -a; source .env; set +a
forge clean
forge script script/Deploy.s.sol --rpc-url base_sepolia \
  --private-key <deployer key> --broadcast --verify
```

`foundry.toml` already maps `base_sepolia` to `BASE_SEPOLIA_RPC_URL` and the Etherscan key to chain 84532. The script deploys `DrandVerifier` and calls `setVerifier`, so resolution is verified on chain from the first event. Addresses print as `GATE= USDC= ARENA= VERIFIER=` and are also in `broadcast/Deploy.s.sol/84532/run-latest.json`. Fund `RESOLVER` with test ETH before starting the engine.

Run on 2026-09-10: all four contracts landed in block **46631130** (addresses in the README's Live table) and `--verify` finished the run with `All (4) contracts were verified!` — confirmed independently through the Etherscan v2 `getsourcecode` API, which returns source and ABI for each address. Check the wiring before starting the engine: `arena.resolver()`, `arena.verifier()`, `arena.treasury()`, `arena.usdc()`, `arena.gate()` should equal what you put in `.env`, and the deployer should be `Gate.owner()`.

Measured on chain afterwards, at 0.006 gwei: `createEvent` **77,368 gas** (~0.0000005 ETH), a verifier-checked `resolve` **261,292 gas** (~0.0000016 ETH). `forge test` says 219,202 for `resolve`; the real chain is ~19 % above that on cold access, so budget ~300k when funding the resolver.

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
| `RPC_URL`, `CHAIN_ID` | a **keyed** Base Sepolia RPC (Alchemy/QuickNode), `84532`. Not the public `https://sepolia.base.org` — see below |
| `RESOLVER_PRIVATE_KEY`, `ARENA_ADDRESS` | from step 2 |
| `DEMO_MODE` | `0` for real timing (60 s halves, 30 s pause); `1` for a 35-second demo cycle |
| `ALWAYS_ON` | `0` so nothing is generated while nobody is watching (the web app heartbeats presence); `1` for a soak |
| `STUB_MODE`, `OPENROUTER_API_KEY` | `0` and the key for real video |
| `MEDIA_STORE`, `BLOB_READ_WRITE_TOKEN` | `blob` and the token. `MEDIA_KEEP` only applies to the local store |
| `SUBGRAPH_URL` | the Studio query URL, once step 5 is done |

Stopping it: `pm2 stop twic-engine`, or Ctrl-C / `kill <pid>` for a foreground `pnpm --filter engine start`. The engine answers SIGINT/SIGTERM with a `shutting down` line and exits within 3 s (a second signal exits immediately) — in-flight steps are idempotent, so the next start resumes them.

**Never `kill -9` the `pnpm` or `tsx` wrapper.** `pnpm start` is three processes deep (pnpm → tsx → node); SIGKILL on the outer two reparents the node grandchild to PID 1, where it keeps authoring, rendering, resolving on chain and charging the OpenRouter key with nothing on screen. Kill the whole thing instead: `pkill -f 'src/index.ts'`. The engine keeps its pid in `$MEDIA_DIR/engine.pid`, so if a copy is already loose the next start refuses to run beside it — `engine already running as pid N` — instead of a bare `EADDRINUSE` (and with `MEDIA_STORE=blob` there is no media port to collide at all).

**Do not point the engine at `https://sepolia.base.org`.** It is load-balanced across nodes at different heights and answers `BlockNotFoundError: Block at number "N" could not be found` for a transaction that is already mined. On 2026-09-10 that hit **4 of 4** chain writes; the retry then resumed from on-chain state and stored `createTx` / `resolveTx` as NULL, so those events have no explorer links, and one event's betting window shrank to about 5 s. Nothing was mis-settled. The engine now waits for the lagging node instead of failing the step (`chain.ts`), so the hash survives — but a keyed RPC is still the right call.

Restarts are safe by construction: the loop reads chain state before sending `createEvent` or `resolve`, so a bounce never duplicates an event. Every production failure backs off exponentially, so a dead vendor cannot burn credits in a loop. The ceiling is `MAX_SPEND_USD`: every authoring call, key-art image and clip attempt is charged against it and persisted in `World.spendUsd`, and the engine prints `budget {"capUsd":…,"spentUsd":…}` at startup — so the cap is cumulative across restarts, and lowering it below what has already been spent stops generation immediately. Watch `Event.costUsd` and `World.spendUsd` in the database against the OpenRouter dashboard; the two agreed to within 3 % on both real runs (see `docs/RESEARCH.md`, "Verified live").

Stopping the engine mid-cycle leaves that channel's newest event in a live state, and the wall prefers a live event over the last finished one — so a tile can sit at "Locked" forever (README known issues). For a demo, stop the engine just after a `rendered event` / `resolved` pair rather than in the middle of one.

## 4. Web on Vercel

- Import the repo, set **Root Directory** to `apps/web`, framework Next.js. pnpm is detected from `packageManager`.
- Build command: `pnpm --filter db run generate && next build --webpack`. The Prisma client is generated into `packages/db/src/generated`, which is gitignored, so the build must generate it. Turbopack is off on purpose (`docs/CONTRACTS.md`, "Web env").
- Environment variables: everything in `apps/web/.env.local.example` with production values. `NEXT_PUBLIC_CHAIN_ID=84532`, the three contract addresses from step 2, `NEXT_PUBLIC_RPC_URL`, `DATABASE_URL`, `GATE_OWNER_PRIVATE_KEY` (deployer), `NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_SUBGRAPH_URL`. Leave `NEXT_PUBLIC_DEV_WALLET_KEY` empty.
- **Add the production domain to the Privy app's allowed origins** (dashboard.privy.io → your app → allowed origins) *before* you rely on login. Without it Privy serves `frame-ancestors 'self' http://localhost:3000 https://auth.privy.io`, the login iframe is refused, and every page logs a CSP error. Done for this deployment on 2026-09-10: the modal opens on the production domain and the console is clean (no login has been carried through to a wallet yet, so PRD story 23 is still open).
- Deploying from the CLI: because the project's Root Directory is already `apps/web`, `cd apps/web && vercel deploy` fails with `The provided path …/apps/web/apps/web does not exist`. Link and deploy **from the repo root**:
  ```bash
  vercel link --yes --scope <team> --project theworldiscollapsing   # writes a gitignored root .vercel/
  vercel deploy --prod --yes
  ```
  `vercel deploy` uploads everything the repo's `.gitignore` does not cover, so move aside any large local file that is only in `.git/info/exclude` first.
- ⚠ Preview environment variables cannot be set from the CLI: on 53.3.2 `vercel env add <NAME> preview --value <v> --yes --force` returns `action_required` / `git_branch_required` in a loop and its own suggested next command is the one that just failed, while passing `main` is rejected (`Cannot set Production Branch "main" for a Preview Environment Variable`). Set preview values in the dashboard, or accept that only production is configured — which is the case today.
- ⚠ There is no `apps/web/vercel.json` in the repo, so functions default to `iad1` no matter where Neon lives. Add one with `regions` pinned near the database before it matters.

## 5. Subgraph on Studio

```bash
ARENA_ADDRESS=<arena> START_BLOCK=<deploy block> pnpm --filter subgraph run prepare:base-sepolia
pnpm --filter subgraph run codegen && pnpm --filter subgraph run build
pnpm --filter subgraph exec graph auth <deploy key>
pnpm --filter subgraph exec graph deploy twic-arena -l 0.0.1
```

The last line is deliberately `exec graph deploy …`, not `run deploy:studio`: that script is `graph deploy twic-arena` with no version label, so it stops on an interactive prompt, and `pnpm run deploy:studio -- -l 0.0.1` prints the graph CLI help and exits 2. Either use the `exec` form or add `-l` to the script.

The query URL carries the version label — `https://api.studio.thegraph.com/query/<id>/twic-arena/0.0.1`. Put it in `NEXT_PUBLIC_SUBGRAPH_URL` (Vercel) and `SUBGRAPH_URL` (engine). Right after deploying, the first poll answers with `hasIndexingErrors: false`, a `_meta.block` past the start block and an **empty** `events` list; that is a healthy index with nothing to show yet, not a failure. Live URL in the README's Live table.

## 6. Turning real video on

1. `STUB_MODE=0`, `OPENROUTER_API_KEY`, `MEDIA_STORE=blob` + token in the engine `.env`, and a `MAX_SPEND_USD` you are willing to lose; restart.
2. Watch one event end to end in the logs: `budget` → `spend openai/gpt-5-mini` (whatever `AUTHOR_MODEL` is) → `authored` → `spend key art` → `spend clip-N.mp4` ×3 → `rendered first half` → `on-chain` → `spend branch-…` → `rendered event` → `resolved`. Then confirm the first-half MP4 plays from its blob URL.
3. Measured on 2026-09-10 with `DEMO_MODE=1` and a 3-outcome event (two runs, anvil and Base Sepolia):

   | | Wall clock | Charged |
   |---|---|---|
   | authoring (`openai/gpt-6-astra`, reasoning mandatory — the default is now `openai/gpt-5-mini`, $0.0033 an event) | 13 s warm, 44 s from a cold start | $0.081–0.094, real `usage.cost` from the vendor |
   | key art (one still) | ~12 s | $0.04 (rate-card estimate, not vendor-reported) |
   | first half — 3 × 5 s @480p, submitted in parallel, downloaded and concatenated | 21 s | $0.25 a clip |
   | branches — 3 × 10 s @768p | 43 s | $0.80 a clip |
   | branches — 6 × 5 s @768p | 36 s | $0.40 a clip |
   | **`Event.costUsd`** (key art + 15 s @480p + 30 s @768p) | | **$3.19**, ≈ **$3.27** all-in with `gpt-6-astra` authoring, ≈ **$3.20** with the `gpt-5-mini` default |

   No clip failed, timed out or retried in either run, so `pollVideo`'s 15-minute ceiling was never approached and needs no tuning yet. The plan's $6–9 an event is for `DEMO_MODE=0` (60 s halves); a demo event is 45 s of video.
4. The engine pipelines: about 2 s after `rendered event` it authors the *next* event and charges for its key art, and clips follow ~13 s later. There is no way to stop after exactly one event — budget roughly $0.12 of overshoot if you SIGTERM at `rendered event`, or ~$0.87 if you are a few seconds later.
5. The house style holds on the real video model. Two 5 s @480p clips on 2026-09-10, prompts built by `clipPrompt` exactly as the loop builds them, **$0.50** of real spend: the sports clip is an elevated main side camera panning with a red-kit attacker at two defenders, mow-stripes, hoardings and a full crowd, cutting to behind the goal for the save; the politics clip is a locked-off studio camera on an anchor who turns to a video wall carrying a rising bar chart and a red-shaded world map. Neither is slow motion or graded like film (`ffprobe`: 5.184 s each; details and the motion measure in `docs/RESEARCH.md`). On-screen text renders as gibberish on both — a MiniMax limitation, which is why nothing is allowed to depend on reading it.
6. Media lands on the Blob store's public host. A plain `GET` answers 200 `video/mp4`; a `Range` request answers **206 Partial Content** with a `content-range` header, which is what the video element needs to scrub. Nothing prunes blobs — the engine's `MEDIA_KEEP` retention only applies to the local store — so objects accrue until you delete them by hand.

## 7. World mode ⚠

Fill the `WORLD_*` and `NEXT_PUBLIC_WORLD_*` vars, set `GATE_MODE=world` and `NEXT_PUBLIC_GATE_MODE=world` in Vercel, redeploy. `/verify` then shows the IDKit selfie-check widget; the proof is verified server-side at `POST /api/verify` before `Gate.setVerified`. Until beta access arrives the route returns 501 for world mode and the checkbox mode keeps working.

## 8. Branch sealing and the CRE workflow ⚠

Only with the local media store and a public `MEDIA_BASE_URL` (Tailscale Funnel or cloudflared in front of the media port). Engine: `BRANCH_SEAL=1`, `BRANCH_SEAL_ROOT`, `REVEAL_SECRET`, `MEDIA_STORE=local`. CRE: `packages/cre/README.md` (`cre login`, secrets, `cre workflow simulate`, then `deploy` once access is granted; `config.staging.json` needs the Arena address and the public reveal URL). The engine reveals the winning branch itself after a 3 s grace period if the workflow does not, so a sealed event never ends with a dead video.

## 9. Demo day checklist

- `DEMO_MODE=1`, `ALWAYS_ON=1` on the engine for the recording, `0`/`0` afterwards.
- Verified addresses: the deployer key signs `Gate.setVerified` through `/verify`; for a pre-verified demo wallet run `cast send <GATE> "setVerified(address,bool)" <addr> true --private-key <deployer>`.
- Faucet: 1,000 USDC per verified address per day (`MockUSDC.faucet`).
- Synthetic volume on testnet: same command as the README's local block, different env. Start it **before** the engine — it does not bet on a window it was not running for, and it only claims events it opened itself.

  ```bash
  CHAIN_ID=84532 RPC_URL=<keyed base sepolia rpc> \
  ARENA_ADDRESS=<arena> USDC_ADDRESS=<mock usdc> GATE_ADDRESS=<gate> \
  DATABASE_URL=<the engine's database> \
  GATE_OWNER_PRIVATE_KEY=<deployer key> BETTOR_KEYS=<k1,...,k6> \
  BET_INTERVAL_MS=8000 FUND_MIN_ETH=0.005 FUND_ETH=0.01 \
  pnpm --filter engine bettor
  ```

  `GATE_OWNER_PRIVATE_KEY` must be the deployer: it owns `Gate` (so it can verify the bettors) **and** it is the funder — it sends each of the six bettors `FUND_ETH` of **real testnet ETH** whenever they fall below `FUND_MIN_ETH`, so top the deployer up first and expect its balance to fall. Six bettors at the defaults is 0.06 ETH before any gas of its own. **Nobody has bet on Base Sepolia yet** — every pool there is 0, so payout, claim, the treasury fee and the void-market rule have only ever run on anvil, and this command has never been executed against a public RPC (`BET_INTERVAL_MS=1500`, the local value, is certainly too aggressive for one). Run it once before the recording.
- Known leftover on the live deployment (2026-09-10): sports seq 6 sits at `RENDER` in Neon with `World.spendUsd` at $4.14, so the next engine start against Neon buys its first half (~$0.75) and then pauses at the $5 cap unless `MAX_SPEND_USD` is raised. Seq 1–5 are `DONE` on chain and in the database.

## 10. Rollback

- Contracts: deploy a fresh set and repoint the engine and web envs. Old events stay claimable on the old `Arena`; keep the old address in the README so bettors can claim.
- Engine: `pm2 stop twic-engine`. In-flight events resolve on the next start (the state machine resumes from the database and the chain).
- Web: Vercel "promote previous deployment".
