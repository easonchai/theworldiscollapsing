import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";
import { buildVerifyMessage, checkVerifyMessage } from "./verify-message";

const ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const NOW = 1_788_886_000_000;
const TS = Math.floor(NOW / 1000);

describe("checkVerifyMessage", () => {
  it("accepts a fresh message for the address", () => {
    expect(checkVerifyMessage(buildVerifyMessage(ADDR, TS), ADDR, NOW)).toEqual({ ok: true });
    expect(checkVerifyMessage(buildVerifyMessage(ADDR, TS), ADDR.toLowerCase(), NOW)).toEqual({ ok: true });
  });

  it("rejects a message signed for another address", () => {
    const other = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    expect(checkVerifyMessage(buildVerifyMessage(other, TS), ADDR, NOW).ok).toBe(false);
  });

  it("rejects a stale or future timestamp", () => {
    expect(checkVerifyMessage(buildVerifyMessage(ADDR, TS - 301), ADDR, NOW).ok).toBe(false);
    expect(checkVerifyMessage(buildVerifyMessage(ADDR, TS + 301), ADDR, NOW).ok).toBe(false);
    expect(checkVerifyMessage(buildVerifyMessage(ADDR, TS - 299), ADDR, NOW).ok).toBe(true);
  });

  it("rejects anything that is not the challenge", () => {
    for (const m of ["", "hello", `theworldiscollapsing ${ADDR} ${TS}`, `theworldiscollapsing verify ${ADDR}`]) {
      expect(checkVerifyMessage(m, ADDR, NOW).ok).toBe(false);
    }
  });
});

describe("signature round trip", () => {
  it("recovers the signer of the challenge and rejects a signature from someone else", async () => {
    const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const impostor = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    const message = buildVerifyMessage(account.address, TS);
    expect(account.address).toBe(ADDR);
    expect(await verifyMessage({ address: account.address, message, signature: await account.signMessage({ message }) })).toBe(true);
    expect(
      await verifyMessage({ address: account.address, message, signature: await impostor.signMessage({ message }) }),
    ).toBe(false);
  });
});
