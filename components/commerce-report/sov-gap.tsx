"use client";

import type { SovGapData, SovGapQuery } from "@/lib/types/commerce-report";

function SectionHeader({ number, title }: { number: string; title: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        marginBottom: "32px",
        paddingBottom: "16px",
        borderBottom: "1px solid var(--cr-border)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--cr-font-mono)",
          fontSize: "12px",
          color: "var(--cr-accent-red)",
          background: "rgba(239, 68, 68, 0.15)",
          padding: "4px 10px",
          borderRadius: "4px",
          fontWeight: 600,
        }}
      >
        {number}
      </span>
      <h2
        style={{
          fontFamily: "var(--cr-font-serif)",
          fontSize: "28px",
          fontWeight: 400,
          color: "var(--cr-text-primary)",
        }}
      >
        {title}
      </h2>
    </div>
  );
}

function PlatformBadge({
  platform,
  mentioned,
  topCompetitor,
}: {
  platform: string;
  mentioned: boolean;
  topCompetitor: string | null;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "10px 16px",
        borderRadius: "6px",
        background: mentioned
          ? "rgba(34, 197, 94, 0.1)"
          : "rgba(239, 68, 68, 0.08)",
        border: `1px solid ${mentioned ? "rgba(34, 197, 94, 0.2)" : "rgba(239, 68, 68, 0.15)"}`,
      }}
    >
      <span
        style={{
          fontFamily: "var(--cr-font-mono)",
          fontSize: "12px",
          fontWeight: 600,
          color: "var(--cr-text-primary)",
          minWidth: "80px",
        }}
      >
        {platform}
      </span>
      <span
        style={{
          fontFamily: "var(--cr-font-mono)",
          fontSize: "11px",
          fontWeight: 700,
          color: mentioned ? "var(--cr-accent-green)" : "var(--cr-accent-red)",
        }}
      >
        {mentioned ? "MENTIONED" : "NOT MENTIONED"}
      </span>
      {!mentioned && topCompetitor && (
        <span
          style={{
            fontFamily: "var(--cr-font-mono)",
            fontSize: "11px",
            color: "var(--cr-accent-yellow)",
            marginLeft: "auto",
          }}
        >
          Recommended: {topCompetitor}
        </span>
      )}
    </div>
  );
}

