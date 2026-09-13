# The Graph: Best Use of Composable or Standardized Graph Products ($5,000: $2,500 / $1,500 / $1,000)

**Status: not done.** One subgraph is live on Studio and read by both the web app and the engine's authoring step. The track wants two Graph products composed, or a standardized schema. We have one product.

The separate AI track ("Best AI Tooling or AI Use Case with The Graph, From Scratch", also $5,000) is already met by the authoring loop: `apps/engine/src/author.ts:79-109` reads the previous event's pools from the live Studio subgraph and feeds them into the LLM prompt, so the next episode reacts to what the crowd bet. That one needs only the demo video.

## What the track asks for

- "Either compose two or more of The Graph's products, or build meaningfully on a standardized schema."
- "Consume live data from a Graph provider", "no mocked, local-only, or static datasets."
- Cannot be "simply querying one Subgraph with no composition."
- "Make the standards leverage clear", public repository, two to four minute demo video.

## What exists

- `packages/subgraph`: `twic-arena` on Subgraph Studio, indexing `Arena` on Base Sepolia (`EventCreated`, `Bet`, `Resolved`, `Claimed`), no indexing errors.
- Consumers: `/markets` and `/positions` (`apps/web/src/lib/subgraph.ts`), and the engine author (`SUBGRAPH_URL` is set in `apps/engine/.env`).
- `packages/subgraph/README.md:115-140` documents Subgraph MCP (`https://subgraphs.mcp.thegraph.com/sse`) with the Claude config, but nothing in the repo uses it.

## What is missing

1. A second Graph product. The cheapest credible one is **Subgraph MCP**: an agent querying `twic-arena` in natural language. It needs the subgraph **published** (not just a Studio dev deployment) and a **gateway API key** from Studio → API keys. `docs/SETUP.md:18,71` tracks both as "still not obtained".
2. A use that is composition, not a second query. Candidate that fits the product: the engine's authoring step asks the MCP server for "which outcome the crowd is leaning on across the last N events on this channel" instead of hand-written GraphQL, and the answer shapes the next episode. That is the same `previousPools` idea, done through the AI product.
3. The demo video showing both products in one flow.

## Steps

1. Publish `twic-arena` from Studio; obtain a gateway key.
2. Add an MCP client call in the authoring step behind a flag (`SUBGRAPH_MCP_URL` + key), falling back to the existing GraphQL read.
3. Record: Studio dashboard (live data), the MCP query and answer, the authored episode that used it.
4. Update the README's Graph section to name both products and where each is called.
