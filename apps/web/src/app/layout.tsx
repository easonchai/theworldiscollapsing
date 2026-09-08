import type { Metadata } from "next";
import { Antonio, Newsreader, Roboto_Mono } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "@/components/wallet";
import { StationBar } from "@/components/station-bar";
import { Heartbeat } from "@/components/heartbeat";

const display = Antonio({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-antonio" });
// The serif is italic-only on purpose: it dresses the one on-air line per page and nothing else.
const body = Newsreader({ subsets: ["latin"], style: ["italic"], weight: ["400"], variable: "--font-newsreader" });
// Roboto Mono, not DM Mono: an unslashed zero, so a 0 USDC balance reads as a number and not as
// the empty-set glyph.
const mono = Roboto_Mono({ subsets: ["latin"], weight: ["300", "400", "500", "700"], variable: "--font-roboto-mono" });

export const metadata: Metadata = {
  title: "theworldiscollapsing",
  description: "A world that keeps happening, broadcast on four channels, with a bet on every ending.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      {/* pb-[28px]: the chyron is fixed to the foot of the viewport on every page that has one. */}
      <body className="crt min-h-dvh bg-vac">
        <WalletProvider>
          <Heartbeat />
          <StationBar />
          <main className="pt-[46px] pb-[28px]">{children}</main>
        </WalletProvider>
      </body>
    </html>
  );
}
