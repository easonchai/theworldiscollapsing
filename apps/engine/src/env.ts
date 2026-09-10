/** Env plumbing for the entry point, here so it can be tested without booting the engine. */

/** Required env var with an optional default. Empty counts as missing: a blank key is not a key. */
export const env = (k: string, fallback?: string): string => {
  const v = process.env[k] ?? fallback;
  if (v === undefined || v === "") throw new Error(`missing env ${k}`);
  return v;
};

/**
 * Mode flag. `1` and `true` (any case) turn it on; anything else, including unset, is off.
 * An exact `=== "1"` test made `DEMO_MODE=true` silently mean off, which reads as a broken engine.
 */
export const flag = (k: string): boolean => /^(1|true)$/i.test((process.env[k] ?? "").trim());
