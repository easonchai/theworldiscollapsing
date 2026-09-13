# Chainlink: Best Confidential Workflow ($2,000, up to 2 teams at $1,000)

**Status: simulation done. Not deployed: our organization does not have deploy access or the Confidential Workflows beta, both granted by Chainlink on request.** On 2026-09-13 `cre workflow simulate --listen` (CLI v1.33.0) fired on `Arena.Resolved` from a local sealed stack, executed the `handlerInTee` handler and released the winning key to the engine 120 ms after resolve, ahead of the 3 s fallback; the winner decrypted to a playable clip and both losers stayed ciphertext. Transcript: `docs/cre-simulation-2026-09-13.txt`. Setup: `docs/CRE.md`. That satisfies "demonstrate successful execution through CRE CLI simulation".

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

1. `packages/cre/reveal-key/config.staging.json` still holds `arenaAddress: 0x000…0` and `revealUrl: https://engine.example.invalid/...`. Only needed for a deploy: the Base Sepolia `Arena` address and a public URL for the laptop engine (a tunnel is fine).
2. `cre workflow deploy` needs deploy access. `cre account access` reports "Deployment access is not yet enabled for your organization"; the same command submits the request (run it in a terminal, it prompts). Not required by the track.
3. `handlerInTee` on a real DON needs the Confidential Workflows private beta, by request and separate from deploy access. Not required by the track.
