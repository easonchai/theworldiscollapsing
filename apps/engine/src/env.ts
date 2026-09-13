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

/** Integer env var with a fallback, validated to fall within [min, max]. Throws a clear message otherwise. */
export const intEnv = (k: string, fallback: string, min: number, max: number): number => {
  const raw = env(k, fallback);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${k} must be an integer ${min} to ${max}, got ${raw}`);
  return n;
};

/** Comma-separated env var: split, trim each entry, drop empties. Whitespace after a comma is not a new value. */
export const list = (k: string, fallback: string): string[] =>
  env(k, fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
