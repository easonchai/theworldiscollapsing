import type { Metadata } from "next";
import { Archivo, Roboto_Mono } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "@/components/wallet";
import { StationBar } from "@/components/station-bar";
import { Heartbeat } from "@/components/heartbeat";

// Two faces, no third voice. Archivo is a grotesk with flat terminals and tabular figures, so the
// same face sets a headline and a countdown without either one wobbling.
// 400 carries prose, 600/700 carry headlines, money and the clock — one face, three weights.
const display = Archivo({ subsets: ["latin"], weight: ["400", "600", "700"], variable: "--font-archivo" });
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
      {/* pb-[46px]: the chyron is fixed to the foot of the viewport on every page that has one, so
          its 32px plus a 14px gutter is reserved here — copy ends above the crawl, never under it. */}
      <body className="min-h-dvh bg-vac">
        <WalletProvider>
          <Heartbeat />
          <StationBar />
          <main className="pt-[46px] pb-[46px]">{children}</main>
        </WalletProvider>
      </body>
    </html>
  );
}
