# Event scripts are written by a cheap LLM, not a template generator

The plan named GPT-6 Astra as the `Author`, and the fallback idea was a seeded random script generator with no LLM at all. Neither is what ships. The `Author` is `openai/gpt-5-mini` through OpenRouter, writing inside the per-channel house-style prompts in `author.ts`, for about $0.0033 an event with no schema retries measured. Decided 2026-09-11.

## Considered options

- **Templates plus a seeded RNG, no LLM.** Free and deterministic, but the prompt lab (ticket 05) showed that bare template shots such as "kickoff" render random footage on every video model, while one or two plain sentences render what was asked. A template generator would therefore need hand-written sentence pools per channel and fixture, and it loses canon continuity except through more templates. That is more prompt work, not less.
- **Hybrid.** Templates pick the fixture and outcomes, the LLM writes shots and canon. Rejected: the LLM does the fixture part well already and the split adds a second code path for no saving.
- **gpt-5-mini.** Chosen. Sentence-level shots, canon continuity for free, cost is noise next to video.

## Consequences

- Canon continuity stays. `canonUpdates` keep flowing back into the next prompt. Cap the lines fed back so the prompt does not grow without bound.
- Hand-tuned wording lives only in the house-style strings: `CHANNEL_STYLE` for the author and `CHANNEL_PREFIX` / `STYLE_SUFFIX` for the renderer. Shots stay LLM-written. Improving the prompt means editing those strings, and only when a rendered clip looks wrong.
- The `Author` is vendor-neutral: shots are sentences plus seconds. If a video vendor has a different clip range, the render layer clamps. Swapping vendors never touches the author.
- Prompt drift is fixed in code, not prompt. Leading "Outcome N" labels are stripped after validation. A vendor that prints prompt words on screen handles that in its own `Render`.
- The `Authored` shape (cards, ticker, canonUpdates, optional reasoning) is unchanged.
- The template author in `stubs.ts` survives only as the `STUB_MODE` test double.
