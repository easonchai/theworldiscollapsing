import type { Metadata } from "next";
import { Antonio, DM_Mono, Newsreader } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "@/components/wallet";
import { StationBar } from "@/components/station-bar";
import { Heartbeat } from "@/components/heartbeat";

const display = Antonio({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-antonio" });
const body = Newsreader({ subsets: ["latin"], style: ["normal", "italic"], variable: "--font-newsreader" });
const mono = DM_Mono({ subsets: ["latin"], weight: ["300", "400", "500"], variable: "--font-dm-mono" });

export const metadata: Metadata = {
  title: "theworldiscollapsing",
  description: "A world that keeps happening, broadcast on four channels, with a bet on every ending.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body className="crt min-h-dvh bg-vac">
        <WalletProvider>
          <Heartbeat />
          <StationBar />
          <main className="pt-[46px]">{children}</main>
        </WalletProvider>
      </body>
    </html>
  );
}
