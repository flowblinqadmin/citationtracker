"use client";

import { Card } from "@/components/ui/card";

interface SemanticComparisonProps {
  productUrl: string;
  current: {
    title: string;
    attributeCount: number;
    attributes: string[];
  };
  enriched: {
    title: string;
    attributeCount: number;
    addedAttributes: string[];
    agentVerdictBefore: string;
    agentVerdictAfter: string;
  };
}

export function SemanticComparison({
  productUrl,
  current,
  enriched,
}: SemanticComparisonProps) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground truncate">
        Product analyzed:{" "}
        <a
          href={productUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          {productUrl}
        </a>
      </p>

      <div className="grid md:grid-cols-2 gap-4">
        {/* Before */}
        <Card className="p-5 border-red-500/30 bg-red-500/5">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold text-red-400">
              Current (Before)
            </h4>
            <span className="text-xs px-2 py-1 rounded bg-red-500/20 text-red-400">
              {current.attributeCount} attributes
            </span>
          </div>
          <p className="text-sm text-foreground font-medium mb-2 line-clamp-2">
            {current.title || "No title found"}
          </p>
          {current.attributes.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-3">
              {current.attributes.slice(0, 8).map((attr) => (
                <span
                  key={attr}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
                >
                  {attr}
                </span>
              ))}
              {current.attributes.length > 8 && (
                <span className="text-[10px] text-muted-foreground">
                  +{current.attributes.length - 8} more
                </span>
              )}
            </div>
          )}
          <div className="bg-background rounded-lg p-3 mt-auto">
            <p className="text-xs text-muted-foreground italic">
              AI agent verdict: &ldquo;{enriched.agentVerdictBefore}&rdquo;
            </p>
          </div>
        </Card>

        {/* After */}
        <Card className="p-5 border-green-500/30 bg-green-500/5">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold text-green-400">
              Enriched (After)
            </h4>
            <span className="text-xs px-2 py-1 rounded bg-green-500/20 text-green-400">
              {enriched.attributeCount} attributes
            </span>
          </div>
          <p className="text-sm text-foreground font-medium mb-2 line-clamp-2">
            {enriched.title}
          </p>
          {enriched.addedAttributes.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-3">
              {enriched.addedAttributes.slice(0, 8).map((attr) => (
                <span
                  key={attr}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/15 text-green-400"
                >
                  + {attr}
                </span>
              ))}
              {enriched.addedAttributes.length > 8 && (
                <span className="text-[10px] text-green-400/60">
                  +{enriched.addedAttributes.length - 8} more
                </span>
              )}
            </div>
          )}
          <div className="bg-background rounded-lg p-3 mt-auto">
            <p className="text-xs text-muted-foreground italic">
              AI agent verdict: &ldquo;{enriched.agentVerdictAfter}&rdquo;
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
