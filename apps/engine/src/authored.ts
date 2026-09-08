import { z } from "zod";

// The contract between the authoring model and everything downstream.
// Validated before any money (createEvent) or media (render) is committed.
export const Shot = z.object({
  prompt: z.string().min(1),
  seconds: z.number().int().min(5).max(15), // MiniMax H3 Max clip range
});

/**
 * A studio graphic the broadcast cuts to between first-half clips (PRD story 11): it paces the
 * broadcast like television and masks the join between two independently generated clips. It is
 * text, so it is rendered as an overlay in web — this machine's ffmpeg has no `drawtext`.
 */
export const Card = z.object({
  afterShot: z.number().int().min(0), // index of the first-half shot this card follows
  title: z.string().min(1).max(48),
  stats: z.array(z.string().min(1).max(48)).min(2).max(2),
});

export const Authored = z
  .object({
    title: z.string().min(1),
    premise: z.string().min(1),
    // PRD: three to five markets per event. Two is a coin flip, not a spread.
    outcomes: z.array(z.string().min(1)).min(3).max(5),
    firstHalf: z.array(Shot).min(1), // must end level: no outcome foreshadowed
    branches: z.array(z.array(Shot).min(1)), // one second half per outcome
    cards: z.array(Card).min(1).max(2),
    ticker: z.array(z.string()),
    canonUpdates: z.array(z.array(z.string())), // per outcome, applied on resolution
    reasoning: z.string().optional(),
  })
  .refine(
    (a) => a.branches.length === a.outcomes.length && a.canonUpdates.length === a.outcomes.length,
    "one branch and one canon update list per outcome",
  )
  .refine((a) => a.cards.every((c) => c.afterShot < a.firstHalf.length), "every card's afterShot must index a first-half shot");

export type Authored = z.infer<typeof Authored>;
export type Shot = z.infer<typeof Shot>;
export type Card = z.infer<typeof Card>;
