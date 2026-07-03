import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AI Commerce Readiness Report | FlowBlinq",
  description:
    "Deep-dive analysis of your catalog's readiness for AI-powered commerce. See how AI shopping agents see your products today.",
  openGraph: {
    title: "AI Commerce Readiness Report | FlowBlinq",
    description:
      "Your catalog analyzed for AI commerce readiness — schema.org coverage, attribute density, agent simulations, and revenue impact.",
    type: "website",
  },
};

export default function CommerceReportLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
