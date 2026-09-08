import { MarketsList } from "@/components/markets-list";

export default function MarketsPage() {
  return (
    <div>
      <header className="border-b border-line px-3 py-3">
        <p className="tag">every market in the world</p>
        <h1 className="mt-1 text-[clamp(34px,5vw,66px)] leading-none text-bone">Markets</h1>
      </header>
      <MarketsList />
    </div>
  );
}
