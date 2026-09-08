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
      <Link href="/" className="flex items-center gap-2 border-r border-line px-3 hover:bg-panel2">
        <span className="pulse size-[7px] bg-bone" aria-hidden />
        <span className="font-display text-[19px] leading-none tracking-[0.02em] text-bone">
          theworldis<span className="text-amber">collapsing</span>
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
              className={`flex items-center border-r border-line px-3 font-mono text-[11px] tracking-[0.16em] uppercase hover:bg-panel2 ${
                active ? "bg-panel2 text-amber" : "text-dim"
              }`}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="ml-auto flex items-stretch">
        {gate ? (
          <span className="hidden items-center border-l border-line px-3 num text-[12px] text-bone sm:flex">
            {gate.balanceText} <span className="ml-1 text-dim">USDC</span>
          </span>
        ) : null}
        <Link
          href="/verify"
          className={`flex items-center gap-2 border-l border-line px-3 font-mono text-[11px] tracking-[0.14em] uppercase hover:bg-panel2 ${
            gate?.verified ? "text-phos" : "text-dim"
          }`}
        >
          <span
            aria-hidden
            className={`size-[7px] rounded-full ${gate?.verified ? "bg-phos" : "bg-flare"}`}
          />
          {gate?.verified ? "Verified" : "Unverified"}
        </Link>
        {address ? (
          <button
            type="button"
            onClick={logout}
            title={address}
            className="flex items-center border-l border-line px-3 num text-[12px] text-dim hover:bg-panel2 hover:text-bone"
          >
            {address.slice(0, 6)}…{address.slice(-4)}
          </button>
        ) : (
          <button
            type="button"
            onClick={login}
            disabled={!ready}
            className="flex items-center border-l border-line px-3 font-mono text-[11px] tracking-[0.16em] uppercase text-amber hover:bg-amber hover:text-black disabled:opacity-40"
          >
            Sign in
          </button>
        )}
      </div>
    </header>
  );
}
