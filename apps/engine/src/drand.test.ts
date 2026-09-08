import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import { fetchRound, outcomeFor, roundAt, roundForLock, roundTime, GENESIS } from "./drand.js";

// Same fixture as packages/contracts/test/Arena.t.sol: real quicknet round 32026121.
const SIG =
  "0x86da6c35d9cad6916a54c9a0679f031bc5dd6ec3515a5d4eaa512077fd9fb97164c1838a9ad6ac70a00f36f016c86977" as const;
const EID = keccak256(toHex("sports:1"));

describe("round math", () => {
  it("round 1 is genesis; round 32026121 is 1788881727", () => {
    expect(roundTime(1n)).toBe(GENESIS);
    expect(roundTime(32026121n)).toBe(1788881727n);
  });
  it("roundAt boundaries", () => {
    expect(roundAt(1788881727n)).toBe(32026121n);
    expect(roundAt(1788881726n)).toBe(32026121n);
    expect(roundAt(1788881728n)).toBe(32026122n);
    expect(roundAt(0n)).toBe(1n);
  });
  it("roundForLock applies the suspense gap", () => {
    const lock = 1788881727n;
    expect(roundTime(roundForLock(lock))).toBeGreaterThanOrEqual(lock + 10n);
    expect(roundForLock(lock)).toBe(roundAt(lock + 10n));
  });
});

describe("outcome derivation", () => {
  it("matches the contract fixture", () => {
    expect(EID).toBe("0xfa9065743d1211e328d8534fe669e4f60e9a24fec6efb614d9add44c96f9b674");
    expect(outcomeFor(SIG, EID, 2)).toBe(1);
    expect(outcomeFor(SIG, EID, 3)).toBe(1);
    expect(outcomeFor(SIG, EID, 5)).toBe(4);
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
    const b = await fetchRound(32026121n, ok({ round: 32026121, signature: SIG.slice(2) }));
    expect(b).toEqual({ round: 32026121n, signature: SIG });
  });
  it("rejects wrong round", async () => {
    await expect(fetchRound(5n, ok({ round: 6, signature: SIG.slice(2) }))).rejects.toThrow(/expected round 5/);
  });
  it("rejects malformed signature", async () => {
    await expect(fetchRound(5n, ok({ round: 5, signature: "zz" }))).rejects.toThrow(/malformed/);
  });
  it("rejects non-2xx", async () => {
    await expect(fetchRound(5n, ok({}, 404))).rejects.toThrow(/HTTP 404/);
  });
});
