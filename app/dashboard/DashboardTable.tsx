"use client";

import { useState } from "react";
import DomainTableRow from "./DomainTableRow";

const BORDER = "#e5e5ea";
const T3     = "#aeaeb2";

type SortCol = "domain" | "score" | "lastScan";
type SortDir = "asc" | "desc";

interface DomainRow {
  id: string;
  domain: string;
  siteId: string;
  accessToken: string | null;
  pipelineStatus: string | null;
  overallScore: number | null;
  tier: "GOOD" | "FAIR" | "WEAK" | "POOR" | null;
  criticalIssues: number;
  delta: number | null;
  pageCount: number;
  citationRate: number | null;
  lastCrawlAt: string | null;
  pipelineError: string | null;
}

interface Props {
  domains: DomainRow[];
  accountTier: "free" | "paid";
}

function SortIcon({ col, active, dir }: { col: string; active: boolean; dir: SortDir }) {
  return (
    <span style={{ marginLeft: 4, opacity: active ? 1 : 0.35, fontSize: 9, userSelect: "none" }}>
      {active ? (dir === "asc" ? "▲" : "▼") : "▲▼"}
    </span>
  );
}

export default function DashboardTable({ domains, accountTier }: Props) {
  const [sortCol, setSortCol] = useState<SortCol>("lastScan");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function handleSort(col: SortCol) {
    if (sortCol === col) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortCol(col);
      setSortDir(col === "domain" ? "asc" : "desc");
    }
  }

  const sorted = [...domains].sort((a, b) => {
    let cmp = 0;
    if (sortCol === "domain") {
      cmp = a.domain.localeCompare(b.domain);
    } else if (sortCol === "score") {
      const aScore = a.overallScore ?? -1;
      const bScore = b.overallScore ?? -1;
      cmp = aScore - bScore;
    } else {
      const aTime = a.lastCrawlAt ? new Date(a.lastCrawlAt).getTime() : 0;
      const bTime = b.lastCrawlAt ? new Date(b.lastCrawlAt).getTime() : 0;
      cmp = aTime - bTime;
    }
    return sortDir === "asc" ? cmp : -cmp;
  });

  const STATIC_HEADERS = ["Tier", "Citations", "Critical", "Delta"];

  function thStyle(clickable: boolean): React.CSSProperties {
    return {
      fontSize: 10, fontWeight: 600, color: T3, textAlign: "left",
      padding: "10px 14px", borderBottom: `1px solid ${BORDER}`,
      textTransform: "uppercase", letterSpacing: "0.5px",
      cursor: clickable ? "pointer" : "default",
      whiteSpace: "nowrap",
      userSelect: "none",
    };
  }

  return (
    <div className="dash-table-wrap">
      <table style={{ width: "100%", borderCollapse: "collapse", background: "#fff", borderRadius: 12, boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)", border: `1px solid ${BORDER}`, overflow: "hidden", minWidth: 800 }}>
        <thead style={{ background: "#fafafa" }}>
          <tr>
            <th style={thStyle(true)} onClick={() => handleSort("domain")}>
              Domain <SortIcon col="domain" active={sortCol === "domain"} dir={sortDir} />
            </th>
            <th style={thStyle(true)} onClick={() => handleSort("score")}>
              GEO Score <SortIcon col="score" active={sortCol === "score"} dir={sortDir} />
            </th>
            {STATIC_HEADERS.map(h => (
              <th key={h} style={thStyle(false)}>{h}</th>
            ))}
            <th style={thStyle(true)} onClick={() => handleSort("lastScan")}>
              Last Scan <SortIcon col="lastScan" active={sortCol === "lastScan"} dir={sortDir} />
            </th>
            <th style={thStyle(false)}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(row => (
            <DomainTableRow key={row.siteId} row={row} accountTier={accountTier} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
