# `packages/cre` — the branch-key release workflow

A Chainlink CRE **Confidential Workflow** that holds the only material from which a branch video's
decryption key can be computed, and releases exactly one key — the winning branch's — after the
Arena contract resolves the event.

```
Arena.Resolved(eventId, outcome, sig)        ← Workflow DON watches the log
        │
        ▼  handlerInTee  →  AWS Nitro enclave
   read Arena.events(eventId)                ← crosses back out via usingTheDons(); chain reads
   (authoritative outcome)                     always run on DON nodes, never in the enclave
        │
   getSecrets([BRANCH_SEAL_ROOT, REVEAL_SECRET])   ← Vault DON releases these *into* the enclave
   key = keccak256(root ‖ eventId ‖ uint8(outcome))
        │
   POST {eventId, outcome, key} → engine /internal/reveal-key    ← sent from inside the enclave
        │
        ▼
   engine decrypts branch-<outcome>.mp4.enc in place and swaps Event.branchUrls[outcome]
```

## Why HTTP and not an on-chain write

Both are supported (`evmClient.writeReport` after `usingTheDons()`), but writing the key on chain
would need a new consumer contract wired to the CRE forwarder — new Solidity, a new deployment, and
`packages/contracts` is out of scope for this stretch. The engine already runs an HTTP server for
media, so one guarded endpoint on it is the smaller change, and `HTTPClient.sendRequest()` has a
`TeeRuntime` overload, so the release leaves from inside the enclave rather than through the DON.

## The sealing scheme

The engine (`apps/engine/src/seal.ts`, active only when `BRANCH_SEAL=1`) publishes every branch as
AES-256-GCM ciphertext, `iv(12) ‖ ciphertext ‖ tag(16)`, stored as `branch-<i>.mp4.enc`. The
plaintext is deleted as soon as the ciphertext is written. `Event.branchUrls` point at the
ciphertext, so the pre-existing rule — never serve a branch before resolution — is now enforced by
a key rather than by application logic.

The key for branch `i` of event `id` is

```
key_i = keccak256(root ‖ eventId ‖ uint8(i))
```

`root` is 32 secret bytes. keccak256 is a sponge construction, so a secret prefix is a sound PRF
(no length extension), the three fields are fixed-width so the encoding is unambiguous, and
releasing `key_outcome` reveals nothing about `key_j` for any other `j`.

> **Deviation from the packet, stated plainly.** The packet asked for a per-branch random key
> shipped to the workflow inside a record encrypted to the workflow's public key. That needs a
> cipher *inside* the workflow, and CRE TypeScript workflows compile to WASM via Javy/QuickJS where
> `node:crypto` is unavailable, there is no WebCrypto, and the only crypto already on the path is
> viem's hashing (`@chainlink/cre-sdk` depends on viem). Adding `@noble/ciphers` was not permitted
> for this task, and hand-rolling a cipher mode in a money-adjacent path is worse than not shipping
> one. Derivation gives the same operational property with primitives that are known to compile.
> The upgrade path, once a cipher is available in the workflow runtime, is an X25519 + AES-GCM
> envelope so the engine can forget `root` after sealing; `seal.ts` keeps its shape either way.

`root` lives in the engine's `BRANCH_SEAL_ROOT` env var and in the Vault DON secret of the same
name. `REVEAL_SECRET` is a shared bearer token so a stranger cannot POST junk at the endpoint.

## What the TEE protects, and what it does not

**Protects**

- The unreleased branch videos. Between render and resolution, the branch files exist only as
  ciphertext on the engine's disk and behind its media URLs. Nobody — a viewer poking at the media
  server, a CRE node operator, anyone who scrapes `branchUrls` — can watch either ending early.
- `BRANCH_SEAL_ROOT` itself. The Vault DON releases it only into an attested enclave; Workflow DON
  node operators never see it in plaintext.
- The release payload. `HTTPClient.sendRequest()` with a `TeeRuntime` executes the request from
  inside the enclave, so the key crosses the wire without passing through DON node memory.

**Does not protect**

- **The operator.** The engine generated the branches, sealed them, and knows `root`. This is a
  spoiler lock, not a defence against the people running the world. The fairness claim rests on
  drand, not on this workflow — see the root README's trust model.
