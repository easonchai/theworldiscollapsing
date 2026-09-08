import { signRequest } from "@worldcoin/idkit/signing";
import { WORLD_ACTION } from "@/lib/chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * IDKit 4.x requires an `rp_context` signed by the relying party's key, so the widget cannot be
 * opened from the browser alone. World mode is off until both values are configured.
 */
export async function GET() {
  const rpId = process.env.WORLD_RP_ID;
  const signingKeyHex = process.env.WORLD_RP_SIGNING_KEY;
  if (!rpId || !signingKeyHex) {
    return Response.json({ error: "WORLD_RP_ID and WORLD_RP_SIGNING_KEY are not set" }, { status: 501 });
  }
  const signed = signRequest({ signingKeyHex, action: WORLD_ACTION });
  return Response.json({
    rp_id: rpId,
    nonce: signed.nonce,
    created_at: signed.createdAt,
    expires_at: signed.expiresAt,
    signature: signed.sig,
  });
}
