import type { Metadata } from "next";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "FlowBlinq Citations — Track Your Brand Across AI",
  description:
    "See when ChatGPT, Perplexity, and Gemini cite your brand. Run your own prompts on a schedule and measure your AI visibility over time.",
  icons: { icon: "/icon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Toaster theme="light" position="bottom-right" />
      </body>
    </html>
  );
}
