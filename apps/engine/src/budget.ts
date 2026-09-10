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
      if (usd <= 0) return;
      spent += usd;
      cfg.log("spend", { what, usd: Math.round(usd * 1000) / 1000, totalUsd: Math.round(spent * 100) / 100, capUsd: cfg.capUsd });
      await cfg.persist(usd);
    },
  };
}

/** For tests and stub mode: never throws, never persists. */
export const unlimited = (): Budget => makeBudget({ capUsd: Number.POSITIVE_INFINITY, spentUsd: 0, persist: async () => {}, log: () => {} });
