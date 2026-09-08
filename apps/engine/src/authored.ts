import { z } from "zod";

// The contract between the authoring model and everything downstream.
// Validated before any money (createEvent) or media (render) is committed.
export const Shot = z.object({
  prompt: z.string().min(1),
  seconds: z.number().int().min(5).max(15), // MiniMax H3 Max clip range
});

export const Authored = z
  .object({
    title: z.string().min(1),
    premise: z.string().min(1),
    outcomes: z.array(z.string().min(1)).min(2).max(8),
    firstHalf: z.array(Shot).min(1), // must end level: no outcome foreshadowed
    branches: z.array(z.array(Shot).min(1)), // one second half per outcome
    ticker: z.array(z.string()),
    canonUpdates: z.array(z.array(z.string())), // per outcome, applied on resolution
    reasoning: z.string().optional(),
  })
  .refine(
    (a) => a.branches.length === a.outcomes.length && a.canonUpdates.length === a.outcomes.length,
    "one branch and one canon update list per outcome",
  );

export type Authored = z.infer<typeof Authored>;
export type Shot = z.infer<typeof Shot>;