function QueryCard({ item, brandName }: { item: SovGapQuery; brandName: string }) {
  const mentionedCount = item.platforms.filter((p) => p.mentioned).length;
  const totalPlatforms = item.platforms.length;

  return (
    <div
      style={{
        background: "var(--cr-bg-card)",
        border: "1px solid var(--cr-border)",
        borderRadius: "8px",
        overflow: "hidden",
        marginBottom: "20px",
      }}
    >
      {/* Chat-style query */}
      <div
        style={{
          padding: "20px 24px",
          borderBottom: "1px solid var(--cr-border)",
        }}
      >
        <div
          style={{
            fontFamily: "var(--cr-font-mono)",
            fontSize: "10px",
            letterSpacing: "1.5px",
            textTransform: "uppercase",
            color: "var(--cr-text-muted)",
            marginBottom: "8px",
          }}
        >
          Customer asks AI
        </div>
        <div
          style={{
            fontSize: "16px",
            color: "var(--cr-text-primary)",
            fontStyle: "italic",
            lineHeight: 1.5,
          }}
        >
          &ldquo;{item.query}&rdquo;
        </div>
      </div>

      {/* Platform results */}
      <div style={{ padding: "20px 24px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "12px",
          }}
        >
          <span
            style={{
              fontFamily: "var(--cr-font-mono)",
              fontSize: "10px",
              letterSpacing: "1.5px",
              textTransform: "uppercase",
              color: item.brandMentioned
                ? "var(--cr-accent-green)"
                : "var(--cr-accent-red)",
            }}
          >
            {brandName} mentioned on {mentionedCount}/{totalPlatforms} platforms
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {item.platforms.map((p, i) => (
            <PlatformBadge
              key={i}
              platform={p.platform}
              mentioned={p.mentioned}
              topCompetitor={p.topCompetitor}
            />
          ))}
        </div>

        {/* Snippet from most damning platform */}
        {item.platforms
          .filter((p) => !p.mentioned && p.snippet)
          .slice(0, 1)
          .map((p, i) => (
            <div
              key={i}
              style={{
                marginTop: "16px",
                padding: "14px 18px",
                background: "rgba(0,0,0,0.3)",
                borderRadius: "6px",
                borderLeft: "3px solid var(--cr-accent-red)",
              }}
            >
              <div
                style={{
                  fontFamily: "var(--cr-font-mono)",
                  fontSize: "10px",
                  color: "var(--cr-text-muted)",
                  marginBottom: "6px",
                }}
              >
                {p.platform} responded:
              </div>
              <div
                style={{
                  fontSize: "13px",
                  color: "var(--cr-text-secondary)",
                  fontStyle: "italic",
                  lineHeight: 1.6,
                }}
              >
                &ldquo;{p.snippet.length > 200
                  ? p.snippet.slice(0, 200) + "..."
                  : p.snippet}&rdquo;
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

export function SovGapSection({
  data,
  brandName,
}: {
  data: SovGapData;
  brandName: string;
}) {
  return (
    <section style={{ marginBottom: "64px" }}>
      <SectionHeader
        number="02"
        title="The Visibility Gap: What AI Agents Actually Say"
      />

      {/* Summary stat bar */}
      <div
        className="cr-grid-3"
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: "16px",
          marginBottom: "32px",
        }}
      >
        <div
          style={{
            background: "rgba(239, 68, 68, 0.1)",
            border: "1px solid rgba(239, 68, 68, 0.2)",
            borderRadius: "8px",
            padding: "20px",
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontFamily: "var(--cr-font-mono)",
              fontSize: "36px",
              fontWeight: 700,
              color: "var(--cr-accent-red)",
            }}
          >
            {data.brandSov}%
          </div>
          <div
            style={{
              fontFamily: "var(--cr-font-mono)",
              fontSize: "11px",
              color: "var(--cr-text-muted)",
              letterSpacing: "1px",
              textTransform: "uppercase",
            }}
          >
            Your Share of Voice
          </div>
        </div>

        <div
          style={{
            background: "rgba(234, 179, 8, 0.1)",
            border: "1px solid rgba(234, 179, 8, 0.2)",
            borderRadius: "8px",
            padding: "20px",
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontFamily: "var(--cr-font-mono)",
              fontSize: "36px",
              fontWeight: 700,
              color: "var(--cr-accent-yellow)",
            }}
          >
            {data.topCompetitorSov}%
          </div>
          <div
            style={{
              fontFamily: "var(--cr-font-mono)",
              fontSize: "11px",
              color: "var(--cr-text-muted)",
              letterSpacing: "1px",
              textTransform: "uppercase",
            }}
          >
            {data.topCompetitorName} SoV
          </div>
        </div>

        <div
          style={{
            background: "rgba(249, 115, 22, 0.1)",
            border: "1px solid rgba(249, 115, 22, 0.2)",
            borderRadius: "8px",
            padding: "20px",
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontFamily: "var(--cr-font-mono)",
              fontSize: "36px",
              fontWeight: 700,
              color: "var(--cr-accent-orange)",
            }}
          >
            {data.queries.length}
          </div>
          <div
            style={{
              fontFamily: "var(--cr-font-mono)",
              fontSize: "11px",
              color: "var(--cr-text-muted)",
              letterSpacing: "1px",
              textTransform: "uppercase",
            }}
          >
            Queries Tested
          </div>
        </div>
      </div>

      {/* Insight callout */}
      <div
        style={{
          background: "rgba(239, 68, 68, 0.06)",
          border: "1px solid rgba(239, 68, 68, 0.15)",
          borderRadius: "8px",
          padding: "20px 24px",
          marginBottom: "32px",
        }}
      >
        <div
          style={{
            fontSize: "15px",
            color: "var(--cr-text-primary)",
            lineHeight: 1.7,
          }}
        >
          We asked {data.queries.length} real shopping queries across ChatGPT, Claude, Gemini, and Perplexity.{" "}
          <strong style={{ color: "var(--cr-accent-red)" }}>
            {brandName} was mentioned {data.brandSov}% of the time
          </strong>
          .{" "}
          {data.topCompetitorName && (
            <>
              Meanwhile,{" "}
              <strong style={{ color: "var(--cr-accent-yellow)" }}>
                {data.topCompetitorName} captured {data.topCompetitorSov}% share of voice
              </strong>
              .{" "}
            </>
          )}
          Your products exist. AI agents don&apos;t know they exist.
        </div>
      </div>

      {/* Individual query cards */}
      {data.queries.map((q, i) => (
        <QueryCard key={i} item={q} brandName={brandName} />
      ))}
    </section>
  );
}
