# World: Selfie Check ($3,500, up to 3 teams at $1,166)

**Status: not done.** The IDKit path is fully wired and the server verify route binds the proof to the wallet address, but the deployed and local configs run `GATE_MODE=checkbox` (an 18+ self-attestation), so no Selfie Check has ever gated a real bet. PRD stories 43 and 44.

## What the track asks for

- "Uses Selfie Check or a Selfie Check-compatible World ID credential flow in a meaningful way."
- "Treats Selfie Check as a risk, eligibility, fairness, continuity, or abuse-prevention signal."
- "Show a working app."
- Include a "feedback document."

## What exists

- Widget: `apps/web/src/components/world-verify.tsx:41-50` (`IDKitRequestWidget` with `selfieCheckLegacy({ signal })`, the signal is the wallet address).
- Signed RP context: `apps/web/src/app/api/world/rp-context/route.ts` (`signRequest` from `@worldcoin/idkit/signing`; returns 501 until `WORLD_RP_ID` and `WORLD_RP_SIGNING_KEY` are set).
- Server verify: `apps/web/src/app/api/verify/route.ts:83-100` POSTs to `https://developer.world.org/api/v4/verify`, refuses any proof whose `signal_hash` is not `hashSignal(address)`, then writes `Gate.setVerified(address)` on chain and drips gas to an empty embedded wallet.
- The signal it gates: `Gate.verified` is required by `MockUSDC.faucet` and `Arena.bet`. One Selfie Check per address, so the faucet cannot be farmed by a script and every pool is funded by people. That is the abuse-prevention story.
- Mode switch: `GATE_MODE=world` + `NEXT_PUBLIC_GATE_MODE=world` (`apps/web/src/lib/chain.ts:14`). UI branches in `apps/web/src/components/verify-flow.tsx:106,125`.

## What is missing

1. World developer app with the Selfie Check feature flag and a sandbox device. Both are access-gated. `docs/WORLD.md` is the switch-on guide (dashboard steps, local run, what each screen means); ask in the ETHOnline Discord for a fast track.
2. `WORLD_APP_ID`, `NEXT_PUBLIC_WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_RP_SIGNING_KEY` in `apps/web/.env.local` and on Vercel, then flip both `GATE_MODE` vars to `world`.
3. One real end-to-end run: Selfie Check on the sandbox device, `setVerified` tx on Base Sepolia, a bet that was refused before and accepted after.
4. The feedback document (docs, Developer Portal, sandbox states, integration friction). `WORLD_API_KEY` is listed in the env example but read nowhere; the v4 verify endpoint documents no auth header. That is one item for it.
5. Demo video.

## Steps

1. Request access (step 1 above) today; it is the long pole.
2. Test locally with `GATE_MODE=world` against anvil first, then Vercel.
3. Write `docs/WORLD-FEEDBACK.md`.
4. Update the README's World section from "ships off" to "on", and move stories 43 and 44 out of pending.
