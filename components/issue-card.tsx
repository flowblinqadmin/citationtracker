"use client";

import { AlertTriangle, AlertCircle, Info, Zap } from "lucide-react";

interface IssueCardProps {
  title: string;
  severity: "critical" | "warning" | "info";
  description: string;
  isQuickWin: boolean;
  estimatedEffort: string;
}

const severityConfig = {
  critical: {
    icon: AlertTriangle,
    color: "text-red-400",
    bg: "bg-red-500/10",
    border: "border-red-500/30",
    label: "Critical",
  },
  warning: {
    icon: AlertCircle,
    color: "text-yellow-400",
    bg: "bg-yellow-500/10",
    border: "border-yellow-500/30",
    label: "Warning",
  },
  info: {
    icon: Info,
    color: "text-blue-400",
    bg: "bg-blue-500/10",
    border: "border-blue-500/30",
    label: "Info",
  },
};

export function IssueCard({
  title,
  severity,
  description,
  isQuickWin,
  estimatedEffort,
}: IssueCardProps) {
  const config = severityConfig[severity];
  const Icon = config.icon;

  return (
    <div
      className={`rounded-xl border ${config.border} ${config.bg} p-4 flex gap-3`}
    >
      <Icon className={`w-5 h-5 ${config.color} shrink-0 mt-0.5`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h4 className="text-sm font-semibold text-foreground">{title}</h4>
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded ${config.bg} ${config.color} font-medium`}
          >
            {config.label}
          </span>
          {isQuickWin && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400 font-medium flex items-center gap-0.5">
              <Zap className="w-2.5 h-2.5" /> Quick win
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-1">{description}</p>
        <p className="text-[10px] text-muted-foreground/60 mt-1">
          Est. effort: {estimatedEffort}
        </p>
      </div>
    </div>
  );
}
