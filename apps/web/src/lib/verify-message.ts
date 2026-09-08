export const VERIFY_PREFIX = "theworldiscollapsing verify";
export const VERIFY_MAX_AGE_S = 300;

/** The exact string a user signs to prove they control the address they are verifying. */
export const buildVerifyMessage = (address: string, unixSeconds: number) =>
  `${VERIFY_PREFIX} ${address} ${unixSeconds}`;

export type MessageCheck = { ok: true } | { ok: false; reason: string };

/**
 * A signature only proves who signed; this proves *what* was signed is a fresh challenge for this
 * address, so an old signature scraped from anywhere cannot be replayed into a verification.
 */
export function checkVerifyMessage(message: string, address: string, nowMs: number): MessageCheck {
  const parts = message.split(" ");
  if (parts.length !== 4 || `${parts[0]} ${parts[1]}` !== VERIFY_PREFIX) return { ok: false, reason: "bad message" };
  if (parts[2].toLowerCase() !== address.toLowerCase()) return { ok: false, reason: "message address mismatch" };
  if (!/^\d+$/.test(parts[3])) return { ok: false, reason: "bad timestamp" };
  const ageS = Math.abs(nowMs / 1000 - Number(parts[3]));
  if (ageS > VERIFY_MAX_AGE_S) return { ok: false, reason: "message expired" };
  return { ok: true };
}
