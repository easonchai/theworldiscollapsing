import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publicClient } from "./chain";
import { betRevertMessage, confirmed } from "./tx";

const receipt = (status: "success" | "reverted") =>
  vi
    .spyOn(publicClient, "waitForTransactionReceipt")
    .mockResolvedValue({ status, blockNumber: 98n } as Awaited<
      ReturnType<typeof publicClient.waitForTransactionReceipt>
    >);

afterEach(() => vi.restoreAllMocks());

describe("confirmed", () => {
  it("throws when the transaction was mined but reverted", async () => {
    receipt("reverted");
    await expect(confirmed("0xdead", () => "betting closed")).rejects.toThrow("betting closed");
  });

  it("returns the receipt when the transaction succeeded", async () => {
    receipt("success");
    await expect(confirmed("0xbeef", () => "unused")).resolves.toMatchObject({ blockNumber: 98n });
  });
});

describe("betRevertMessage", () => {
  it("names the lock when the bet was mined at or after it", () => {
    const lock = "2026-09-09T10:00:00.000Z";
    expect(betRevertMessage(lock, Date.parse(lock))).toContain("Betting closed");
    expect(betRevertMessage(lock, Date.parse(lock) + 5000)).toContain("Betting closed");
  });

  it("stays generic while betting was still open", () => {
    expect(betRevertMessage("2026-09-09T10:00:00.000Z", Date.parse("2026-09-09T09:59:58.000Z"))).toBe(
      "The bet reverted on chain — nothing was staked.",
    );
    expect(betRevertMessage(null, Date.now())).toContain("reverted on chain");
  });
});

// The original bug: a component awaited the receipt and never read `status`, so a reverted bet was
// announced as "Bet confirmed in block N". Every client write goes through `confirmed` instead.
describe("client writes", () => {
  it("never wait on a receipt without checking it", () => {
    const dir = path.join(__dirname, "..", "components");
    for (const file of readdirSync(dir)) {
      const source = readFileSync(path.join(dir, file), "utf8");
      expect(`${file}: ${source.includes("waitForTransactionReceipt")}`).toBe(`${file}: false`);
    }
  });
});
