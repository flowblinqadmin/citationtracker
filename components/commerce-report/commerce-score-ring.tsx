"use client";

import { motion } from "framer-motion";
import type { CommerceScore } from "@/lib/types/commerce-report";

const CIRCUMFERENCE = 2 * Math.PI * 90; // ~565.48

function getColor(level: "high" | "medium" | "low"): string {
  if (level === "high") return "var(--cr-accent-green)";
  if (level === "medium") return "var(--cr-accent-yellow)";
  return "var(--cr-accent-red)";
}

export function CommerceScoreRing({ score }: { score: CommerceScore }) {
  const offset = CIRCUMFERENCE - (score.overall / 100) * CIRCUMFERENCE;

  return (
    <section
      className="cr-score-layout"
      style={{
        display: "grid",
        gridTemplateColumns: "220px 1fr",
        gap: "48px",
        alignItems: "center",
        marginBottom: "64px",
      }}
    >
      {/* Ring */}
      <div className="cr-score-ring" style={{ position: "relative", width: "200px", height: "200px" }}>
        <svg
          viewBox="0 0 200 200"
          width="200"
          height="200"
          style={{ transform: "rotate(-90deg)" }}
        >
          <circle
            cx="100"
            cy="100"
            r="90"
            fill="none"
            stroke="var(--cr-border)"
            strokeWidth="8"
          />
          <motion.circle
            cx="100"
            cy="100"
            r="90"
            fill="none"
            stroke="var(--cr-accent-orange)"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            initial={{ strokeDashoffset: CIRCUMFERENCE }}
            animate={{ strokeDashoffset: offset }}
            transition={{ duration: 2, ease: "easeOut" }}
            style={{
              filter: "drop-shadow(0 0 12px rgba(249,115,22,0.3))",
            }}
          />
        </svg>
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            textAlign: "center",
          }}
        >
          <div
            className="cr-score-num"
            style={{
              fontFamily: "var(--cr-font-mono)",
              fontSize: "52px",
              fontWeight: 700,
              color: "var(--cr-text-primary)",
              lineHeight: 1,
            }}
          >
            {score.overall}
          </div>
          <div
            className="cr-score-label"
            style={{
              fontSize: "11px",
              fontFamily: "var(--cr-font-mono)",
              letterSpacing: "2px",
              textTransform: "uppercase",
              color: "var(--cr-text-muted)",
              marginTop: "4px",
            }}
          >
            out of 100
          </div>
        </div>
      </div>

      {/* Breakdown */}
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {score.subScores.map((sub) => (
          <div
            key={sub.label}
            className="cr-subscore-row"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 60px 200px",
              alignItems: "center",
              gap: "16px",
            }}
          >
            <span style={{ fontSize: "14px", color: "var(--cr-text-secondary)" }}>
              {sub.label}
            </span>
            <span
              style={{
                fontFamily: "var(--cr-font-mono)",
                fontSize: "14px",
                fontWeight: 600,
                textAlign: "right",
                color: getColor(sub.level),
              }}
            >
              {sub.value}%
            </span>
            <div
              style={{
                height: "6px",
                background: "var(--cr-border)",
                borderRadius: "3px",
                overflow: "hidden",
              }}
            >
              <motion.div
                className="cr-subscore-bar-fill"
                initial={{ width: 0 }}
                animate={{ width: `${Math.max(sub.value, 1)}%` }}
                transition={{ duration: 1.5, ease: "easeOut" }}
                style={{
                  height: "100%",
                  borderRadius: "3px",
                  background: getColor(sub.level),
                  minWidth: "3px",
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