- **The video vendor.** Every prompt and every finished clip passes through OpenRouter and MiniMax
  in plaintext, before any of this runs. A TEE cannot fix that; confidential *video* inference does
  not exist commercially (see `docs/RESEARCH.md`).
- **The workflow's own logic.** Chainlink is explicit: the compiled binary that runs in the enclave
  is not confidential, only the data it processes. Anyone can read this code and see the key
  schedule; without `root` it buys them nothing.
- **The trigger and the chain read.** Those run on Workflow DON nodes by design. Only the secret
  fetch, the key derivation and the outbound release are inside the enclave.
- **The outcome.** It is public on chain the instant `Resolved` is emitted. The workflow hides the
  *video*, never the result.

## Layout

```
packages/cre/
├── project.yaml            targets: local-settings (anvil-devnet), staging-settings (Base Sepolia)
├── secrets.yaml            BRANCH_SEAL_ROOT, REVEAL_SECRET → env vars for simulation
├── .env.example            copy to .env (gitignored); values must match the engine's .env
├── contracts/abi/Arena.ts  the two ABI members the workflow uses (viem, no codegen)
└── reveal-key/
    ├── main.ts             Runner entry point
    ├── workflow.ts         initWorkflow + onResolved (the TEE handler)
    ├── workflow.test.ts    bun test, using @chainlink/cre-sdk/test
    ├── workflow.yaml       per-target workflow name and artifact paths
    └── config.local.json / config.staging.json
```

The workflow is a **bun** project (that is what the CRE toolchain compiles), deliberately outside
the pnpm workspace — hence the hand-copied `contracts/abi/Arena.ts` rather than an import of the
`contracts` package.

## Running it

```bash
# once
curl -sSL https://app.chain.link/cre/install.sh | bash     # or grab the binary from
                                                           # github.com/smartcontractkit/cre-cli/releases
cd packages/cre/reveal-key && bun install
cp ../.env.example ../.env                                 # then fill in the two secrets

# tests + typecheck (no CRE account needed)
bun run typecheck
bun test

# compile to WASM (no CRE account needed)
cre workflow build ./reveal-key --target local-settings

# simulate — REQUIRES `cre login`; run from packages/cre, with the sealed local stack up
# (anvil --port 8547 --chain-id 84532, engine on :4002; see docs/CRE.md)
cre workflow simulate ./reveal-key --target local-settings \
  --non-interactive --trigger-index 0 --listen
```

### Gating status (verified 2026-09-13, CLI v1.33.0)

| Step | Gate | Here |
|---|---|---|
| `cre workflow build` | none | compiles offline |
| `cre workflow simulate` | **`cre login`** (browser OAuth) or `CRE_API_KEY` | ran, `docs/cre-simulation-2026-09-13.txt` |
| `cre workflow deploy` | `cre login` **plus** deploy access approval (`cre account access`) | not granted to our organization |
| `handlerInTee` on a real DON | Confidential Workflows **private beta**, by request, separate from deploy access | not granted |

The simulator only accepts chains on the tenant's supported list, so the local target names
`ethereum-testnet-sepolia-base-1` and points it at an anvil started with `--chain-id 84532`.
`anvil-devnet` is dropped silently and the run ends with `no RPC URLs found`.

## What has actually been verified

- `cre workflow build` compiles `reveal-key` to WASM (Javy/QuickJS) — so viem's keccak256, ABI
  encode/decode and the whole handler survive the WASM toolchain.
- `bun test` — 7 tests over the handler, including that the key sent matches the engine's schedule
  byte for byte, that the outcome comes from the chain read rather than the log, and that nothing is
  released when the chain says the event is unresolved.
- `cre workflow simulate --listen` against the live sealed stack: the EVM log trigger fired on
  `Resolved`, the simulator ran the TEE handler (real `eth_call`, secrets from `secrets.yaml`, real
  POST), the engine logged `branch key released` 120 ms after `resolved` on one event and 400 ms on
  the next, and the 3 s fallback never fired for them.
- After the release only the winning branch decrypts to a playable 10 s MP4; `ffprobe` refuses both
  losers, which exist only as `.enc`.

Not verified: a real Nitro enclave, the Vault DON, or a Base Sepolia deployment.
