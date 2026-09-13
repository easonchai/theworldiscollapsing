import { describe, expect, it } from "vitest";
import { billsRealMoney, makeBudget, SpendCapError, unlimited } from "./budget.js";

describe("budget", () => {
  it("accumulates and persists every charge", async () => {
    const persisted: number[] = [];
    const b = makeBudget({ capUsd: 10, spentUsd: 2.5, persist: async (u) => { persisted.push(u); }, log: () => {} });
    await b.charge(1.25, "clip");
    await b.charge(0.04, "key art");
    expect(b.spent()).toBeCloseTo(3.79);
    expect(persisted).toEqual([1.25, 0.04]);
  });

  it("accepts a negative charge as a true-up refund, and floors total spend at zero", async () => {
    const persisted: number[] = [];
    const b = makeBudget({ capUsd: 10, spentUsd: 2, persist: async (u) => { persisted.push(u); }, log: () => {} });
    await b.charge(-0.5, "true-up");
    expect(b.spent()).toBeCloseTo(1.5);
    await b.charge(-10, "over-refund");
    expect(b.spent()).toBe(0);
    expect(persisted).toEqual([-0.5, -1.5]);
  });

  it("throws SpendCapError when a charge would cross the cap, and names the env var", () => {
    const b = makeBudget({ capUsd: 5, spentUsd: 4.5, persist: async () => {}, log: () => {} });
    expect(() => b.assertAffordable(0.5, "clip")).not.toThrow();
    expect(() => b.assertAffordable(0.51, "clip")).toThrow(SpendCapError);
    expect(() => b.assertAffordable(0.51, "clip")).toThrow(/MAX_SPEND_USD/);
  });

  it("unlimited never throws", () => {
    expect(() => unlimited().assertAffordable(1e9, "anything")).not.toThrow();
  });

  it("the loopback fake is free; every remote vendor, and anything unparseable, stays capped", () => {
    expect(billsRealMoney("http://127.0.0.1:4100")).toBe(false);
    expect(billsRealMoney("http://localhost:4100/v1")).toBe(false);
    expect(billsRealMoney("http://[::1]:4100")).toBe(false);
    expect(billsRealMoney("https://openrouter.ai")).toBe(true);
    expect(billsRealMoney("https://gateway.example.com")).toBe(true);
    expect(billsRealMoney("openrouter")).toBe(true);
  });
});
