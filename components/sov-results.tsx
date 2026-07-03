"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { ChevronDown, ChevronUp } from "lucide-react";

interface Mention {
  brand: string;
  mentioned: boolean;
  position: number | null;
  context: string;
}

interface PlatformResult {
  platform: string;
  targetBrandMentioned: boolean;
  targetBrandPosition: number | null;
  mentions: Mention[];
  fullResponse: string;
  error?: string;
}

interface QueryResult {
  query: string;
  platforms: PlatformResult[];
}

interface SovResultsProps {
  results: QueryResult[];
  brandName: string;
  brandSov: number;
  topCompetitorName: string;
  topCompetitorSov: number;
}

interface PlatformStats {
  platform: string;
  total: number;
  mentioned: number;
  pct: number;
}

interface CompetitorStats {
  name: string;
  mentions: number;
  pct: number;
  platforms: string[];
}

function computePlatformStats(
  results: QueryResult[],
  brandName: string
): PlatformStats[] {
  const stats: Record<string, { total: number; mentioned: number }> = {};
  for (const r of results) {
    for (const p of r.platforms) {
      if (!stats[p.platform]) stats[p.platform] = { total: 0, mentioned: 0 };
      stats[p.platform].total++;
      if (p.targetBrandMentioned) stats[p.platform].mentioned++;
    }
  }
  return Object.entries(stats)
    .map(([platform, { total, mentioned }]) => ({
      platform,
      total,
      mentioned,
      pct: total > 0 ? Math.round((mentioned / total) * 100) : 0,
    }))
    .sort((a, b) => b.pct - a.pct);
}

function computeCompetitorStats(
  results: QueryResult[],
  brandName: string
): CompetitorStats[] {
  const totalSlots = results.reduce((sum, r) => sum + r.platforms.length, 0);
  const stats: Record<string, { mentions: number; platforms: Set<string> }> = {};

  for (const r of results) {
    for (const p of r.platforms) {
      for (const m of p.mentions) {
        if (m.brand.toLowerCase() === brandName.toLowerCase()) continue;
        if (!m.mentioned) continue;
        if (!stats[m.brand]) stats[m.brand] = { mentions: 0, platforms: new Set() };
        stats[m.brand].mentions++;
        stats[m.brand].platforms.add(p.platform);
      }
    }
  }

  return Object.entries(stats)
    .map(([name, { mentions, platforms }]) => ({
      name,
      mentions,
      pct: totalSlots > 0 ? Math.round((mentions / totalSlots) * 100) : 0,
      platforms: Array.from(platforms),
    }))
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 5);
}

const PLATFORM_COLORS: Record<string, string> = {
  ChatGPT: "bg-green-500",
  Claude: "bg-orange-400",
  Gemini: "bg-blue-500",
  Perplexity: "bg-purple-500",
};

const PLATFORM_TEXT_COLORS: Record<string, string> = {
  ChatGPT: "text-green-400",
  Claude: "text-orange-400",
  Gemini: "text-blue-400",
  Perplexity: "text-purple-400",
};

function MentionBadge({
  mentioned,
  position,
  brand,
  isTarget,
}: {
  mentioned: boolean;
  position: number | null;
  brand: string;
  isTarget: boolean;
}) {
  if (!mentioned) {
    return (
      <span className="text-xs px-2 py-1 rounded bg-red-500/10 text-red-400">
        {brand}: Not mentioned
      </span>
    );
  }
  return (
    <span
      className={`text-xs px-2 py-1 rounded ${
        isTarget
          ? "bg-orange-500/20 text-orange-400 font-semibold"
          : "bg-muted text-muted-foreground"
      }`}
    >
      {brand} #{position || "—"}
    </span>
  );
}

