# Keys, accounts and access

The local stack in the README needs none of this: anvil, a docker Postgres, ffmpeg test patterns and a fake OpenRouter cover every code path. Each item below turns one real thing on. Nothing here is committed; every value goes in a gitignored `.env` (`apps/engine/.env`, `apps/web/.env.local`, `packages/contracts/.env`, `packages/cre/.env`) or in Vercel's project settings.

## At a glance

| # | Get | Unlocks | Env vars | Lead time |
|---|---|---|---|---|
| 1 | **OpenRouter** API key + credits | real authoring (`openai/gpt-5-mini` by default, `AUTHOR_MODEL` buys a bigger one), real video (`minimax/hailuo-3-max`), key-art stills | engine `OPENROUTER_API_KEY`, `STUB_MODE=0` | minutes |
| 2 | **Vercel Blob** read-write token | public media URLs. Required for real video: OpenRouter must fetch the key-art still by URL, and Vercel cannot reach a laptop | engine `MEDIA_STORE=blob`, `BLOB_READ_WRITE_TOKEN` | minutes |
| 3 | **Postgres** URL (Neon) | one database shared by the engine on the laptop and the web app on Vercel | engine + web `DATABASE_URL` | minutes |
| 4 | **Base Sepolia deployer** key + test ETH | contracts on Base Sepolia; this key also owns `Gate` and `Arena` | contracts `.env`, deploy `--private-key`; web `GATE_OWNER_PRIVATE_KEY` | minutes (faucet) |
| 5 | **Etherscan API key** (V2) | source verification on Basescan (PRD story 61) | contracts `BASESCAN_API_KEY` | minutes |
| 6 | **Resolver hot key** + test ETH, **treasury** address | the engine signs `createEvent`/`resolve` with it; the treasury receives the 2 % fee | engine `RESOLVER_PRIVATE_KEY`; deploy `RESOLVER`, `TREASURY` | minutes |
| 7 | **Privy** app id | email login and embedded wallets (Privy prize) | web `NEXT_PUBLIC_PRIVY_APP_ID` | minutes |
| 8 | **Vercel** project | hosts `apps/web` | all web env vars, set in Vercel | minutes |
| 9 | **Subgraph Studio** subgraph + deploy key | markets list, positions, authoring context, The Graph prize | web `NEXT_PUBLIC_SUBGRAPH_URL`, engine `SUBGRAPH_URL` | 30 min + indexing |
| 10 | **The Graph gateway** API key | lets a judge query the subgraph through Subgraph MCP | none in the repo | minutes |
| 11 | **World** developer app (app id, action, RP id, RP signing key) + **Selfie Check beta** + sandbox device | Selfie Check gating instead of the checkbox (World prize) | web `NEXT_PUBLIC_WORLD_APP_ID`, `NEXT_PUBLIC_WORLD_ACTION`, `WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_RP_SIGNING_KEY`, `GATE_MODE=world`, `NEXT_PUBLIC_GATE_MODE=world` | beta approval, unknown. Apply now |
| 12 | **Chainlink CRE** login (`cre login` or `CRE_API_KEY`), deploy access, **Confidential Workflows beta** | simulate and deploy the reveal-key workflow (Chainlink prize) | `packages/cre/.env`; engine `BRANCH_SEAL=1`, `BRANCH_SEAL_ROOT`, `REVEAL_SECRET` | beta approval, unknown. Apply now |
| 13 | A public URL for the laptop (Tailscale Funnel or cloudflared) | only for branch sealing + CRE with real video, because sealing needs the local media store and the CRE workflow must reach the engine | engine `MEDIA_BASE_URL` | minutes |

## Where this stands, 2026-09-10

**Provisioned and exercised**: 1 OpenRouter (real authoring and real MiniMax clips, two events), 2 Vercel Blob (media serving from its public host), 3 Neon, 4 Base Sepolia deployer (contracts live, `Gate.owner()` confirmed), 5 Etherscan (all four contracts verified on Basescan), 6 resolver + treasury (three events created and resolved on chain), 7 Privy (allowed origins now include the production domain; the login modal opens there with a clean console, but no login has been completed), 8 Vercel (production deployment live), 9 Subgraph Studio (deployed, indexing, read by `/markets`). Addresses and URLs are in the root README's **Live** table.

