"use client";

import { useState } from "react";
import type { RevenueImpact as RevenueImpactType, MerchantCurrency } from "@/lib/types/commerce-report";

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
          color: "var(--cr-accent-orange)",
          background: "rgba(249, 115, 22, 0.15)",
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

const SCENARIO_STYLES: Record<string, React.CSSProperties> = {
  conservative: { background: "rgba(148,163,184,0.05)" },
  moderate: { background: "rgba(20, 184, 166, 0.12)" },
  aggressive: { background: "rgba(249, 115, 22, 0.15)" },
};

const LABEL_COLORS: Record<string, string> = {
  conservative: "var(--cr-text-muted)",
  moderate: "var(--cr-accent-teal)",
  aggressive: "var(--cr-accent-orange)",
};

function fmt(n: number, currency: MerchantCurrency = { code: "USD", symbol: "$", rate: 1 }): string {
  const local = n * currency.rate;
  const s = currency.symbol;
  if (currency.code === "INR") {
    if (local >= 1_00_00_000) return `${s}${(local / 1_00_00_000).toFixed(1)} Cr`;
    if (local >= 1_00_000) return `${s}${(local / 1_00_000).toFixed(1)} L`;
    return `${s}${Math.round(local).toLocaleString("en-IN")}`;
  }
  if (local >= 1_000_000) return `${s}${(local / 1_000_000).toFixed(1)}M`;
  if (local >= 1_000) return `${s}${Math.round(local / 1_000)}K`;
  return `${s}${Math.round(local)}`;
}

function calcScenarios(annualRevMillion: number, currency?: MerchantCurrency) {
  const rev = annualRevMillion * 1_000_000;
  const f = (n: number) => fmt(n, currency);
  return [
    {
      label: "Conservative",
      type: "conservative" as const,
      totalRevenue: f(Math.round(rev * 0.012 * 1.4)),
      gmv: f(Math.round(rev * 0.012)),
      aovUplift: "+40%",
      newCustomers: `~${Math.round((rev * 0.012) / 500).toLocaleString()}`,
      assumption: "1.2% of revenue shifts to agentic",
    },
    {
      label: "Moderate",
      type: "moderate" as const,
      totalRevenue: f(Math.round(rev * 0.03 * 1.65)),
      gmv: f(Math.round(rev * 0.03)),
      aovUplift: "+65%",
      newCustomers: `~${Math.round((rev * 0.03) / 500).toLocaleString()}`,
      assumption: "3% of revenue shifts to agentic",
    },
    {
      label: "Aggressive",
      type: "aggressive" as const,
      totalRevenue: f(Math.round(rev * 0.07 * 1.95)),
      gmv: f(Math.round(rev * 0.07)),
      aovUplift: "+95%",
      newCustomers: `~${Math.round((rev * 0.07) / 500).toLocaleString()}`,
      assumption: "7% of revenue shifts to agentic",
    },
  ];
}

