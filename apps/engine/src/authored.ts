import { z } from "zod";

// The contract between the authoring model and everything downstream.
// Validated before any money (createEvent) or media (render) is committed.
/**
 * 6, not MiniMax's 5: Reactor fast-h3 refuses a shorter clip with
 * "seconds: 5.0 < ge(5.167)" (124 frames at 24 fps), and `seconds` is an integer.
 * 14, not 15, at the top: fast-h3 refuses "seconds: 15.0 > le(14.375)" (345 frames), and sports
 * 139 on 2026-09-13 paid for three sessions to learn it. 6 to 14 is inside both vendors' ranges.
 * Exported because the author's target clamp shortens shot lists and has to stop at the floor,
 * and a second copy of either number would drift from this one.
 */
export const MIN_SHOT_SEC = 6;
export const MAX_SHOT_SEC = 14;

export const Shot = z.object({
  prompt: z.string().min(1),
  seconds: z.number().int().min(MIN_SHOT_SEC).max(MAX_SHOT_SEC),
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

/**
 * The scorebug the broadcast keeps in the corner. Optional, and in practice sports-only: a football
 * match has a scoreline, an award ceremony does not.
 *
 * It exists because the video model cannot draw letterforms. Three renders of the culture channel
 * came back with gibberish on every sign and backdrop, so anything a bettor has to READ is page
 * text, never pixels — the same reason `Card` is an overlay. The lengths are short because this is
 * a corner graphic, not a sentence.
 *
 * `atEnd` holds one final per outcome and so is the same class of secret as `branchUrls`: it never
 * leaves the server whole. `toPublic` in web sends the one that has already resolved, or the break
 * score, and nothing else.
 */
export const Score = z.object({
  /**
   * The two competitors as scorebug codes, e.g. ["HAR", "NOR"]. Exactly two, enforced in Authored's
   * refine rather than as a tuple here: a tuple compiles to `prefixItems`, which OpenAI structured
   * outputs rejects outright with "array schema items is not an object", failing the whole call.
   */
  sides: z.array(z.string().min(1).max(4)),
  /** The score at the end of the first half, which the hard rules require to be level. */
  atBreak: z.string().min(1).max(12),
  /** One final score per outcome, in the same order as `outcomes`. */
  atEnd: z.array(z.string().min(1).max(12)).min(2).max(5),
});

export const Authored = z
  .object({
    title: z.string().min(1),
    premise: z.string().min(1),
    // PRD: three to five markets per event, but author.ts now enforces the exact count from
    // N_OUTCOMES, which is strictly tighter than this floor — and the knob documents 2 as a legal
    // value, so the schema floor drops to 2 to admit it.
    outcomes: z.array(z.string().min(1)).min(2).max(5),
    firstHalf: z.array(Shot).min(1), // must end level: no outcome foreshadowed
    branches: z.array(z.array(Shot).min(1)), // one second half per outcome
    cards: z.array(Card).min(1).max(2),
    ticker: z.array(z.string()),
    canonUpdates: z.array(z.array(z.string())), // per outcome, applied on resolution
    /**
     * Nullable, not optional: `strictify` in openrouter.ts lists every property in `required`,
     * which is what `strict: true` demands, so an "optional" field is one the model must still
     * emit. Asking a non-sports channel to omit it is therefore an instruction it cannot follow.
     * Null is a shape it can actually return, and `makeAuthor` decides the channel anyway.
     */
    score: Score.nullable(),
    reasoning: z.string().optional(),
  })
  .refine(
    (a) => a.branches.length === a.outcomes.length && a.canonUpdates.length === a.outcomes.length,
    "one branch and one canon update list per outcome",
  )
  .refine((a) => !a.score || a.score.atEnd.length === a.outcomes.length, "one final score per outcome")
  .refine((a) => !a.score || a.score.sides.length === 2, "a scorebug has exactly two sides")
  .refine((a) => a.cards.every((c) => c.afterShot < a.firstHalf.length), "every card's afterShot must index a first-half shot");

export type Authored = z.infer<typeof Authored>;
export type Shot = z.infer<typeof Shot>;
export type Card = z.infer<typeof Card>;
export type Score = z.infer<typeof Score>;
