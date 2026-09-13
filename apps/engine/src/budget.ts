// Hard spend ceiling for everything the engine buys from OpenRouter. Charges are recorded the
// moment a request is committed to the vendor, success or failure, so retries and failed jobs
// count. The running total is persisted (World.spendUsd) so a restart cannot reset it.

export class SpendCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpendCapError";
  }
}

export type Budget = {
  capUsd: number;
  spent(): number;
  /** Throws SpendCapError when `usd` more would cross the cap. Call before every paid request. */
  assertAffordable(usd: number, what: string): void;
  /** Records spend as soon as it is committed to a vendor. */
  charge(usd: number, what: string): Promise<void>;
};

export function makeBudget(cfg: {
  capUsd: number;
  spentUsd: number;
  persist: (usd: number) => Promise<void>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}): Budget {
  let spent = cfg.spentUsd;
  return {
    capUsd: cfg.capUsd,
    spent: () => spent,
    assertAffordable(usd, what) {
      if (spent + usd > cfg.capUsd) {
        throw new SpendCapError(
          `spend cap: ${what} needs $${usd.toFixed(2)} but $${spent.toFixed(2)} of $${cfg.capUsd.toFixed(2)} is already spent; raise MAX_SPEND_USD and restart`,
        );
      }
    },
    async charge(usd, what) {
      // Negative usd is a true-up refund (estimate was over the sidecar's actual billed_s), not a
      // no-op: dropping it here silently ate every refund. Floor at zero so a refund larger than
      // what is actually spent (should not happen, but a vendor's numbers are not ours to trust)
      // cannot push World.spendUsd negative.
      const applied = Math.max(-spent, usd);
      if (applied === 0) return;
      spent += applied;
      cfg.log("spend", { what, usd: Math.round(applied * 1000) / 1000, totalUsd: Math.round(spent * 100) / 100, capUsd: cfg.capUsd });
      await cfg.persist(applied);
    },
  };
}

/** Loopback: nothing behind one of these hosts can charge a card. */
const LOOPBACK = /^(localhost|127(\.\d+){1,3}|\[?::1\]?)$/i;

/**
 * Can `baseUrl` cost money? A vendor on loopback is the local fake (`pnpm --filter engine fake`):
 * its clips are free ffmpeg patterns, so charging them the real MiniMax rate table stops the wall a
 * few events into a soak — and World.spendUsd is cumulative, so a restart does not clear it.
 * Everything else, including anything unparseable, keeps the cap: failing open costs real dollars,
 * failing closed only ends a fake run early with a log line saying why.
 */
export const billsRealMoney = (baseUrl: string): boolean => {
  try {
    return !LOOPBACK.test(new URL(baseUrl).hostname);
  } catch {
    return true;
  }
};

/** For tests, stub mode and fake vendors: never throws, never persists. */
export const unlimited = (): Budget => makeBudget({ capUsd: Number.POSITIVE_INFINITY, spentUsd: 0, persist: async () => {}, log: () => {} });