export function RevenueImpactSection({
  data,
  merchantCurrency,
}: {
  data: RevenueImpactType;
  merchantCurrency?: MerchantCurrency;
}) {
  const defaultRev = data.baseRevenueMillion ?? 15;
  const [revMillion, setRevMillion] = useState(defaultRev);
  const [inputVal, setInputVal] = useState(String(defaultRev));
  const [isCustom, setIsCustom] = useState(false);

  const scenarios = isCustom ? calcScenarios(revMillion, merchantCurrency) : data.scenarios;

  function handleInput(val: string) {
    setInputVal(val);
    const n = parseFloat(val);
    if (!isNaN(n) && n > 0) {
      setRevMillion(n);
      setIsCustom(true);
    }
  }

  return (
    <section style={{ marginBottom: "64px" }}>
      <SectionHeader number="06" title="Revenue Impact Model" />

      <div
        style={{
          background: "var(--cr-bg-card)",
          border: "1px solid var(--cr-border)",
          borderRadius: "8px",
          padding: "28px",
          marginBottom: "32px",
        }}
      >
        {/* Revenue input */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            marginBottom: "24px",
            padding: "16px 20px",
            background: "rgba(249, 115, 22, 0.06)",
            borderRadius: "6px",
            border: "1px solid rgba(249, 115, 22, 0.15)",
          }}
        >
          <span
            style={{
              fontSize: "13px",
              color: "var(--cr-text-secondary)",
              whiteSpace: "nowrap",
            }}
          >
            Your annual revenue (USD $M):
          </span>
          <input
            type="number"
            value={inputVal}
            min="1"
            step="1"
            onChange={(e) => handleInput(e.target.value)}
            style={{
              width: "100px",
              background: "var(--cr-bg-secondary)",
              border: "1px solid var(--cr-border-accent)",
              borderRadius: "4px",
              color: "var(--cr-text-primary)",
              fontFamily: "var(--cr-font-mono)",
              fontSize: "14px",
              fontWeight: 600,
              padding: "6px 10px",
              outline: "none",
            }}
          />
          {isCustom && (
            <span
              style={{
                fontFamily: "var(--cr-font-mono)",
                fontSize: "11px",
                color: "var(--cr-accent-teal)",
              }}
            >
              updated
            </span>
          )}
          <span
            style={{
              fontSize: "12px",
              color: "var(--cr-text-muted)",
              marginLeft: "auto",
            }}
          >
            {isCustom
              ? `Based on $${revMillion}M annual revenue`
              : data.methodology.replace(/^Based on [^'s]*'s estimated /, "Based on estimated ")}
          </span>
        </div>

        <div
          className="cr-grid-3"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "24px",
          }}
        >
          {scenarios.map((scenario) => (
            <div
              key={scenario.type}
              style={{
                padding: "20px",
                borderRadius: "8px",
                border: "1px solid var(--cr-border)",
                ...SCENARIO_STYLES[scenario.type],
              }}
            >
              <div
                style={{
                  fontFamily: "var(--cr-font-mono)",
                  fontSize: "10px",
                  letterSpacing: "2px",
                  textTransform: "uppercase",
                  color: LABEL_COLORS[scenario.type],
                  marginBottom: "12px",
                }}
              >
                {scenario.label}
              </div>
              <div
                style={{
                  fontFamily: "var(--cr-font-mono)",
                  fontSize: "28px",
                  fontWeight: 700,
                  color: "var(--cr-text-primary)",
                  lineHeight: 1,
                  marginBottom: "4px",
                }}
              >
                {scenario.totalRevenue}
              </div>
              <div
                style={{
                  fontSize: "12px",
                  color: "var(--cr-text-muted)",
                  marginBottom: "16px",
                }}
              >
                Incremental revenue — Year 1
              </div>
              <div
                style={{
                  fontFamily: "var(--cr-font-mono)",
                  fontSize: "11px",
                  color: "var(--cr-text-secondary)",
                  lineHeight: 2,
                }}
              >
                Agent GMV: {scenario.gmv}
                <br />
                Avg. AOV uplift: {scenario.aovUplift}
                <br />
                New customers via agent: {scenario.newCustomers}
                <br />
                Assumption: {scenario.assumption}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* AOV Insight */}
      <div
        style={{
          background: "var(--cr-bg-card)",
          border: "1px solid var(--cr-border)",
          borderLeft: "3px solid var(--cr-accent-orange)",
          borderRadius: "8px",
          padding: "24px 28px",
        }}
      >
        <div
          style={{
            fontFamily: "var(--cr-font-mono)",
            fontSize: "11px",
            letterSpacing: "2px",
            textTransform: "uppercase",
            color: "var(--cr-accent-orange)",
            marginBottom: "8px",
          }}
        >
          The AOV Multiplier Effect
        </div>
        <div
          style={{
            fontSize: "16px",
            color: "var(--cr-text-primary)",
            lineHeight: 1.7,
          }}
          dangerouslySetInnerHTML={{ __html: data.aovInsight }}
        />
      </div>
    </section>
  );
}
