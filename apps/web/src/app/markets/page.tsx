import { MarketsList } from "@/components/markets-list";

export const metadata = { title: "Markets" };

export default function MarketsPage() {
  return (
    <div>
      <header className="border-b border-line px-2 py-2">
        <p className="text-[13px] leading-[1.5] text-dim">Every market in the world.</p>
        <h1 className="mt-1 text-[clamp(34px,5vw,66px)] leading-none text-bone">Markets</h1>
      </header>
      <MarketsList />
    </div>
  );
}
