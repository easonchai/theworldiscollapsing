# World Selfie Check: setup and running it

Selfie Check gates the faucet and betting. It ran end to end on 2026-09-13: a scan in the production
World App, the proof verified at World's v4 endpoint, `Gate.setVerified` mined on Base Sepolia, the
faucet unlocked. No access request was sent. The "request access so the feature flag can be enabled"
line in World's docs did not apply to this app; see `docs/WORLD-FEEDBACK.md`.

## What is built

| Piece | File | What it does |
|---|---|---|
| Verify page | `apps/web/src/app/verify/page.tsx` | The three-step page: wallet, verify, faucet |
| Mode switch | `apps/web/src/components/verify-flow.tsx` | Reads `NEXT_PUBLIC_GATE_MODE`; `world` mounts the IDKit widget, anything else shows the 18+ checkbox |
| Widget | `apps/web/src/components/world-verify.tsx` | `IDKitRequestWidget` with `selfieCheckLegacy({ signal: address })`; fetches a signed `rp_context` first |
| `rp_context` | `apps/web/src/app/api/world/rp-context/route.ts` | Signs `{ rp_id, nonce, created_at, expires_at, signature }` with `WORLD_RP_SIGNING_KEY`. Returns 501 until `WORLD_RP_ID` and the key are set |
| Verify route | `apps/web/src/app/api/verify/route.ts` | In `world` mode: checks the proof is bound to the calling address, forwards it to `POST https://developer.world.org/api/v4/verify/{rp_id}`, then calls `Gate.setVerified` on chain from the gate owner key |
| Address binding | `apps/web/src/lib/world.ts` | `proofBoundTo`: every `responses[].signal_hash` must equal `hashSignal(address)`, so one selfie cannot verify many wallets |

`@worldcoin/idkit` 4.2.3 is installed. `pnpm --filter web test` covers `proofBoundTo` and the
checkbox path of the verify route. The world branch of the route is exercised by hand, not by a test.

## World dashboard (developer.world.org)

Done for this project. Repeat only for a new app.

1. Sign in at https://developer.world.org and create an app. Copy the **App ID** (`app_...`).
2. Create an action named `verify`. Make it incognito. The name must match `NEXT_PUBLIC_WORLD_ACTION`, which defaults to `verify`.
3. Copy the **RP ID** (`rp_...`) and the **RP signing key** (`0x...` hex). IDKit 4 refuses to open the widget without an `rp_context` signed by this key, so the server signs it and the browser never sees the key.

Selfie Check needed no request for this app. The production World App on a phone is enough; no
sandbox device was used.

## Repo side

The values live in `apps/web/.env.local` (gitignored):

```
NEXT_PUBLIC_WORLD_APP_ID=app_...      # step 1
NEXT_PUBLIC_WORLD_ACTION=verify       # step 2
WORLD_APP_ID=app_...                  # same as above, server side
WORLD_RP_ID=rp_...                    # step 3
WORLD_RP_SIGNING_KEY=0x...            # step 3, server only, never NEXT_PUBLIC_
NEXT_PUBLIC_GATE_MODE=world
GATE_MODE=world
```

`WORLD_API_KEY` is listed in the example file but unused. The v4 verify endpoint documents no auth header.

### Run it locally

1. Run the stack from the README. The gate contract is `Gate` at `NEXT_PUBLIC_GATE_ADDRESS`, and `GATE_OWNER_PRIVATE_KEY` must be its owner. On anvil that is account 0.
2. Set both mode vars to `world` as above.
3. Restart `pnpm --filter web dev`. Next.js inlines `NEXT_PUBLIC_*` at build time, so a running server does not pick this up.
4. Open http://localhost:3000/verify, sign in, tick the box, press "Start Selfie Check", scan the QR with World App.

### What you see at each stage

| Screen | Meaning |
|---|---|
| "World mode is selected but NEXT_PUBLIC_WORLD_APP_ID is not set" | `NEXT_PUBLIC_GATE_MODE=world` but no app id. Fix the env, restart |
| "World mode is not ready: WORLD_RP_ID and WORLD_RP_SIGNING_KEY are not set" | `/api/world/rp-context` returned 501. Fill both server vars |
| "Preparing Selfie Check…" that never enables | The rp-context fetch is hanging or failing. Check the dev server log |
| Widget opens, QR code shows | The relying-party half works. Scan with World App |
| World App refuses with `invalid_rp_signature` | `WORLD_RP_SIGNING_KEY` is not the key the portal holds for `WORLD_RP_ID`. Regenerate it on the dashboard, paste, restart. Seen once on 2026-09-13 after a stale key |
| `POST /api/verify` returns 401 "proof is not bound to this address" | The proof was made for a different signal. Reconnect the wallet and start the widget again |
| `POST /api/verify` returns 401 with a World `detail` | The verify endpoint rejected the proof. The `detail` string is World's reason |
| "Verified on chain" plus a tx hash | Done. `Gate.verified(address)` is true; the faucet button unlocks |

Confirm from the shell:

```bash
cast call <GATE_ADDRESS> "verified(address)(bool)" <ADDRESS> --rpc-url <RPC_URL>
```

### Turn it off

Set both mode vars back to `checkbox` and restart the web server.

## Deployed site

Same vars, set in the Vercel project settings, then redeploy. `docs/RUNBOOK.md` section 8.

## Notes

- Selfie Check is liveness, not age. 18+ stays a self-attested checkbox in both modes. IDKit 4.2.3 also ships an `identityCheck` preset with a `minimum_age` attribute (passport or eID in World App, World ID 4.0 only). It is undocumented on docs.world.org and was not tried.
- The gate is per address. A verified wallet stays verified; the route answers "Already verified" and spends no gas on a second click.
- The route spends the gate owner's ETH. It rate-limits one verification per address per minute in memory and caps total gas per hour (`apps/web/src/lib/limits.ts`). Behind more than one instance those limits need a shared store.
- Research behind these choices is in `docs/RESEARCH.md`, "World ID / Selfie Check".