**Still missing**: 10 the gateway API key; 11 World Selfie Check beta; 12 CRE deploy access and the Confidential Workflows beta; 13 a public URL for the laptop, only needed for sealing.

## Details

### 1. OpenRouter

- Create a key at openrouter.ai/keys. Load credits: **measured** on 2026-09-10, a 3-outcome `DEMO_MODE=1` event (45 s of video) costs **≈$3.20** — $3.15 of clips, $0.04 of key art, and **under a cent of authoring**, so 100 demo events is about $320. Almost all of it is video. Authoring defaults to `openai/gpt-5-mini`, one call an event, measured at **$0.0033 an event** over two real probes; the $0.08–0.09 an event in the runbook's cost table is the old `openai/gpt-6-astra` default, which `AUTHOR_MODEL` still buys. The plan's $6–9 figure is a full-length `DEMO_MODE=0` event; budget that if you run real timing.
- Set in `apps/engine/.env`: `OPENROUTER_API_KEY`, `STUB_MODE=0`, and leave `OPENROUTER_BASE_URL=https://openrouter.ai`. Set `MAX_SPEND_USD` too — it is cumulative in `World.spendUsd`, so it survives restarts.
- Real video also needs item 2 (or 13): with `MEDIA_STORE=local` the key-art URL is `localhost`, which OpenRouter cannot fetch, and image-to-video fails.
- Now exercised against the real API: the strict JSON schema (accepted first try, reasoning non-empty), the image endpoint (key art generated first try, no fallback), image-to-video seeding (the first frame of the first half is visibly the key-art composition one beat later), and clip latency — nowhere near `pollVideo`'s 15-minute ceiling, so no tuning was needed. Numbers in `docs/RESEARCH.md`, section "Verified live". Still unverified: the download URL's lifetime (we download immediately) and the key-art image *price*, which the engine estimates at $0.04 because OpenRouter publishes none.

### 2. Vercel Blob

- Vercel dashboard → Storage → Blob → create a store → copy the read-write token.
- Set `MEDIA_STORE=blob` and `BLOB_READ_WRITE_TOKEN`. The blob path has now run: every clip, key-art still and last frame of both real events is on the store's public host, a plain `GET` answers 200 `video/mp4` and a `Range` request answers 206 with a `content-range`. Nothing prunes it — `MEDIA_KEEP` is local-store only — so blobs accrue until deleted by hand.
- Branch sealing (`BRANCH_SEAL=1`) refuses to start with the blob store. If you want the CRE demo with real video, use item 13 instead of Blob.

### 3. Postgres

- Neon (or any Postgres). Use the pooled connection string. Apply migrations once: `DATABASE_URL=... pnpm --filter db run deploy`.
- The same URL goes to the engine `.env` and to Vercel for the web app. The engine is the only writer of events; the web app only writes the presence heartbeat.

### 4–6. Chain keys

- Deployer: any fresh key with Base Sepolia ETH (Coinbase Developer Platform or Alchemy faucets). It deploys, owns `Gate` and `Arena`, and signs `Gate.setVerified` from the web verify route, so it also goes in Vercel as `GATE_OWNER_PRIVATE_KEY`.
- Resolver: a second fresh key, funded with a little ETH; it sends every `createEvent` and `resolve`, about 220k gas each with the on-chain verifier. Generate with `cast wallet new`.
- Treasury: any address you control that never bets. The 2 % fee lands there.
- Etherscan: one Etherscan account API key works for Base Sepolia through the V2 API. Set `BASESCAN_API_KEY` and use `--verify` on the deploy (runbook).

### 7. Privy

