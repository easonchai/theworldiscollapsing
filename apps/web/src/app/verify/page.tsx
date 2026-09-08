import Link from "next/link";
import { VerifyFlow } from "@/components/verify-flow";
import { ARENA, arenaAbi, publicClient } from "@/lib/chain";
import { trustCopy } from "@/lib/trust";

export const dynamic = "force-dynamic";

/** What resolution actually enforces, read from the deployment rather than assumed. */
async function readVerifier(): Promise<string | null> {
  try {
    return await publicClient.readContract({ address: ARENA, abi: arenaAbi, functionName: "verifier" });
  } catch {
    return null;
  }
}

export default async function VerifyPage() {
  const trust = trustCopy(await readVerifier());

  return (
    <div>
      <header className="border-b border-line px-2 py-2">
        <p className="text-[13px] leading-[1.5] text-dim">Before you can bet.</p>
        <h1 className="mt-1 text-[clamp(34px,5vw,66px)] leading-none text-bone">Get on the floor</h1>
        <p className="mt-2 max-w-[70ch] text-[13px] leading-[1.5] text-dim">
          The faucet and every bet are gated on chain by a verified flag. Three steps, once.
        </p>
      </header>

      <VerifyFlow />

      <section className="grid gap-px border-t border-line bg-line lg:grid-cols-2">
        <div className="bg-vac p-2">
          <p className="tag">what this proves</p>
          <ul className="mt-2 max-w-[60ch] space-y-2 text-[14px] text-bone">
            <li>Betting closes on chain before the deciding drand round exists.</li>
            <li>The outcome is a public function of that round&rsquo;s signature and the event id.</li>
            <li>Every event page checks the stored signature against drand itself.</li>
            {trust.proves ? <li>{trust.proves}</li> : null}
          </ul>
        </div>
        <div className="bg-vac p-2">
          <p className="tag">what it does not</p>
          <ul className="mt-2 max-w-[60ch] space-y-2 text-[14px] text-dim">
            <li>Verification is liveness, not age. 18+ is your own word.</li>
            <li>{trust.doesNot}</li>
            <li>
              This is testnet play money.{" "}
              <Link href="/" className="text-amber underline underline-offset-2">
                Go watch the wall.
              </Link>
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
}