function QueryCard({
  result,
  brandName,
}: {
  result: QueryResult;
  brandName: string;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card className="p-4 space-y-3">
      <p className="text-sm font-medium text-foreground italic">
        &ldquo;{result.query}&rdquo;
      </p>
      <div className="space-y-2">
        {result.platforms.map((p) => (
          <div key={p.platform} className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold text-muted-foreground w-20">
                {p.platform}
              </span>
              {p.error ? (
                <span className="text-xs text-muted-foreground/50">
                  Unavailable
                </span>
              ) : (
                p.mentions.map((m) => (
                  <MentionBadge
                    key={m.brand}
                    mentioned={m.mentioned}
                    position={m.position}
                    brand={m.brand}
                    isTarget={
                      m.brand.toLowerCase() === brandName.toLowerCase()
                    }
                  />
                ))
              )}
            </div>
          </div>
        ))}
      </div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
      >
        {expanded ? (
          <>
            Hide responses <ChevronUp className="w-3 h-3" />
          </>
        ) : (
          <>
            Show AI responses <ChevronDown className="w-3 h-3" />
          </>
        )}
      </button>
      {expanded && (
        <div className="space-y-2 mt-2">
          {result.platforms
            .filter((p) => p.fullResponse)
            .map((p) => (
              <div
                key={p.platform}
                className="bg-background rounded-lg p-3 text-xs text-muted-foreground leading-relaxed"
              >
                <span className="font-semibold text-foreground">
                  {p.platform}:
                </span>
                <p className="mt-1 whitespace-pre-wrap">
                  {p.fullResponse}
                </p>
              </div>
            ))}
        </div>
      )}
    </Card>
  );
}

export function SovResults({
  results,
  brandName,
  brandSov,
  topCompetitorName,
  topCompetitorSov,
}: SovResultsProps) {
  const platformStats = computePlatformStats(results, brandName);
  const competitorStats = computeCompetitorStats(results, brandName);

  return (
    <div className="space-y-6">
      {/* Overall SoV */}
      <div className="flex gap-6 flex-wrap">
        <div>
          <p className="text-sm text-muted-foreground">Your Share of Voice</p>
          <p className="text-3xl font-bold text-orange-500">{brandSov}%</p>
        </div>
        {topCompetitorName && (
          <div>
            <p className="text-sm text-muted-foreground">
              Top Competitor ({topCompetitorName})
            </p>
            <p className="text-3xl font-bold text-muted-foreground">
              {topCompetitorSov}%
            </p>
          </div>
        )}
      </div>

      {/* Per-platform breakdown */}
      {platformStats.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm font-semibold text-foreground">
            Your visibility by platform
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {platformStats.map((ps) => (
              <div
                key={ps.platform}
                className="rounded-lg border border-border p-3 text-center"
              >
                <p className={`text-xs font-semibold ${PLATFORM_TEXT_COLORS[ps.platform] || "text-muted-foreground"}`}>
                  {ps.platform}
                </p>
                <p className="text-2xl font-bold text-foreground mt-1">
                  {ps.pct}%
                </p>
                <div className="w-full bg-muted rounded-full h-1.5 mt-2">
                  <div
                    className={`h-1.5 rounded-full ${PLATFORM_COLORS[ps.platform] || "bg-orange-500"}`}
                    style={{ width: `${Math.max(ps.pct, 2)}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {ps.mentioned}/{ps.total} queries
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Competitor FOMO */}
      {competitorStats.length > 0 && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 space-y-3">
          <p className="text-sm font-semibold text-foreground">
            Who AI recommends instead of you
          </p>
          <div className="space-y-2">
            {competitorStats.map((cs) => (
              <div key={cs.name} className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-foreground truncate">
                      {cs.name}
                    </span>
                    <span className="text-sm font-bold text-red-400 ml-2 shrink-0">
                      {cs.pct}%
                    </span>
                  </div>
                  <div className="w-full bg-muted rounded-full h-1.5 mt-1">
                    <div
                      className="h-1.5 rounded-full bg-red-400"
                      style={{ width: `${Math.max(cs.pct, 2)}%` }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Recommended on {cs.platforms.join(", ")}
                  </p>
                </div>
              </div>
            ))}
          </div>
          {brandSov < 20 && (
            <p className="text-xs text-red-400/80 pt-1">
              These competitors are capturing the AI shopping traffic that should be going to your store.
            </p>
          )}
        </div>
      )}

      {brandSov === 0 && competitorStats.length === 0 && (
        <p className="text-sm text-red-400 bg-red-500/10 rounded-lg p-3">
          AI agents have no specific product data for your store. Your
          competitors&apos; products are being recommended instead.
        </p>
      )}

      {/* Per-query details */}
      <div className="space-y-3">
        <p className="text-sm font-semibold text-foreground">
          Query-by-query results
        </p>
        {results.map((r, i) => (
          <QueryCard key={i} result={r} brandName={brandName} />
        ))}
      </div>
    </div>
  );
}
