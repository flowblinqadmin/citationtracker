"use client";

import { motion } from "framer-motion";

interface BenchmarkChartProps {
  yourScore: number;
  industryAverage: number;
  topPerformer: number;
  category: string;
}

function Bar({
  label,
  value,
  color,
  delay,
}: {
  label: string;
  value: number;
  color: string;
  delay: number;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-muted-foreground w-32 text-right shrink-0">
        {label}
      </span>
      <div className="flex-1 bg-border/50 rounded-full h-6 overflow-hidden relative">
        <motion.div
          className="h-full rounded-full"
          style={{ backgroundColor: color }}
          initial={{ width: 0 }}
          animate={{ width: `${value}%` }}
          transition={{ duration: 1, delay, ease: "easeOut" }}
        />
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-semibold text-foreground">
          {value}%
        </span>
      </div>
    </div>
  );
}

export function BenchmarkChart({
  yourScore,
  industryAverage,
  topPerformer,
  category,
}: BenchmarkChartProps) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground mb-4">{category}</p>
      <Bar label="Your score" value={yourScore} color="#f97316" delay={0} />
      <Bar
        label="Industry avg"
        value={industryAverage}
        color="#525252"
        delay={0.2}
      />
      <Bar
        label="Top performer"
        value={topPerformer}
        color="#22c55e"
        delay={0.4}
      />
    </div>
  );
}
