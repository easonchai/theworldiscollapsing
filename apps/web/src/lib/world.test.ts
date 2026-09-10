import { describe, expect, it } from "vitest";
import { hashSignal } from "@worldcoin/idkit/hashing";
import { proofBoundTo } from "./world";

const ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const OTHER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const proof = (signal_hash: string | undefined, items = 1) => ({
  protocol_version: "3.0",
  nonce: "n",
  action: "verify",
  responses: Array.from({ length: items }, () => ({ identifier: "selfie", signal_hash, proof: "0x", nullifier: "0x" })),
});

describe("proofBoundTo", () => {
  it("accepts a proof whose signal hash is this address", () => {
    expect(proofBoundTo(proof(hashSignal(ADDRESS)), ADDRESS)).toBe(true);
  });

  it("does not care how the address was cased — a 0x signal is hashed as bytes", () => {
    expect(proofBoundTo(proof(hashSignal(ADDRESS.toLowerCase())), ADDRESS)).toBe(true);
  });

  it("rejects a proof made for somebody else", () => {
    expect(proofBoundTo(proof(hashSignal(OTHER)), ADDRESS)).toBe(false);
  });

  it("rejects a proof with no signal at all", () => {
    expect(proofBoundTo(proof(undefined), ADDRESS)).toBe(false);
  });

  it("rejects when only one of several credentials is bound", () => {
    const mixed = proof(hashSignal(ADDRESS), 2);
    mixed.responses[1].signal_hash = hashSignal(OTHER);
    expect(proofBoundTo(mixed, ADDRESS)).toBe(false);
  });

  it("rejects anything that is not an IDKit result", () => {
    expect(proofBoundTo(null, ADDRESS)).toBe(false);
    expect(proofBoundTo({ responses: [] }, ADDRESS)).toBe(false);
    expect(proofBoundTo("nonsense", ADDRESS)).toBe(false);
  });
});
