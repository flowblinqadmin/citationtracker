import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";
import GeoHeader from "./GeoHeader";

// Inter — matches geo's dashboard header font 1:1. Exposed as a CSS variable so
// GeoHeader's FONT_STACK (var(--font-inter)) resolves to it.
const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "FlowBlinq Citations — Track Your Brand Across AI",
  description:
    "See when ChatGPT, Perplexity, and Gemini cite your brand. Run your own prompts on a schedule and measure your AI visibility over time.",
  icons: { icon: "/icon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <GeoHeader />
        {children}
        <Toaster theme="light" position="bottom-right" />
      </body>
    </html>
  );
}
