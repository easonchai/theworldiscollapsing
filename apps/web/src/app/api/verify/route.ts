import { createWalletClient, http, isAddress, verifyMessage, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, gateAbi, publicClient, GATE, RPC_URL } from "@/lib/chain";
import { verifyGasCap } from "@/lib/limits";
import { checkVerifyMessage } from "@/lib/verify-message";
import { proofBoundTo } from "@/lib/world";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GATE_MODE = (process.env.GATE_MODE ?? process.env.NEXT_PUBLIC_GATE_MODE) === "world" ? "world" : "checkbox";
const WORLD_RP = process.env.WORLD_RP_ID ?? process.env.WORLD_APP_ID ?? "";
const WORLD_VERIFY_URL = "https://developer.world.org/api/v4/verify";

// One verification per address per minute. This route spends the owner's gas, so it is rate-limited
// per address in memory; a real deployment would need a shared store behind multiple instances.
const RATE_MS = 60_000;
const lastVerify = new Map<string, number>();

const bad = (status: number, error: string) => Response.json({ verified: false, error }, { status });

type Body = { address?: string; attest?: boolean; proof?: unknown; message?: string; signature?: string };

export async function POST(request: Request) {
  const ownerKey = process.env.GATE_OWNER_PRIVATE_KEY;
  if (!ownerKey) return bad(500, "GATE_OWNER_PRIVATE_KEY is not set");

  const body = (await request.json().catch(() => null)) as Body | null;
  const address = body?.address;
  if (!body || !address || !isAddress(address)) return bad(400, "address required");
  if (!body.message || !body.signature) return bad(400, "message and signature required");

  // The wallet must prove it asked for this, so nobody can burn our gas verifying strangers.
  const check = checkVerifyMessage(body.message, address, Date.now());
  if (!check.ok) return bad(400, check.reason);
  const signed = await verifyMessage({
    address,
    message: body.message,
    signature: body.signature as Hex,
  }).catch(() => false);
  if (!signed) return bad(401, "bad signature");

  // Already through the gate: say so and spend nothing. Re-clicking Verify, or a second tab, must
  // not put another transaction on the owner's card — and must not be answered with a 429 either.
  const already = await publicClient.readContract({
    address: GATE,
    abi: gateAbi,
    functionName: "verified",
    args: [address],
  });
  if (already) return Response.json({ verified: true, tx: null });

  const last = lastVerify.get(address.toLowerCase());
  if (last && Date.now() - last < RATE_MS) return bad(429, "one verification per address per minute");

  if (GATE_MODE === "checkbox") {
    if (body.attest !== true) return bad(400, "18+ attestation required");
  } else {
    if (!body.proof) return bad(400, "World proof required");
    if (!WORLD_RP) return bad(500, "WORLD_RP_ID is not set");
    // The proof has to be this address's proof, not just some valid human's.
    if (!proofBoundTo(body.proof, address)) return bad(401, "proof is not bound to this address");
    // The docs are explicit: forward the complete IDKit result, do not remap response identifiers.
    const res = await fetch(`${WORLD_VERIFY_URL}/${WORLD_RP}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body.proof),
    });
    const verdict = (await res.json().catch(() => null)) as { success?: boolean; detail?: string } | null;
    if (!res.ok || verdict?.success !== true) return bad(401, verdict?.detail ?? `World verify failed (${res.status})`);
  }

  // The per-address limit is bypassed by generating fresh addresses, so the gas itself is capped.
  if (!verifyGasCap.take()) return bad(429, "verification is rate limited right now — try again later");

  lastVerify.set(address.toLowerCase(), Date.now());
  const wallet = createWalletClient({ account: privateKeyToAccount(ownerKey as Hex), chain, transport: http(RPC_URL) });
  const tx = await wallet.writeContract({ address: GATE, abi: gateAbi, functionName: "setVerified", args: [address, true] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== "success") return bad(502, "setVerified reverted");
  return Response.json({ verified: true, tx });
}
