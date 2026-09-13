# Event video is rendered by Reactor `fast-h3`, not MiniMax

Four candidates were measured for the `Render` seam: MiniMax Hailuo 3 Max through OpenRouter (today), MiniMax direct, MiniMax H3 through fal.ai, and Reactor `fast-h3`. Reactor wins on cost by about 8x and passed the eye test on all four channels (`.scratch/video-vendor/clips/`), so it is the vendor. The hackathon demo runs REAL timing on about $100 of credit, which only Reactor can afford. Decided 2026-09-12. Facts in `docs/research/reactor.md`, `docs/research/minimax-direct.md`, `docs/research/fal.md` and `docs/RESEARCH.md`.

## Considered options

Cost per channel per event, video only. DEMO is 15 s plus three 10 s branches; REAL is 60 s plus three 60 s branches.

| Vendor | DEMO | REAL | Why not |
|---|---|---|---|
| OpenRouter `minimax/hailuo-3-max` | $3.15 | $17.40 | $100 buys one round of four channels at REAL. |
| MiniMax direct | $3.15 | $17.40 | Same rate card as OpenRouter; buys only base64 image input. |
| fal `minimax/h3` | $2.55 | $13.80 | 19% cheaper, 2 concurrent jobs on a new account, still a new client. |
| Reactor `fast-h3` | $0.33 to $0.39 | about $1.76 | Chosen. |

Reactor bills session-seconds at $0.007 regardless of resolution. A clip only exists as the stream recording, so every clip plays at 1x and builds are serial inside a session; the bill is about `first build + total played seconds`, and fetching bytes after disconnect is free (`docs/research/reactor.md`, section 6).

## Consequences

- **Model and resolution.** `fast-h3` only. It outputs 1344x768 with audio for both halves; there is no per-half resolution choice any more, and `RATE` goes away.
- **The whole event renders before it goes on chain.** REAL branches are 180 s of playback at 1x, which cannot fit the 75 s betting window, so first half and branches are rendered and stored before `createEvent`, pipelined so the next event renders while this one plays. This also makes "every branch exists before the first bet" literally true. The session topology under the 5-session cap is its own decision (map ticket "Render topology under Reactor's 5-session cap").
- **Key art stays optional.** The OpenRouter plus Gemini still is kept as a revert path. The Reactor `Render` seeds shot one from the still when one exists (`starting_frame`) and from text-to-video otherwise, then chains every later clip with `continue_from_clip_id`. Nothing is deleted by this decision.
- **Spend cap.** `Budget` keeps working: charge the estimate `(first build + total played seconds) × $0.007` per session up front so the cap can refuse an event before it starts, then true it up from `ready → disconnect` at the end. The SDK timing overstates the dashboard bill by about 15%, so the cap errs early. Set `MAX_SPEND_USD` to the credit loaded for the demo.
- **Headless path.** The JS SDK is browser-only, so the engine needs a Python sidecar or a Node WebRTC client. Undecided; see the map.
- **Prompts.** Hand-tuned wording stays in `CHANNEL_PREFIX` / `STYLE_SUFFIX` (ADR 0001). Reactor prints prompt words on screen and its speech is babble; the prompt v2 ticket fixes that by eye on `fast-h3`.
- **MiniMax stays reachable.** `openrouter.ts` remains for authoring and key art, and the OpenRouter `Render` is the fallback if Reactor is down. No further MiniMax prompt work.

## Amendment 2026-09-12: session topology under the 5-session cap

At REAL a channel-event is on air about 165 s but its session runs about 250 s with 3 outcomes (first build plus 240 s of 1x playback). Four channels back to back would need about 6.3 concurrent sessions; the account allows 5. The design accepts a longer channel cycle rather than fighting the cap.

- **One session per channel-event.** First half then every branch, chained with `continue_from_clip_id`, serial. Splitting branches across sessions (8 concurrent for four channels) and pooled slot-sharing (at most 20% faster, plus a scheduler) were rejected.
- **Global session limit 4**, replacing the 8-way clip concurrency. The fifth slot is slack for zombie sessions and early retries. `CHANNELS.length > 4` fails at boot.
- **Outcomes: `N_OUTCOMES`, default 3**, one global knob (2 to 5) feeding the author prompt, `createEvent` and the session estimate. Each extra outcome is 60 s more billed playback at REAL.
- **Fetch after disconnect stays inside `produce`**, HLS segments in parallel; decouple only if it still exceeds 60 s.
- **REAL `pauseMs` about 120 s** so the render cycle's ~95 s of extra gap is a declared pause, not dead air.
- **Channel scaling is bounded by session slots.** Fee-funded growth (start with one channel, add one when the treasury fee covers a channel-event) is a later effort; until then `CHANNELS` is a static list of at most 4.
- Session estimate for the spend cap: `(≈9 s first build + firstHalfMs + N_OUTCOMES × secondHalfMs + ≈3 s) × $0.007`; REAL, N=3 is about $1.75 by SDK timing.

## Amendment 2026-09-12: REAL halves are 30 s, not 60 s

Both REAL halves drop to 30 s. The numbers above were computed at 60 s and stay as the record of that decision; the current ones are:

- Session about 132 s with N=3 (≈9 s build + 30 + 3 × 30 + ≈3 s), so about **$0.92** a channel-event instead of $1.76, and each extra outcome costs 30 s of billed playback.
- On air about 105 s a channel-event, betting window 45 s, branches 90 s of playback.
- **REAL `pauseMs` 60 s**, covering the render cycle's ~27 s overhang past air time with slack. `machine.test.ts` asserts the relation rather than the constant, so both survive a further timing change.
