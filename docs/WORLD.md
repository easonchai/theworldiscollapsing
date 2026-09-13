# World Selfie Check: setup and switching it on

The code for Selfie Check gating is complete. It is off because the web app runs in `checkbox`
mode, and the World side of it (the Selfie Check feature flag on the app, a sandbox device) has not
arrived. This page is everything needed to turn it on, split into what happens on World's
dashboard and what happens in this repo.

Status on 2026-09-13: code built, credentials obtained, flag pending. See the table at the end.

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
checkbox path of the verify route. Nothing tests the world branch of the route yet.

## World dashboard (developer.world.org)

Done already for this project. Repeat only for a new app.

1. Sign in at https://developer.world.org and create an app. Copy the **App ID** (`app_...`).
2. Create an action named `verify`. Make it incognito. The name must match `NEXT_PUBLIC_WORLD_ACTION`, which defaults to `verify`.
3. Copy the **RP ID** (`rp_...`) and the **RP signing key** (`0x...` hex). IDKit 4 refuses to open the widget without an `rp_context` signed by this key, so the server signs it and the browser never sees the key.
4. Request Selfie Check. It is an access-gated beta. Per World's docs: "request access so the feature flag can be enabled for your app", by mail to developers@toolsforhumanity.com or through your World point of contact. For the hackathon, ask in the ETHOnline Discord for a fast track.
5. Request sandbox access (docs.world.org/world-id/sandbox/sandbox-access). Sandbox needs a real phone: the sandbox World App ships through TestFlight on iOS or a private Play testing link on Android. Simulators do not work.

Items 4 and 5 are the open ones. Everything in 1 to 3 is filled in already.

## Repo side

The values live in `apps/web/.env.local` (gitignored). They are present today:

```
NEXT_PUBLIC_WORLD_APP_ID=app_...      # step 1
NEXT_PUBLIC_WORLD_ACTION=verify       # step 2
WORLD_APP_ID=app_...                  # same as above, server side
WORLD_RP_ID=rp_...                    # step 3
WORLD_RP_SIGNING_KEY=0x...            # step 3, server only, never NEXT_PUBLIC_
```

`WORLD_API_KEY` is listed in the file but unused. The v4 verify endpoint documents no auth header.

### Turn it on locally

1. Run the local stack from the README (anvil, docker Postgres, engine, web). The gate contract is `Gate` at the address in `NEXT_PUBLIC_GATE_ADDRESS`, and `GATE_OWNER_PRIVATE_KEY` must be its owner. On anvil that is account 0.
2. Flip both mode vars in `apps/web/.env.local`:

```
NEXT_PUBLIC_GATE_MODE=world
GATE_MODE=world
```

3. Restart `pnpm --filter web dev`. Next.js inlines `NEXT_PUBLIC_*` at build time, so a running server does not pick this up.
4. Open http://localhost:3000/verify. Step two should say "World Selfie Check proves a live human is behind the address" and, once you have signed in and ticked the box, show a "Start Selfie Check" button.

### What you see at each stage

| Screen | Meaning |
|---|---|
| "World mode is selected but NEXT_PUBLIC_WORLD_APP_ID is not set" | `NEXT_PUBLIC_GATE_MODE=world` but no app id. Fix the env, restart |
| "World mode is not ready: WORLD_RP_ID and WORLD_RP_SIGNING_KEY are not set" | `/api/world/rp-context` returned 501. Fill both server vars |
| "Preparing Selfie Check…" that never enables | The rp-context fetch is hanging or failing. Check the dev server log |
| Widget opens, QR code shows | The relying-party half works. Scan with World App |
| World App refuses or the widget errors at the selfie step | The Selfie Check flag is not enabled on this app yet. Nothing in the repo fixes this |
| `POST /api/verify` returns 401 "proof is not bound to this address" | The proof was made for a different signal. Reconnect the wallet and start the widget again |
| `POST /api/verify` returns 401 with a World `detail` | The verify endpoint rejected the proof. The `detail` string is World's reason |
| "Verified on chain" plus a tx hash | Done. `Gate.verified(address)` is true; the faucet button unlocks |

Confirm from the shell:

```bash
cast call <GATE_ADDRESS> "verified(address)(bool)" <ADDRESS> --rpc-url http://127.0.0.1:8545
```

### Turn it off

Set both mode vars back to `checkbox` and restart the web server. The checkbox path is what runs in production today.

## Deployed site

Same vars, set in the Vercel project settings, then redeploy. `docs/RUNBOOK.md` section 8.

## Gating summary

| Step | Who | State |
|---|---|---|
| App, action, RP id, signing key | World dashboard | done |
| Env vars filled | this repo | done |
| Widget, rp-context route, verify route, address binding | this repo | built, 79 web tests pass, world branch of the route untested |
| Selfie Check feature flag on the app | World, by request | pending |
| Sandbox device | World, by request | pending |
| End-to-end selfie to `setVerified` | needs the two above | never run |

## Notes

- Verification is liveness, not age. 18+ stays a self-attested checkbox in both modes.
- The gate is per address. A verified wallet stays verified; the route answers "Already verified" and spends no gas on a second click.
- The route spends the gate owner's ETH. It rate-limits one verification per address per minute in memory and caps total gas per hour (`apps/web/src/lib/limits.ts`). Behind more than one instance those limits need a shared store.
- Research behind these choices is in `docs/RESEARCH.md`, "World ID / Selfie Check".
