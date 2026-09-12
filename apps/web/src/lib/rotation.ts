import type { EventPublic } from "./public";

/**
 * What a channel page is showing: the event on air, and an event that resolved under the viewer
 * before the channel moved on.
 *
 * A channel rotates `current` the moment the engine starts the next event, 5 s after the reveal in
 * DEMO and 60 s in REAL (docs/CONTRACTS.md, Timing). A bettor who just won is reading their claim in
 * exactly that window, so the finished event is kept beside the new one until it is claimed or
 * dismissed rather than leaving the screen mid-click.
 */
export type ChannelView = { current: EventPublic; pinned: EventPublic | null };

/** Fold the newest copy of the channel's on-air event into the view. */
export function rotate(view: ChannelView, incoming: EventPublic): ChannelView {
  // Same event, fresher data (an outcome, a new state): nothing rotated.
  if (incoming.id === view.current.id) return { ...view, current: incoming };
  // A late update for the event already pinned must not put it back on air.
  if (incoming.id === view.pinned?.id) return view;
  return {
    current: incoming,
    // Nothing was decided while the outgoing event was on air, so there is nothing to claim from
    // it — and an older pin that is still owed money outlives it.
    pinned: view.current.outcome !== null ? view.current : view.pinned,
  };
}
