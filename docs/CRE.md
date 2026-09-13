# Chainlink CRE branch sealing: setup and switching it on

Branch sealing publishes every second-half branch as AES-256-GCM ciphertext and lets a Chainlink CRE
confidential workflow release only the winning key after `Arena.Resolved`. The engine half and the
workflow are written and tested.

Status on 2026-09-13: `cre workflow simulate --listen` ran against the local sealed stack and
released the key for two events in a row, 120 ms and 400 ms after `Resolved`, ahead of the engine's
3 s fallback. Transcript: `docs/cre-simulation-2026-09-13.txt`. Simulation is free; it needs only
`cre login`. Deploying to a DON is gated by access approval, not payment. See the table at the end.

## What is built

| Piece | File | What it does |
|---|---|---|
| Sealing | `apps/engine/src/seal.ts` | Encrypts each branch under `key_i = keccak256(root ‖ eventId ‖ uint8(i))`, deletes the plaintext, publishes `branch-<i>.mp4.enc` |
| Reveal endpoint | `apps/engine/src/media.ts` | `POST /internal/reveal-key` on the media server, bearer `REVEAL_SECRET`, body `{ eventId, outcome, key }` |
| Fallback reveal | `apps/engine/src/index.ts` | Waits 3 s after resolve for the workflow; if the winner is still `.enc`, derives the key itself and reveals. A sealed event never ends with a dead video |
| Workflow | `packages/cre/reveal-key/workflow.ts` | EVM log trigger on `Resolved`, chain read of `Arena.events(eventId)` for the authoritative outcome, key derivation inside the TEE, HTTP POST to the engine |
| Tests | `packages/cre/reveal-key/workflow.test.ts`, `apps/engine/src/seal.test.ts` | 7 handler tests; engine seal, unseal and endpoint round trip |
| Config | `packages/cre/project.yaml`, `reveal-key/workflow.yaml`, `config.local.json`, `config.staging.json`, `secrets.yaml` | Two targets: `local-settings` (anvil on 8547 run as chain 84532, see step 3) and `staging-settings` (Base Sepolia) |

Design, threat model and the deviation from the packet's envelope scheme are in
`packages/cre/README.md`.

## Chainlink dashboard (app.chain.link)

Three separate gates. Only the first is self-service.

1. **Account.** https://app.chain.link/cre/discover, "Create an account": email, password, 2FA, save the recovery code. You become owner of a new organization.
2. **Deploy access.** From a logged-in CLI, `cre account access` shows whether the organization can deploy and lets you submit a request with a use case. Chainlink answers by email. Needed for `cre workflow deploy` only.
3. **Confidential Workflows beta.** Invite-only, separate from deploy access. Submit the request form linked from docs.chain.link/cre/account/confidential-workflows-access with the use case. Needed for `handlerInTee` to run on a real DON. Chainlink's docs say the local simulator runs confidential workflows without this, but the simulator itself still needs a login (gate 1).

Optional, for CI: an API key from the CRE web app, exported as `CRE_API_KEY`, replaces the browser login.

## Repo side

### 1. Toolchain (no account needed)

```bash
curl -sSL https://app.chain.link/cre/install.sh | bash     # installs to ~/.cre; or the GitHub release zip
cre version                                                # expect v1.32.0 or newer
cd packages/cre/reveal-key && bun install                  # bun >= 1.2.21, already on this machine via mise
bun run typecheck && bun test                              # 7 tests
cre workflow build ./reveal-key --target local-settings    # from packages/cre; compiles main.ts to WASM
```

`build` works logged out and proves the handler survives the Javy/QuickJS toolchain. The WASM
output is gitignored.

### 2. Secrets

```bash
cp packages/cre/.env.example packages/cre/.env
openssl rand -hex 32 | sed 's/^/0x/'      # BRANCH_SEAL_ROOT
openssl rand -hex 32                      # REVEAL_SECRET
```

Put the same two values in both places or the released key opens nothing:

| `packages/cre/.env` | `apps/engine/.env` |
|---|---|
| `SECRET_BRANCH_SEAL_ROOT` | `BRANCH_SEAL_ROOT` |
| `SECRET_REVEAL_SECRET` | `REVEAL_SECRET` |

`CRE_ETH_PRIVATE_KEY` in `packages/cre/.env` signs CLI operations. Anvil account 0 is fine locally.

### 3. Local stack with sealing on

The CRE local target expects anvil on port 8547 and the engine media server on 4002, so it can run
beside the normal 8545/4000 stack (`docs/CONTRACTS.md`, port table).

Anvil runs with `--chain-id 84532`. The CLI (v1.33) simulates only against chains on the tenant's
supported list, which is testnets and mainnets; `anvil-devnet` (31337) is silently dropped from
`project.yaml` and the run fails with `no RPC URLs found`. So the local target names Base Sepolia
and points its RPC at localhost. Nothing touches the real Base Sepolia.

```bash
anvil --port 8547 --chain-id 84532

cd packages/contracts
RESOLVER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
TREASURY=0xa0Ee7A142d267C1f36714E4a8F75612F20a79720 \
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8547 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --broadcast
```

On a fresh anvil the Arena lands at `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0`, which is what
`config.local.json` already holds. If the address differs, update `arenaAddress` there.

