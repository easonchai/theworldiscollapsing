# World Selfie Check: integration feedback

Written while wiring Selfie Check into `apps/web` with `@worldcoin/idkit` 4.2.3, the official
`SKILL.md`, the IDKit docs, and both MCP servers. What we built is in `docs/WORLD.md`. This file is
what got in the way.

## Selfie Check access

The credential page and the skill both say Selfie Check is access-gated: "request access so the
feature flag can be enabled for your app", by email to developers@toolsforhumanity.com. The skill
tells the agent to stop and send the developer to that email before writing any code.

That was not our experience. We created a new app in the Developer Portal and Selfie Check was
available on it with no request and little friction. We never sent the email. Either the gate was
lifted and the docs were not updated, or new apps get the flag by default and only older apps need
to ask. Say which, or drop the warning, because the skill's "stop and tell the user to request
access" halts an agent on a gate that is not there.

This matters more for agents than for people. A developer reads the warning once and tries it
anyway. Claude, Codex and Cursor read `SKILL.md` on every run and treat the warning as a fact:
Selfie Check is unavailable until an email comes back. So the agent does not build the Selfie Check
path. It builds a workaround, a checkbox, a "verify later" stub, a `GATE_MODE` switch with the real
mode off by default, and reports the integration as blocked. That is what happened in this repo.
The default mode shipped as an 18+ checkbox, the World branch of the verify route went untested,
and the project docs recorded "flag pending" for days while the flag was already on. A stale access
warning in an agent-facing doc does not slow the integration down. It replaces it.

## Three environments, one documented

IDKit 4.2.4 types accept `environment: "production" | "staging" | "sandbox"`. The skill's Phase 5
only knows two: staging is the simulator, production is real phones, "the IDKit `environment` prop,
the action's `environment`, and the simulator-vs-real-app choice must all match." `sandbox` appears
only on the sandbox pages.

An agent following the skill sets up a staging action and points at simulator.worldcoin.org. The
simulator cannot do Selfie Check, so the flow ends at a QR code that never completes, and nothing
says why. The skill needs a third row: sandbox is the sandbox World App on a real phone, and it is
the only place Selfie Check can be tested short of production.

## The verify schema does not know about sandbox

The sandbox access page says to send sandbox proofs to the production verify endpoint. The OpenAPI
schema for `POST /api/v4/verify/{rp_id}` lists `environment` as `production | staging` with a
default of `production`. So either the endpoint accepts a value the schema forbids, or a sandbox
proof is verified as production. We could not tell which from the docs, and a generated client
would reject the field.

## Two tool lists for one MCP

The Developer Portal MCP page lists eight tools: `get_team_context`, `get_app_config`,
`create_app`, `configure_world_id`, `create_world_id_action`, `configure_mini_app`,
`upload_app_image`, `submit_app_for_review`. The skill's Phase 1 table lists three more:
`get_world_id_registration_status`, `get_world_id_signing_key`, `rotate_world_id_signing_key`.
The skill's Phase 7 recovery table depends on two of those three. One of the two pages is stale,
and the agent cannot know which until it connects and finds a tool missing.

Neither list has anything for Selfie Check or sandbox. The two things that decide whether a
Selfie Check integration can be tested at all, the feature flag and sandbox device enrollment, have
no tool and no status field. `get_app_config` should say whether Selfie Check is on.

## Signal binding is asserted, not shown

Every IDKit sample carries the comment "Signal (optional): bind specific context into the
requested proof. Examples: user ID, wallet address. Your backend should enforce the same value."
No page shows the enforcement. To write it we had to learn, by reading `idkit-core/dist/hashing.js`
and the verify OpenAPI schema:

- `signal` is a preset option, not a widget prop, and the widget hashes it into every
  `responses[].signal_hash`. There is no top-level `signal_hash` in the verify request.
- `hashSignal` lives at `@worldcoin/idkit/hashing` and is mentioned on the JavaScript page only.
- `hashSignal` reads a `0x`-prefixed hex string as bytes, so an EVM address hashes the same in
  either casing. Any other string is hashed as UTF-8. That distinction decides whether a
  checksummed and a lowercased address match, and it is undocumented.
- Whether the verify endpoint itself rejects a proof whose `signal_hash` does not match the
  signal is not stated anywhere. The zero-knowledge construction says it must, but a relying party
  cannot rely on a sentence that is not there.

What we shipped is in `apps/web/src/lib/world.ts`: recompute `hashSignal(address)` from the
address the caller signed for, and require every response's `signal_hash` to equal it. Ten lines.
The integrate page should have them, under Step 5, because a backend that skips this check lets
one selfie verify any number of accounts.

## What worked

- `signRequest` from `@worldcoin/idkit/signing` on the server and the controlled
  `IDKitRequestWidget` on the client matched the React page exactly. No surprises in the API.
- "Forward the complete IDKit result without remapping" is the right instruction and it held.
- The Docs MCP (`https://docs.world.org/mcp`, one search tool, no key) answered every question we
  put to it. The raw `.md` endpoints behind each docs page are a good idea.
