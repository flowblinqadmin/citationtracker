import type { Metadata } from "next";
import { Toaster } from "sonner";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FlowBlinq GEO — Make Your Website Visible to AI",
  description:
    "AI agents like ChatGPT, Perplexity, and Gemini are changing how people find businesses. Get your GEO scorecard, llms.txt, UCP manifest, and Schema.org blocks in minutes.",
  metadataBase: new URL("https://geo.flowblinq.com"),
  icons: {
    icon: "/icon.svg",
    apple: "/apple-icon.png",
  },
  openGraph: {
    title: "FlowBlinq GEO — AI Discoverability for Your Website",
    description: "Only 12.4% of websites have schema.org markup. The other 87.6% are invisible to AI.",
    url: "https://geo.flowblinq.com",
    siteName: "FlowBlinq GEO",
    type: "website",
    images: [{ url: "/logo.png", width: 611, height: 611, alt: "FlowBlinq" }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // HP-226 + HP-238 fix 1: nonce is stamped by middleware.ts on the
  // `x-csp-nonce` REQUEST header and is available to any <Script> /
  // <script> that reads it via `(await headers()).get("x-csp-nonce")`.
  // The repo currently renders zero Script components — there's nothing
  // here to stamp. `<body nonce={...}>` was misleading: nonce does not
  // propagate from body to child scripts per HTML spec, so setting it at
  // the body level was cosmetic at best. Removed to avoid suggesting a
  // propagation contract that doesn't exist.
  return (
    <html lang="en">
      <body>
        {children}
        <Toaster theme="dark" position="bottom-right" />
        <Analytics />
      </body>
    </html>
  );
}
