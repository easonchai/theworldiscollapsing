# Chainlink: Best Confidential Workflow ($2,000, up to 2 teams at $1,000)

**Status: not done.** The workflow is written, compiles to WASM and passes 7 handler tests, but it has never executed through the CRE CLI or on a DON. The track requires a demonstrated execution.

## What the track asks for

- "Build a CRE Workflow that uses Confidential Workflows to execute a meaningful part of the application."
- "Workflow must register and use a confidential TEE handler."
- "Confidential portion must process at least one sensitive input, secret, confidential API response, private parameter, or intermediate value inside the enclave."
- "Demonstrate successful execution through either CRE CLI simulation or live deployment."

## What exists

- `packages/cre/reveal-key/workflow.ts:115-132`: `cre.handlerInTee` registered on `evmClient.logTrigger` for `Arena.Resolved`.
- `workflow.ts:57-113`: the handler decodes the log, reads the authoritative outcome with `EVMClient.callContract`, pulls `BRANCH_SEAL_ROOT` and `REVEAL_SECRET` with `runtime.getSecrets`, derives `key_i = keccak256(root ‖ eventId ‖ i)` for the winning `i` only, and POSTs it to the engine's `/internal/reveal-key` with a bearer token. The seal root is the sensitive input and it never leaves the enclave.
- `apps/engine/src/seal.ts`: byte-identical key derivation, AES-256-GCM seal/unseal. `apps/engine/src/media.ts:130-152`: the receiving endpoint.
- Engine side is behind `BRANCH_SEAL=1` + `BRANCH_SEAL_ROOT`, and refuses `MEDIA_STORE` other than `local`.

## What is missing

1. `cre workflow simulate ./reveal-key` has not been run. It needs `cre login` (browser OAuth) or `CRE_API_KEY`. `docs/CRE.md` is the switch-on guide (account, toolchain, the local sealed stack, simulate and deploy in order); `packages/cre/README.md:126-138` has the command and the gating table.
2. `packages/cre/reveal-key/config.staging.json` still holds `arenaAddress: 0x000…0` and `revealUrl: https://engine.example.invalid/...`. Needs the Base Sepolia `Arena` address and a public URL for the laptop engine (a tunnel is fine).
3. `handlerInTee` on a real DON needs the Confidential Workflows private beta, which is invite-only and separate from deploy access. Simulation satisfies the track; the beta does not block it.
4. Recording: the engine currently self-reveals after a 3 s grace when no CRE key arrives (`apps/engine/src/index.ts:247-256`, log line "no CRE key in time"). For the demo video, raise that grace or disable the fallback so the reveal visibly waits for the workflow.

## Steps

1. `cre login`, then `cre workflow simulate` against a local anvil with `BRANCH_SEAL=1` and an event resolving. Capture the output.
2. Fill `config.staging.json`, point it at Base Sepolia, re-run against a real `Resolved` log.
3. Screen-record one event: sealed branch on the media server (ciphertext), `Resolved` on chain, the workflow releasing exactly one key, the winning branch playing.
4. Move the README's CRE section from "wired, off by default" to "runs", with the simulation transcript linked.
