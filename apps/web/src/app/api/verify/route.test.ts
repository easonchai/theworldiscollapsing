import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { GAS_DRIP, publicClient } from "@/lib/chain";

// The owner's wallet client is the only thing the route uses to spend, so it is the one fake.
const sent: { to?: string; value?: bigint }[] = [];
vi.mock("viem", async (importOriginal) => {
  const viem = await importOriginal<typeof import("viem")>();
  return {
    ...viem,
    createWalletClient: () => ({
      sendTransaction: async (args: { to: string; value: bigint }) => {
        sent.push(args);
        return "0xdeadbeef";
      },
    }),
  };
});
import { verifyGasCap } from "@/lib/limits";
import { buildVerifyMessage } from "@/lib/verify-message";

// anvil account 1, used as the address asking to be verified.
const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

let POST: (request: Request) => Promise<Response>;

beforeAll(async () => {
  process.env.GATE_OWNER_PRIVATE_KEY ??= "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  ({ POST } = await import("./route"));
});

/** A body signed by the address it names, the way the verify page builds it. */
async function body(over: Record<string, unknown> = {}) {
  const message = buildVerifyMessage(account.address, Math.floor(Date.now() / 1000));
  return {
    address: account.address,
    attest: true,
    message,
    signature: await account.signMessage({ message }),
    ...over,
  };
}

const post = async (payload: Record<string, unknown>) =>
  POST(new Request("http://station.local/api/verify", { method: "POST", body: JSON.stringify(payload) }));

/** Whether the gate says this address is already verified. Nothing here ever touches a chain. */
const gateSays = (verified: boolean, balance = parseEther("1")) => {
  vi.spyOn(publicClient, "getBalance").mockResolvedValue(balance);
  vi.spyOn(publicClient, "waitForTransactionReceipt").mockResolvedValue({ status: "success" } as never);
  return vi.spyOn(publicClient, "readContract").mockResolvedValue(verified as never);
};

afterEach(() => {
  vi.restoreAllMocks();
  sent.length = 0;
});

describe("POST /api/verify", () => {
  it("still requires a wallet signature", async () => {
    const res = await post({ address: account.address, attest: true });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "message and signature required" });
  });

  it("rejects a signature from another wallet", async () => {
    gateSays(false);
    const signed = await body();
    const other = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    const res = await post({ ...signed, signature: await other.signMessage({ message: signed.message }) });
    expect(res.status).toBe(401);
  });

  it("short-circuits an address the gate already knows, without sending a transaction", async () => {
    const read = gateSays(true);
    const res = await post(await body());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ verified: true, tx: null, gas: null });
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ functionName: "verified" }));
    expect(sent).toEqual([]);
  });

  it("drips gas into a verified wallet that cannot pay for its own faucet call", async () => {
    gateSays(true, 0n);
    const res = await post(await body());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ verified: true, tx: null, gas: "0xdeadbeef" });
    expect(sent).toEqual([{ to: account.address, value: GAS_DRIP }]);
  });

  it("stops spending gas once the hourly cap is used up", async () => {
    gateSays(false);
    // Whoever got there first — 30 transactions in an hour is the whole budget, drips included.
    while (verifyGasCap.take());
    const res = await post(await body());
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toMatchObject({ verified: false });
  });
});