Because the chain id is 84532, forge writes this deploy over the real Base Sepolia record in
`packages/contracts/broadcast/Deploy.s.sol/84532/`. Put it back before committing:

```bash
git checkout -- packages/contracts/broadcast/Deploy.s.sol/84532/run-latest.json
git clean -n packages/contracts/broadcast/Deploy.s.sol/84532/   # then delete the listed run-*.json
```

Engine env, on top of the README's local `.env`:

```
RPC_URL=http://127.0.0.1:8547
CHAIN_ID=84532
DATABASE_URL=postgresql://twic:twic@localhost:5433/twic_cre   # its own database; create it and run the migrations
STUB_MODE=1                # ffmpeg test patterns, no vendor spend
MEDIA_STORE=local          # sealing refuses to start with the blob store
MEDIA_PORT=4002
MEDIA_BASE_URL=http://localhost:4002
BRANCH_SEAL=1
BRANCH_SEAL_ROOT=0x...     # from step 2
REVEAL_SECRET=...          # from step 2
```

Then `pnpm --filter engine start`. Point `apps/web/.env.local` at 8547 and the new addresses if you
want the site on this stack too.

What "on" looks like without the workflow:

- `MEDIA_DIR/<eventId>/` holds `branch-<i>-<suffix>.mp4.enc` files and no plaintext branches. `ffprobe` on one fails.
- `Event.branchUrls` in the database end in `.enc`.
- At resolve the engine logs `no CRE key in time, revealed the winning branch locally` after 3 s, and only the winning branch becomes a playable `.mp4`. The loser stays sealed.

That is the fallback path, and it is what the deployed engine would do today if `BRANCH_SEAL=1`
were set. The workflow adds the TEE release in front of it.

### 4. Simulate the workflow (needs `cre login`)

```bash
cre login                    # browser: email, password, 2FA; writes ~/.cre/cre.yaml
cd packages/cre
cre workflow simulate ./reveal-key --target local-settings \
  --non-interactive --trigger-index 0 --listen
```

`--listen` keeps the simulator up and fires on every `Resolved`. It must be running from the
project directory (`packages/cre`): with `-R` the CLI does not find `.env`. Compilation takes about
a minute, so the first event that resolves in that window falls back (`no CRE key in time`); from
the second one on the engine logs `branch key released` a few hundred milliseconds after
`resolved`, and the fallback finds the winner already plain. In simulation the secrets come from
`packages/cre/.env` through `secrets.yaml`, and the HTTP request leaves your machine, so the engine
on 4002 receives the key.

A one-shot run against a past resolve (`--evm-tx-hash <tx> --evm-event-index 0` instead of
`--listen`) also executes the handler, but the engine answers 400 because that winner was already
revealed by the fallback. Use it to debug the workflow, not to demo the reveal.

Afterwards, `MEDIA_DIR/<eventId>/` holds the winner as `.mp4` (ffprobe: 10 s) and both losers as
`.enc` only.

### 5. Deploy to Base Sepolia (needs deploy access, then the beta)

1. Fill `config.staging.json`: the Base Sepolia `Arena` address and a public `revealUrl`. The engine must be reachable from Chainlink's nodes, so put Tailscale Funnel or cloudflared in front of the media port and set `MEDIA_BASE_URL` to that URL. Blob storage cannot be used with sealing.
2. Upload the two secrets to the Vault DON: `cre secrets create ../secrets.yaml --target staging-settings` from `packages/cre/reveal-key`, with the `SECRET_*` values exported in the shell or in `packages/cre/.env`. `cre secrets update` changes them later.
3. `cre workflow deploy ./reveal-key --target staging-settings`.
4. `handlerInTee` only runs in a real Nitro enclave once the organization is in the Confidential Workflows beta.

### Turn it off

Remove `BRANCH_SEAL=1` from the engine env and restart. Events already sealed keep their `.enc`
losers; the winner was revealed at resolve, so nothing on the wall changes.

## Gating summary

| Step | Gate | State here |
|---|---|---|
| `bun test`, `bun run typecheck` | none | 7 pass, 2026-09-13 |
| `cre workflow build` | none | CLI v1.33.0, binary hash `44a2a5ef…38885`, 2026-09-13 |
| Engine sealing + fallback reveal | none | tested in `seal.test.ts` and live on the 8547 stack; `BRANCH_SEAL` off in the deployed env |
| `cre workflow simulate` | `cre login` | ran 2026-09-13, `docs/cre-simulation-2026-09-13.txt` |
| `cre workflow deploy` | login + deploy access | not granted. `cre account access` says "Deployment access is not yet enabled for your organization"; the same command submits the request (needs a TTY) |
| Real enclave | Confidential Workflows beta | not granted; by request |

None of these steps costs money. There are no CRE credits to buy for simulation, and the deploy gate
is an approval, not a plan.

## Notes

- The operator holds `BRANCH_SEAL_ROOT` either way. This is a spoiler lock against viewers reading the ending off the media server early. Fairness rests on drand, not on this.
- Do not run sealing against the deployed Neon database and Base Sepolia engine without a public reveal URL first. The fallback reveal still works, but the workflow could never reach the engine.
- Research and verified CLI behaviour: `docs/RESEARCH.md`, "Chainlink CRE".
