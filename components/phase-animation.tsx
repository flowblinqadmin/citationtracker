"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, CheckCircle2 } from "lucide-react";

export type PhaseStatus = "waiting" | "running" | "done" | "error";

export interface PhaseConfig {
  id: string;
  label: string;
  lines: string[];
  status: PhaseStatus;
  progress?: { current: number; total: number; currentQuery?: string };
}

interface PhaseAnimationProps {
  phases: PhaseConfig[];
}

function TerminalLine({
  text,
  delay,
  prefix = "→",
}: {
  text: string;
  delay: number;
  prefix?: string;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(timer);
  }, [delay]);

  if (!visible) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="text-sm font-mono text-muted-foreground"
    >
      <span className="text-orange-500 mr-2">{prefix}</span>
      {text}
    </motion.div>
  );
}

function PhaseBlock({ phase }: { phase: PhaseConfig }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        {phase.status === "running" && (
          <Loader2 className="w-4 h-4 text-orange-500 animate-spin" />
        )}
        {phase.status === "done" && (
          <CheckCircle2 className="w-4 h-4 text-green-500" />
        )}
        {phase.status === "error" && (
          <span className="w-4 h-4 text-red-500 text-center">×</span>
        )}
        {phase.status === "waiting" && (
          <span className="w-4 h-4 text-muted-foreground/30 text-center">
            ○
          </span>
        )}
        <span
          className={`text-sm font-semibold font-mono ${
            phase.status === "running"
              ? "text-orange-400"
              : phase.status === "done"
                ? "text-green-400"
                : phase.status === "error"
                  ? "text-red-400"
                  : "text-muted-foreground/50"
          }`}
        >
          {phase.label}
        </span>
      </div>

      <AnimatePresence>
        {(phase.status === "running" || phase.status === "done") && (
          <div className="pl-6 space-y-1">
            {phase.progress && phase.status === "running" && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="space-y-2 mb-2"
              >
                <div className="flex items-center gap-3">
                  <div className="flex-1 bg-muted/30 rounded-full h-2 overflow-hidden">
                    <motion.div
                      className="h-2 rounded-full bg-orange-500"
                      initial={{ width: 0 }}
                      animate={{
                        width: `${(phase.progress.current / phase.progress.total) * 100}%`,
                      }}
                      transition={{ duration: 0.5, ease: "easeOut" }}
                    />
                  </div>
                  <span className="text-xs text-muted-foreground font-mono shrink-0">
                    {phase.progress.current}/{phase.progress.total}
                  </span>
                </div>
                {phase.progress.currentQuery && (
                  <p className="text-xs text-muted-foreground/70 font-mono truncate">
                    Testing: &ldquo;{phase.progress.currentQuery}&rdquo;
                  </p>
                )}
              </motion.div>
            )}
            {phase.lines.map((line, i) => (
              <TerminalLine
                key={i}
                text={line}
                delay={phase.status === "done" ? 0 : i * 400}
              />
            ))}
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function PhaseAnimation({ phases }: PhaseAnimationProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [phases]);

  return (
    <div
      ref={containerRef}
      className="bg-[#0a0a0a] rounded-2xl border border-border p-6 font-mono space-y-4 max-h-[500px] overflow-y-auto"
    >
      <div className="flex items-center gap-2 mb-4">
        <div className="w-3 h-3 rounded-full bg-red-500/60" />
        <div className="w-3 h-3 rounded-full bg-yellow-500/60" />
        <div className="w-3 h-3 rounded-full bg-green-500/60" />
        <span className="text-xs text-muted-foreground/50 ml-2">
          flowblinq audit engine
        </span>
      </div>

      {phases.map((phase) => (
        <PhaseBlock key={phase.id} phase={phase} />
      ))}
    </div>
  );
}
