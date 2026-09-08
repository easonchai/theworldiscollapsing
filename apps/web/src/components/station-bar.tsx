"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useGate } from "./chain-hooks";
import { useWallet } from "./wallet";

const NAV = [
  ["/", "Wall"],
  ["/markets", "Markets"],
  ["/positions", "Positions"],
  ["/verify", "Verify"],
] as const;

export function StationBar() {
  const path = usePathname();
  const { address, ready, login, logout } = useWallet();
  const { gate } = useGate();

  return (
    <header className="fixed inset-x-0 top-0 z-50 flex h-[46px] items-stretch overflow-x-auto border-b border-line bg-vac/95 backdrop-blur-[2px]">
      {/* One weight, one colour. The only emphasis is the amber on-air dot beside it. */}
      <Link href="/" className="flex items-center gap-2 border-r border-line px-3 hover:bg-panel2">
        <span className="pulse size-[7px] bg-amber" aria-hidden />
        <span className="font-display text-[19px] leading-none font-bold tracking-[-0.02em] text-bone uppercase">
          theworldiscollapsing
        </span>
      </Link>

      <nav className="flex items-stretch">
        {NAV.map(([href, label]) => {
          const active = href === "/" ? path === "/" : path.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              // Equal cells, and the active tab is marked by an amber rule along its foot rather
              // than by a filled box that breaks the bar's grid.
              className={`flex w-[104px] items-center justify-center border-r border-b-2 border-line font-mono text-[11px] tracking-[0.16em] uppercase hover:bg-panel2 ${
                active ? "border-b-amber text-bone" : "border-b-transparent text-dim"
              }`}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="ml-auto flex items-stretch">
        {gate ? (
          <span className="hidden items-center border-l border-line px-3 sm:flex">
            <span className="money text-[14px] text-bone">{gate.balanceText}</span>
            <span className="ml-1 font-mono text-[11px] tracking-[0.14em] text-dim uppercase">usdc</span>
          </span>
        ) : null}
        <Link
          href="/verify"
          className="flex items-center border-l border-line px-3 hover:bg-panel2"
          aria-label={gate?.verified ? "Verified" : "Unverified — verify to bet"}
        >
          {/* Unverified is a state to fix, not a fault: an amber outline pill, never a red light. */}
          <span
            className={`chip ${gate?.verified ? "border-line text-dim" : "border-amber text-amber"}`}
          >
            {gate?.verified ? "Verified" : "Unverified"}
          </span>
        </Link>
        {address ? (
          <button
            type="button"
            onClick={logout}
            title={address}
            className="num flex items-center border-l border-line px-3 text-[12px] text-dim hover:bg-panel2 hover:text-bone"
          >
            {address.slice(0, 6)}…{address.slice(-4)}
          </button>
        ) : (
          <button
            type="button"
            onClick={login}
            disabled={!ready}
            className="flex items-center border-l border-line px-3 font-mono text-[11px] tracking-[0.16em] text-amber uppercase hover:bg-amber hover:text-black disabled:opacity-40"
          >
            Sign in
          </button>
        )}
      </div>
    </header>
  );
}
