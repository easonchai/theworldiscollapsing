import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseError, ContractFunctionRevertedError, toFunctionSelector, type Abi } from "viem";
import { arenaAbi, mockusdcAbi, publicClient } from "./chain";
import { betRevertMessage, confirmed, revertName, txMessage } from "./tx";

const receipt = (status: "success" | "reverted") =>
  vi
    .spyOn(publicClient, "waitForTransactionReceipt")
    .mockResolvedValue({ status, blockNumber: 98n } as Awaited<
      ReturnType<typeof publicClient.waitForTransactionReceipt>
    >);

/**
 * What viem throws out of `simulateContract` when the contract reverts with a custom error. Every
 * error mapped here takes no arguments, so the revert data is just the error's selector.
 */
const revert = (abi: Abi, errorName: string) =>
  new BaseError("execution reverted", {
    cause: new ContractFunctionRevertedError({
      abi,
      data: toFunctionSelector(`${errorName}()`),
      functionName: "bet",
    }),
  });

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

describe("txMessage", () => {
  it("says what each Arena revert means", () => {
    const said = (name: string) => txMessage(revert(arenaAbi, name)).text;
    expect(said("BettingClosed")).toBe("Betting is closed on this event — nothing was staked.");
    expect(said("BadOutcome")).toBe("That market is not on this event.");
    expect(said("ZeroAmount")).toBe("Enter a stake above zero.");
    expect(said("BelowMinBet")).toBe("The minimum bet is 1 USDC — nothing was staked.");
    expect(said("NothingToClaim")).toBe("Nothing to claim on this event.");
    expect(said("NotResolved")).toBe("The round has not landed yet, so there is nothing to claim.");
    expect(said("UnknownEvent")).toBe("This event is not on chain.");
  });

  it("sends an unverified address to the gate, from either contract", () => {
    for (const abi of [arenaAbi, mockusdcAbi]) {
      expect(txMessage(revert(abi, "NotVerified"))).toEqual({
        text: "This address is not verified yet.",
        href: "/verify",
      });
    }
  });

  it("explains the faucet cooldown", () => {
    expect(txMessage(revert(mockusdcAbi, "FaucetCooldown")).text).toContain("once a day");
  });

  it("falls back to the first line of whatever viem said", () => {
    expect(revertName(new Error("boom"))).toBeNull();
    expect(txMessage(new Error("User rejected the request.\nDetails: …"))).toEqual({
      text: "User rejected the request.",
      href: null,
    });
  });
});

// The original bug: a component awaited the receipt and never read `status`, so a reverted bet was
// announced as "Bet confirmed in block N". Every client write goes through `confirmed` instead, and
// every one of them simulates first so a doomed call never reaches the wallet.
describe("client writes", () => {
  const components = path.join(__dirname, "..", "components");
  const sources = readdirSync(components).map((file) => ({
    file,
    source: readFileSync(path.join(components, file), "utf8"),
  }));

  it("never wait on a receipt without checking it", () => {
    for (const { file, source } of sources) {
      expect(`${file}: ${source.includes("waitForTransactionReceipt")}`).toBe(`${file}: false`);
    }
  });

  it("simulate every contract call before signing it", () => {
    for (const { file, source } of sources) {
      if (!source.includes("writeContract")) continue;
      expect(`${file}: ${source.includes("simulateContract")}`).toBe(`${file}: true`);
    }
  });
});
