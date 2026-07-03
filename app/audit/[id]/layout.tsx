import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditReports } from "@/lib/db/schema";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;

  try {
    const [report] = await db
      .select({
        merchant_name: auditReports.merchant_name,
        overall_score: auditReports.overall_score,
        status: auditReports.status,
      })
      .from(auditReports)
      .where(eq(auditReports.id, id))
      .limit(1);

    if (!report) {
      return { title: "Audit Not Found — FlowBlinq" };
    }

    const score = report.overall_score ?? 0;
    const appUrl =
      process.env.NEXT_PUBLIC_APP_URL || "https://geo.flowblinq.com";

    return {
      title: `${report.merchant_name} — AI Visibility Score: ${score}%`,
      description: `See how visible ${report.merchant_name} is to ChatGPT, Claude, and Gemini shopping agents.`,
      openGraph: {
        title: `${report.merchant_name} — AI Visibility Score: ${score}%`,
        description: `See how visible ${report.merchant_name} is to ChatGPT, Claude, and Gemini shopping agents.`,
        url: `${appUrl}/audit/${id}`,
        images: [`${appUrl}/api/og/${id}`],
        type: "website",
        siteName: "FlowBlinq",
      },
      twitter: {
        card: "summary_large_image",
        title: `${report.merchant_name} — AI Visibility Score: ${score}%`,
        images: [`${appUrl}/api/og/${id}`],
      },
    };
  } catch {
    return { title: "AI Visibility Audit — FlowBlinq" };
  }
}

export default function AuditLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
