/** Broadcast clock: always two digits per field, so 00:11 never re-flows into 0:11. */
export const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
};

/**
 * Split a clock into the fields that are not counting yet and the one that is: "00:15" → ["00:", "15"].
 * At 120px a lead of dead zeros out-weighs the seconds actually ticking, so the caller dims the
 * first half and leaves the second at full strength. The width never changes either way.
 */
export function splitClock(text: string): [string, string] {
  const dead = /^[0:]*(?=\d)/.exec(text)?.[0] ?? "";
  return [dead, text.slice(dead.length)];
}
