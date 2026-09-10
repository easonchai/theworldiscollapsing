import { describe, expect, it } from "vitest";
import { trustCopy } from "./trust";

const ZERO = "0x0000000000000000000000000000000000000000";
const VERIFIER = "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9";

describe("trustCopy", () => {
  it("claims on-chain verification when Arena has a verifier — the deployed default", () => {
    const copy = trustCopy(VERIFIER);
    expect(copy.proves).toMatch(/on chain/);
    // The bug: the page told bettors resolution still trusted a submitter while a verifier was set.
    expect(copy.doesNot).not.toMatch(/trusts a submitter/);
    expect(copy.doesNot).toMatch(/resolver/);
    expect(copy.doesNot).toMatch(/setVerifier/);
  });

  it("names bail instead of claiming a stalled event never refunds", () => {
    // The bug: the page kept saying "there is no timeout refund" long after Arena.bail shipped.
    for (const copy of [trustCopy(VERIFIER), trustCopy(ZERO), trustCopy(null)]) {
      expect(copy.doesNot).not.toMatch(/no timeout refund/);
      expect(copy.doesNot).toMatch(/bail/);
    }
  });

  it("falls back to trusted mode when the verifier is unset", () => {
    const copy = trustCopy(ZERO);
    expect(copy.proves).toBeNull();
    expect(copy.doesNot).toMatch(/trusts a submitter/);
  });

  it("is case-insensitive about the zero address", () => {
    expect(trustCopy(ZERO.toUpperCase().replace("0X", "0x"))).toEqual(trustCopy(ZERO));
  });

  it("says so instead of guessing when the chain is unreachable", () => {
    const copy = trustCopy(null);
    expect(copy.proves).toBeNull();
    expect(copy.doesNot).toMatch(/unknown/);
  });
});