- dashboard.privy.io → create app → App ID. Enable email login and "create embedded wallets on login". Add `localhost:3000` **and the Vercel domain** to allowed origins. Base Sepolia (84532) is in Privy's default chain list.
- Set `NEXT_PUBLIC_PRIVY_APP_ID`. When it is set the dev wallet is ignored; leave `NEXT_PUBLIC_DEV_WALLET_KEY` empty in production (the app refuses it on chain 84532 anyway).
- The allowed-origins block is cleared. Re-checked in a browser against production on 2026-09-10: `/` and `/c/sports` log **zero console errors and zero warnings** (the only output is the Privy iframe's own self-XSS banner, which is proof the `auth.privy.io` frame loads), and "Sign in" opens the "Log in or sign up" modal with an email field and the "Protected by Privy" footer. What is still unproven: no email was submitted, so the OTP step and the embedded wallet have never executed. PRD story 23 stays in Pending until one login is carried through.

### 9–10. The Graph

- Done: `twic-arena` is deployed to Studio on **Base Sepolia**, indexing without errors, and the production `/markets` page reads it. The query URL carries the version label — see the README's Live table — and it is in web `NEXT_PUBLIC_SUBGRAPH_URL`. Steps and the exact working deploy command are in `packages/subgraph/README.md`, section "Deploying to Base Sepolia".
- Still open: engine `SUBGRAPH_URL`, which feeds the previous event's pools into authoring, has not been run against the live index — so the bettor-sentiment half of the world model is unproven.
- For judges: a gateway API key from Studio → API keys enables the Subgraph MCP server (`packages/subgraph/README.md`, section "Subgraph MCP"). Still not obtained. Only published subgraphs are reachable through it; the Studio development query URL works directly and is rate-limited to 3,000 queries a day.

### 11. World

- developer.world.org → create app → app id; create an incognito action named `verify` (or set `NEXT_PUBLIC_WORLD_ACTION`); copy the RP id and the RP signing key that IDKit 4's `rp_context` must be signed with (`WORLD_RP_ID`, `WORLD_RP_SIGNING_KEY`, server only).
- Request Selfie Check access (feature flag on your app) and a sandbox device. Both are access-gated. Ask in the ETHOnline Discord for a fast track.
- Switch `GATE_MODE=world` and `NEXT_PUBLIC_GATE_MODE=world`. Until then the checkbox mode (18+ self-attest + wallet signature) is what runs. `WORLD_API_KEY` is listed but unused; the v4 verify endpoint documents no auth header.

### 12. Chainlink CRE

- Install the `cre` CLI, run `cre login` (browser) or set `CRE_API_KEY`. `cre workflow build` works without an account and is verified; `cre workflow simulate` and `cre workflow deploy` are login-gated and have never run here.
- Apply for deploy access (`cre account access`) and, separately, the Confidential Workflows private beta (docs.chain.link/cre/account/confidential-workflows-access).
- Fill `packages/cre/.env` from its `.env.example`; `SECRET_BRANCH_SEAL_ROOT` and `SECRET_REVEAL_SECRET` must equal the engine's `BRANCH_SEAL_ROOT` and `REVEAL_SECRET`. Full steps in `packages/cre/README.md`.

## Secrets you generate yourself

```bash
cast wallet new                                   # resolver hot key (and a deployer if you need one)
printf '0x%s\n' "$(openssl rand -hex 32)"         # BRANCH_SEAL_ROOT
printf '0x%s\n' "$(openssl rand -hex 32)"         # REVEAL_SECRET
```

## Apply today, the answers take time

1. World: Selfie Check feature flag + sandbox device for your app.
2. Chainlink: CRE deploy access, then the Confidential Workflows beta.
3. ETHOnline Discord: ask both sponsors for a hackathon fast track.
4. Confirm the submission cutoff on the ETHGlobal dashboard; the event page returned a 500 when it was last checked.

## What turns on when

| Feature | Needs | Without it |
|---|---|---|
| Real event video and authoring | 1 + 2 (or 13) | ffmpeg test patterns, canned events, no cost |
| Testnet deployment | 3, 4, 5, 6 | everything runs on anvil |
| Email login, embedded wallets | 7 | anvil dev wallet, local only |
| Markets list, positions, authoring context | 9 | those two pages show "subgraph not configured"; authoring skips pool context |
| Selfie Check gating | 11 | checkbox self-attest + wallet signature, still on-chain gated |
| Sealed branches released from a TEE | 12 + 13 | branches published in plaintext; still unreachable before reveal through the API, but guessable on the media server (see README known issues) |
| Judges querying via Subgraph MCP | 9 + 10 | Studio playground |
