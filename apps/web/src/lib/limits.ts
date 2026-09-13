/**
 * In-memory limiters for the two routes that cost something: `/api/verify` spends the gate owner's
 * gas, `/api/heartbeat` keeps the engine authoring paid events. Per process, so a second instance
 * gets its own budget — a real deployment would need a shared store, which this demo does not have.
 * ponytail: in-memory is the ceiling; move both to Redis if this ever runs on more than one box.
 */

/** One accepted call per key per window. */
export function perKeyLimiter(windowMs: number, maxKeys = 5000) {
  const seen = new Map<string, number>();
  return {
    take(key: string, now = Date.now()): boolean {
      const last = seen.get(key);
      if (last !== undefined && now - last < windowMs) return false;
      // Sweep only when the map has grown: a pass per call would cost more than the entries do.
      if (seen.size >= maxKeys) for (const [k, t] of seen) if (now - t >= windowMs) seen.delete(k);
      seen.set(key, now);
      return true;
    },
  };
}

/** At most `limit` accepted calls in any `windowMs`, counted across every caller. */
export function windowLimiter(limit: number, windowMs: number) {
  let hits: number[] = [];
  return {
    take(now = Date.now()): boolean {
      hits = hits.filter((t) => now - t < windowMs);
      if (hits.length >= limit) return false;
      hits.push(now);
      return true;
    },
  };
}

/**
 * The gate owner's gas budget: the per-address limit is bypassed by generating fresh addresses, so
 * the number of `setVerified` transactions this instance will ever send in an hour is capped too.
 */
export const verifyGasCap = windowLimiter(30, 60 * 60 * 1000);

/** Presence is a boolean, not a counter: one write per client per 10 s says everything it can say. */
export const heartbeatLimit = perKeyLimiter(10_000);

/**
 * The per-client limiter above is keyed on `X-Forwarded-For`, which a caller sends and can rotate,
 * so it caps nothing on its own; this caps the total across every key. `present()` in the engine's
 * `machine.ts` only asks whether the last accepted write is fresher than `presenceWindowMs` (5
 * minutes in REAL), so one accepted write a minute already keeps that answer fresh no matter how
 * many viewers are watching. Ten a minute leaves headroom for a real crowd and gives a header-rotator
 * nothing worth the trouble.
 */
export const presenceCeiling = windowLimiter(10, 60_000);
