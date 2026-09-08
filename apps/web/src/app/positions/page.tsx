import { PositionsList } from "@/components/positions-list";

export default function PositionsPage() {
  return (
    <div>
      <header className="border-b border-line px-2 py-2">
        <p className="text-[13px] leading-[1.5] text-dim">What you are holding.</p>
        <h1 className="mt-1 text-[clamp(34px,5vw,66px)] leading-none text-bone">Positions</h1>
      </header>
      <PositionsList />
    </div>
  );
}
