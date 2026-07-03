"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";

interface RevenueCalculatorProps {
  low: number;
  high: number;
  gapPercent: number;
  methodology: string;
  initialScore: number;
}

function formatMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toLocaleString()}`;
}

export function RevenueCalculator({
  low,
  high,
  gapPercent,
  methodology,
  initialScore,
}: RevenueCalculatorProps) {
  const [customRevenue, setCustomRevenue] = useState("");
  const [computed, setComputed] = useState<{ low: number; high: number } | null>(
    null
  );

  function recalculate(revenueStr: string) {
    setCustomRevenue(revenueStr);
    const num = parseFloat(revenueStr.replace(/[^0-9.]/g, ""));
    if (isNaN(num) || num <= 0) {
      setComputed(null);
      return;
    }
    const annual = num * 1_000_000;
    const gap = gapPercent / 100;
    const missed = annual * 0.01 * gap;
    setComputed({ low: Math.round(missed * 0.5), high: Math.round(missed * 2) });
  }

  const displayLow = computed?.low ?? low;
  const displayHigh = computed?.high ?? high;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-3xl font-bold text-orange-500">
          {formatMoney(displayLow)} — {formatMoney(displayHigh)}
        </span>
        <span className="text-sm text-muted-foreground">/year at risk</span>
      </div>

      <div className="flex items-center gap-3">
        <label className="text-sm text-muted-foreground shrink-0">
          Your annual revenue ($M):
        </label>
        <Input
          type="text"
          placeholder="e.g. 25"
          value={customRevenue}
          onChange={(e) => recalculate(e.target.value)}
          className="w-28"
        />
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">
        Formula: annual revenue x 1% AI opportunity x {gapPercent}% visibility
        gap (your score: {initialScore}/100).{" "}
        <span className="text-muted-foreground/70">{methodology}</span>
      </p>
    </div>
  );
}
