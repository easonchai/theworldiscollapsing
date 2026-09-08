import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import { fetchRound, outcomeFor, roundAt, roundForLock, roundTime, GENESIS } from "./drand.js";

// Same fixture as packages/contracts/test/Arena.t.sol: real evmnet round 20456251.
const SIG =
  "0x1a909b075202e693fc0e3bd141bbb24fce116a6ffb4343674417b89de6c658492379ad0c3a0c34a4ac46b9130948e781e527430db6240fef8253931abbb7f768" as const;
const EID = keccak256(toHex("sports:1"));

describe("round math", () => {
  it("round 1 is genesis; round 20456251 is 1788889825", () => {
    expect(GENESIS).toBe(1727521075n); // drand evmnet genesis_time
    expect(roundTime(1n)).toBe(GENESIS);
    expect(roundTime(20456251n)).toBe(1788889825n);
  });
  it("roundAt boundaries", () => {
    expect(roundAt(1788889825n)).toBe(20456251n);
    expect(roundAt(1788889824n)).toBe(20456251n);
    expect(roundAt(1788889826n)).toBe(20456252n);
    expect(roundAt(0n)).toBe(1n);
  });
  it("roundForLock applies the suspense gap", () => {
    const lock = 1788889825n;
    expect(roundTime(roundForLock(lock))).toBeGreaterThanOrEqual(lock + 10n);
    expect(roundForLock(lock)).toBe(roundAt(lock + 10n));
  });
});

describe("outcome derivation", () => {
  it("matches the contract fixture", () => {
    expect(EID).toBe("0xfa9065743d1211e328d8534fe669e4f60e9a24fec6efb614d9add44c96f9b674");
    expect(outcomeFor(SIG, EID, 2)).toBe(0);
    expect(outcomeFor(SIG, EID, 3)).toBe(1);
    expect(outcomeFor(SIG, EID, 5)).toBe(1);
  });
  it("looks uniform over many event ids", () => {
    const counts = [0, 0, 0];
    for (let i = 0; i < 3000; i++) counts[outcomeFor(SIG, keccak256(toHex(`e${i}`)), 3)]++;
    for (const c of counts) expect(Math.abs(c - 1000)).toBeLessThan(120);
  });
});

describe("fetchRound", () => {
  const ok = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("parses a good beacon", async () => {
    const b = await fetchRound(20456251n, ok({ round: 20456251, signature: SIG.slice(2) }));
    expect(b).toEqual({ round: 20456251n, signature: SIG });
  });
  it("rejects wrong round", async () => {
    await expect(fetchRound(5n, ok({ round: 6, signature: SIG.slice(2) }))).rejects.toThrow(/expected round 5/);
  });
  it("rejects malformed signature", async () => {
    await expect(fetchRound(5n, ok({ round: 5, signature: "zz" }))).rejects.toThrow(/malformed/);
  });
  it("rejects a 48-byte quicknet signature — Arena only accepts 64-byte evmnet points", async () => {
    const quicknet = "86da6c35d9cad6916a54c9a0679f031bc5dd6ec3515a5d4eaa512077fd9fb97164c1838a9ad6ac70a00f36f016c86977";
    await expect(fetchRound(5n, ok({ round: 5, signature: quicknet }))).rejects.toThrow(/malformed/);
  });
  it("rejects non-2xx", async () => {
    await expect(fetchRound(5n, ok({}, 404))).rejects.toThrow(/HTTP 404/);
  });
});
