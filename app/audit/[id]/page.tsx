"use client";

import { useState, useEffect, useCallback, use } from "react";
import { useIsEmbedded } from "@/lib/use-embedded";
import { Card } from "@/components/ui/card";
import { ScoreGauge } from "@/components/score-gauge";
import { BenchmarkChart } from "@/components/benchmark-chart";
import { RevenueCalculator } from "@/components/revenue-calculator";
import { SovResults } from "@/components/sov-results";
import { ShareBar } from "@/components/share-bar";
import { CtaBlock } from "@/components/cta-block";
import {
  PhaseAnimation,
  type PhaseConfig,
  type PhaseStatus,
} from "@/components/phase-animation";
import { XCircle, AlertTriangle, Info } from "lucide-react";

interface PhaseData {
  intelligence: Record<string, unknown> | null;
  sov: Record<string, unknown> | null;
  compiled: Record<string, unknown> | null;
}

export default function AuditReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const isEmbedded = useIsEmbedded();
  const [status, setStatus] = useState<string>("loading");
  const [phaseData, setPhaseData] = useState<PhaseData>({
    intelligence: null,
    sov: null,
    compiled: null,
  });
  const [report, setReport] = useState<Record<string, unknown> | null>(null);
  const [phaseStatuses, setPhaseStatuses] = useState<
    Record<string, PhaseStatus>
  >({
    intelligence: "waiting",
    sov: "waiting",
  });
  const [merchantInfo, setMerchantInfo] = useState({
    name: "",
    url: "",
    category: "",
    revenue: "",
  });
  const [sovProgress, setSovProgress] = useState<{
    current: number;
    total: number;
    currentQuery: string;
  } | null>(null);

  // Load initial state
  useEffect(() => {
    async function loadReport() {
      try {
        const res = await fetch(`/api/audit/${id}`);
        const data = await res.json();

        if (data.status === "complete") {
          setReport(data);
          setStatus("complete");
          setMerchantInfo({
            name: data.merchant_name || "",
            url: data.merchant_url || "",
            category: data.product_category || "",
            revenue: "",
          });
          return;
        }

        if (data.status === "pending_verification") {
          setStatus("not_verified");
          return;
        }

        // Verified or partially complete — need to run phases
        setMerchantInfo({
          name: data.merchant_name || "",
          url: data.merchant_url || "",
          category: data.product_category || "",
          revenue: "",
        });
        setStatus("processing");
      } catch {
        setStatus("error");
      }
    }
    loadReport();
  }, [id]);

  // Run processing phases
  const runPhases = useCallback(async () => {
    if (status !== "processing") return;

    // Phase 1: Intelligence (Perplexity)
    setPhaseStatuses((p) => ({ ...p, intelligence: "running" }));

    let intel = null;
    try {
      const intelRes = await fetch(`/api/audit/${id}/intelligence`, {
        method: "POST",
      });
      const intelData = await intelRes.json();
      if (!intelData.error) intel = intelData;
    } catch {
      // Intelligence failed
    }

    setPhaseData((p) => ({ ...p, intelligence: intel }));
    setPhaseStatuses((p) => ({
      ...p,
      intelligence: intel ? "done" : "error",
    }));

    // Phase 2: SoV (per-query with progress)
    setPhaseStatuses((p) => ({ ...p, sov: "running" }));
    let sov = null;
    try {
      const queries =
        intel?.queries?.map((q: { query: string }) => q.query) || [];
      const brandName = intel?.merchant?.brandName || merchantInfo.name;
      const competitors =
        intel?.competitors?.map((c: { brandName: string }) => c.brandName) ||
        [];
      const primaryMarket = intel?.merchant?.primaryMarkets?.[0] || null;

      if (queries.length > 0) {
        const cappedQueries = queries.slice(0, 8);
        const queryResults: Array<{
          query: string;
          platforms: Array<Record<string, unknown>>;
        }> = [];

        // Run queries one-by-one for real progress
        for (let i = 0; i < cappedQueries.length; i++) {
          setSovProgress({
            current: i,
            total: cappedQueries.length,
            currentQuery: cappedQueries[i],
          });

          try {
            const res = await fetch(`/api/audit/${id}/sov-query`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                query: cappedQueries[i],
                queryIndex: i,
                brandName,
                competitorNames: competitors,
                primaryMarket,
              }),
            });
            const result = await res.json();
            if (!result.error) {
              queryResults.push(result);
            }
          } catch {
            // Individual query failed, continue with others
          }

          setSovProgress({
            current: i + 1,
            total: cappedQueries.length,
            currentQuery: i + 1 < cappedQueries.length ? cappedQueries[i + 1] : "",
          });
        }

        // Finalize: compute summary + save to DB
        if (queryResults.length > 0) {
          const completeRes = await fetch(`/api/audit/${id}/sov-complete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              results: queryResults,
              brandName,
              competitorNames: competitors,
            }),
          });
          sov = await completeRes.json();
          if (sov.error) sov = null;
        }
      }
    } catch {
      // SoV failed
    }
    setSovProgress(null);
    setPhaseData((p) => ({ ...p, sov }));
    setPhaseStatuses((p) => ({ ...p, sov: sov ? "done" : "error" }));

    // Reload full report
    try {
      const finalRes = await fetch(`/api/audit/${id}`);
      const finalData = await finalRes.json();
      setReport(finalData);
      setStatus("complete");
    } catch {
      setStatus("complete");
    }
  }, [id, status, merchantInfo.name]);

  useEffect(() => {
    if (status === "processing") {
      runPhases();
    }
  }, [status, runPhases]);

  // Build phase animation config
  function buildPhaseLines(): PhaseConfig[] {
    const intel = phaseData.intelligence as Record<string, unknown> | null;
    const intelMerchant = intel?.merchant as Record<string, unknown> | null;
    const intelQueries = (intel?.queries as Array<{ query: string }>) || [];
    const intelCrawl = intel?.crawlSummary as Record<string, unknown> | null;

    return [
      {
        id: "intelligence",
        label: "ANALYZING YOUR BUSINESS",
        status: phaseStatuses.intelligence,
        lines: intel
          ? [
              `Browsing ${merchantInfo.url} with AI...`,
              `Identified ${(intelCrawl?.categories as string[])?.length || "?"} product categories`,
              `Primary vertical: ${intelMerchant?.vertical || "analyzing..."}`,
              `Price range: ${intelCrawl?.priceRange || "—"}`,
              `Target customer: ${intelMerchant?.targetCustomer || "—"}`,
              "",
              "GENERATING CUSTOMER QUERIES",
              ...intelQueries
                .slice(0, 4)
                .map((q) => `"${q.query}"`),
              `...and ${Math.max(0, intelQueries.length - 4)} more queries`,
            ]
          : [`Browsing ${merchantInfo.url} with AI...`],
      },
      {
        id: "sov",
        label: "AI SHARE OF VOICE",
        status: phaseStatuses.sov,
        progress: sovProgress
          ? {
              current: sovProgress.current,
              total: sovProgress.total,
              currentQuery: sovProgress.currentQuery,
            }
          : undefined,
        lines: phaseData.sov
          ? [
              `Queried ${(phaseData.sov as Record<string, unknown>)?.summary ? ((phaseData.sov as Record<string, unknown>).summary as Record<string, unknown>)?.queriesRun : "?"} queries across ${((phaseData.sov as Record<string, unknown>).summary as Record<string, unknown>)?.platformsQueried ? ((((phaseData.sov as Record<string, unknown>).summary as Record<string, unknown>).platformsQueried) as string[]).length : "?"} platforms`,
              `Your Share of Voice: ${((phaseData.sov as Record<string, unknown>).summary as Record<string, unknown>)?.brandSov || 0}%`,
            ]
          : ["Testing purchase queries across ChatGPT, Claude, Gemini, Perplexity..."],
      },
    ];
  }

  // --- RENDER ---

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (status === "not_verified") {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="text-center space-y-4">
          <h1 className="text-xl font-semibold text-foreground">
            Email verification required
          </h1>
          <p className="text-sm text-muted-foreground">
            Please verify your email to view this audit.
          </p>
        </div>
      </div>
    );
  }

  if (status === "processing") {
    return (
      <div className={`${isEmbedded ? "" : "min-h-screen"} flex flex-col`}>
        {!isEmbedded && (
          <header className="border-b border-border py-4 px-6">
            <div className="max-w-3xl mx-auto">
              <div className="flex items-center gap-2">
                <img src="/logo.jpg" alt="" className="h-8 w-8 rounded-full" />
                <span
                  className="text-xl font-bold text-orange-500"
                  style={{ fontFamily: "'Instrument Serif', Georgia, serif" }}
                >
                  FlowBlinq
                </span>
              </div>
            </div>
          </header>
        )}
        <main className={`flex-1 flex items-center justify-center ${isEmbedded ? "p-2" : "p-6"}`}>
          <div className="max-w-2xl w-full space-y-6">
            <div className="text-center space-y-2">
              <h1
                className="text-2xl font-bold text-foreground"
                style={{ fontFamily: "'Instrument Serif', Georgia, serif" }}
              >
                Analyzing {merchantInfo.name || merchantInfo.url}
              </h1>
              <p className="text-sm text-muted-foreground">
                We&apos;re asking AI shopping assistants about your products. This takes about 60-90 seconds.
              </p>
            </div>
            <PhaseAnimation phases={buildPhaseLines()} />
          </div>
        </main>
      </div>
    );
  }

  // --- RESULTS PAGE ---
  if (!report) return null;

  const r = report;
  const overallScore = (r.overall_score as number) || 0;
  const merchantName = (r.merchant_name as string) || "";
  const merchantUrl = (r.merchant_url as string) || "";
  const verdict = (r.verdict as string) || "";
  const intelligence = r.intelligence as Record<string, unknown> | null;
  const sovData = r.sov as Record<string, unknown> | null;
  const revenueOpp = r.revenue_opportunity as Record<string, unknown> | null;
  const benchmark = r.benchmark as Record<string, unknown> | null;
  const narrative = (r.narrative as Array<{ type: string; text: string }>) || [];

  return (
    <div className={isEmbedded ? "" : "min-h-screen"}>
      {/* Header */}
      {!isEmbedded && (
        <header className="border-b border-border py-4 px-6">
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-2">
              <img src="/logo.jpg" alt="" className="h-8 w-8 rounded-full" />
              <span
                className="text-xl font-bold text-orange-500"
                style={{ fontFamily: "'Instrument Serif', Georgia, serif" }}
              >
                FlowBlinq
              </span>
            </div>
            <ShareBar
              storeName={merchantName}
              score={overallScore}
              auditId={id}
            />
          </div>
        </header>
      )}

      <main className="max-w-4xl mx-auto px-6 py-10 space-y-8">
        {/* 1. Score + Verdict */}
        <section className="text-center space-y-4">
          <h1
            className="text-3xl font-bold text-foreground"
            style={{ fontFamily: "'Instrument Serif', Georgia, serif" }}
          >
            Your AI Visibility Report
          </h1>
          <p className="text-muted-foreground">
            {merchantName} — {merchantUrl}
          </p>
          <ScoreGauge score={overallScore} size={200} />
          <p className="text-lg text-muted-foreground max-w-md mx-auto">
            {verdict}
          </p>
        </section>

        {/* 2. What We Found — narrative summary */}
        {narrative.length > 0 && (
          <Card className="p-6">
            <h2
              className="text-xl font-bold text-foreground mb-4"
              style={{ fontFamily: "'Instrument Serif', Georgia, serif" }}
            >
              What We Found
            </h2>
            <div className="space-y-3">
              {narrative.map((item, i) => {
                const Icon =
                  item.type === "critical"
                    ? XCircle
                    : item.type === "warning"
                      ? AlertTriangle
                      : Info;
                const iconColor =
                  item.type === "critical"
                    ? "text-red-400"
                    : item.type === "warning"
                      ? "text-yellow-400"
                      : "text-blue-400";
                return (
                  <div key={i} className="flex gap-3">
                    <Icon
                      className={`w-5 h-5 ${iconColor} shrink-0 mt-0.5`}
                    />
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {item.text}
                    </p>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        {/* 3. AI Share of Voice */}
        {!!sovData && (
          <Card className="p-6">
            <h2
              className="text-xl font-bold text-foreground mb-4"
              style={{ fontFamily: "'Instrument Serif', Georgia, serif" }}
            >
              AI Share of Voice
            </h2>
            <SovResults
              results={
                (sovData.results as Array<{
                  query: string;
                  platforms: Array<{
                    platform: string;
                    targetBrandMentioned: boolean;
                    targetBrandPosition: number | null;
                    mentions: Array<{
                      brand: string;
                      mentioned: boolean;
                      position: number | null;
                      context: string;
                    }>;
                    fullResponse: string;
                    error?: string;
                  }>;
                }>) || []
              }
              brandName={
                (intelligence?.merchant as Record<string, unknown>)
                  ?.brandName as string || merchantName
              }
              brandSov={(sovData.brandSov as number) || 0}
              topCompetitorName={
                (sovData.topCompetitorName as string) || ""
              }
              topCompetitorSov={(sovData.topCompetitorSov as number) || 0}
            />
          </Card>
        )}

        {/* 4. Revenue at Risk */}
        {!!revenueOpp && (
          <Card className="p-6">
            <h2
              className="text-xl font-bold text-foreground mb-4"
              style={{ fontFamily: "'Instrument Serif', Georgia, serif" }}
            >
              Estimated Revenue at Risk
            </h2>
            <RevenueCalculator
              low={(revenueOpp.low as number) || 0}
              high={(revenueOpp.high as number) || 0}
              gapPercent={(revenueOpp.gap_percent as number) || 0}
              methodology={(revenueOpp.methodology as string) || ""}
              initialScore={overallScore}
            />
          </Card>
        )}

        {/* 5. Benchmark */}
        {!!benchmark && (
          <Card className="p-6">
            <h2
              className="text-xl font-bold text-foreground mb-4"
              style={{ fontFamily: "'Instrument Serif', Georgia, serif" }}
            >
              Industry Benchmark
            </h2>
            <BenchmarkChart
              yourScore={overallScore}
              industryAverage={(benchmark.industry_average as number) || 30}
              topPerformer={(benchmark.top_performer as number) || 65}
              category={(benchmark.category as string) || "General"}
            />
            <p className="text-sm text-muted-foreground mt-4">
              {benchmark.comparison as string}
            </p>
          </Card>
        )}

        {/* Commerce Readiness Report CTA */}
        <Card className="p-6 border-orange-500/30 bg-orange-500/5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2
                className="text-xl font-bold text-foreground mb-1"
                style={{ fontFamily: "'Instrument Serif', Georgia, serif" }}
              >
                Go Deeper: AI Commerce Readiness Report
              </h2>
              <p className="text-sm text-muted-foreground">
                See how AI shopping agents read your catalog, product-by-product. Includes agent simulations, enrichment preview, and revenue impact model.
              </p>
            </div>
            <a
              href={`/audit/${id}/report`}
              className="shrink-0 inline-flex items-center gap-2 bg-orange-500 text-white font-semibold text-sm px-5 py-2.5 rounded-md hover:bg-orange-600 transition-colors"
            >
              View Report →
            </a>
          </div>
        </Card>

        {/* 6. CTA */}
        <CtaBlock platformDetected={null} />

        {/* 7. Share bar (bottom) */}
        <div className="flex items-center justify-between flex-wrap gap-4 py-4">
          <ShareBar
            storeName={merchantName}
            score={overallScore}
            auditId={id}
          />
          <a
            href="/"
            className="text-sm text-orange-500 hover:underline"
          >
            Run another audit
          </a>
        </div>
      </main>

      {/* Footer */}
      {!isEmbedded && (
        <footer className="border-t border-border py-6 px-6 text-xs text-muted-foreground">
          <div className="flex items-center justify-center gap-2">
            <img src="/logo.jpg" alt="" className="h-5 w-5 rounded-full" />
            <span>
              Powered by{" "}
              <a
                href={process.env.NEXT_PUBLIC_WEBSITE_URL || "https://flowblinq.com"}
                className="text-orange-500 hover:underline"
              >
                FlowBlinq
              </a>{" "}
              — AI Commerce Enablement
            </span>
          </div>
        </footer>
      )}
    </div>
  );
}
