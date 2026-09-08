import type { Metadata } from "next";
import { Archivo, Roboto_Mono } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "@/components/wallet";
import { StationBar } from "@/components/station-bar";
import { Heartbeat } from "@/components/heartbeat";

// Two faces, no third voice. Archivo is a grotesk with flat terminals and tabular figures, so the
// same face sets a headline and a countdown without either one wobbling. Loaded as the variable
// font with its width axis (wdth 62–125, per next's own google font data) so headlines and clocks
// can run condensed at 78% — a broadcast caps headline fits on one line instead of orphaning a word.
const display = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-archivo" });
// Roboto Mono, not DM Mono: an unslashed zero, so a 0 USDC balance reads as a number and not as
// the empty-set glyph.
const mono = Roboto_Mono({ subsets: ["latin"], weight: ["300", "400", "500", "700"], variable: "--font-roboto-mono" });

export const metadata: Metadata = {
  title: "theworldiscollapsing",
  description: "A world that keeps happening, broadcast on four channels, with a bet on every ending.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      {/* pb-[32px]: exactly the height of the chyron fixed to the foot of the viewport, so a page
          runs right down to the crawl and meets it on one hairline — no black box under a black box. */}
      <body className="min-h-dvh bg-vac">
        <WalletProvider>
          <Heartbeat />
          <StationBar />
          <main className="pt-[46px] pb-[32px]">{children}</main>
        </WalletProvider>
      </body>
    </html>
  );
}
