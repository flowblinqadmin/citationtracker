"use client";

import type { CatalogSnapshot as CatalogSnapshotType } from "@/lib/types/commerce-report";

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

function StatCard({
  value,
  label,
  color,
}: {
  value: string | number;
  label: string;
  color: string;
}) {
  return (
    <div
      style={{
        background: "var(--cr-bg-card)",
        border: "1px solid var(--cr-border)",
        borderRadius: "8px",
        padding: "20px",
      }}
    >
      <div
        style={{
          fontFamily: "var(--cr-font-mono)",
          fontSize: "32px",
          fontWeight: 700,
          lineHeight: 1,
          marginBottom: "4px",
          color,
        }}
      >
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
      <div
        style={{
          fontSize: "12px",
          color: "var(--cr-text-muted)",
          fontFamily: "var(--cr-font-mono)",
          letterSpacing: "0.5px",
        }}
      >
        {label}
      </div>
    </div>
  );
}

function StatusTag({ status }: { status: "visible" | "partial" | "invisible" }) {
  const colors = {
    visible: { bg: "rgba(34, 197, 94, 0.1)", text: "var(--cr-accent-green)" },
    partial: { bg: "rgba(234, 179, 8, 0.1)", text: "var(--cr-accent-yellow)" },
    invisible: { bg: "rgba(239, 68, 68, 0.12)", text: "var(--cr-accent-red)" },
  };
  const c = colors[status];

  return (
    <span
      style={{
        display: "inline-block",
        fontFamily: "var(--cr-font-mono)",
        fontSize: "10px",
        padding: "3px 8px",
        borderRadius: "3px",
        fontWeight: 600,
        letterSpacing: "0.5px",
        background: c.bg,
        color: c.text,
      }}
    >
      {status.toUpperCase()}
    </span>
  );
}

export function CatalogSnapshotSection({ data }: { data: CatalogSnapshotType }) {
  return (
    <section style={{ marginBottom: "64px" }}>
      <SectionHeader number="01" title="Catalog Snapshot" />

      {/* Stat cards */}
      <div
        className="cr-grid-4"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: "16px",
          marginBottom: "32px",
        }}
      >
        <StatCard
          value={data.totalCrawled}
          label="Total Products Crawled"
          color="var(--cr-accent-orange)"
        />
        <StatCard
          value={data.visible}
          label="Agent-Visible (data sufficient)"
          color="var(--cr-accent-green)"
        />
        <StatCard
          value={data.partial}
          label="Partially Visible (missing attrs)"
          color="var(--cr-accent-yellow)"
        />
        <StatCard
          value={data.invisible}
          label="Invisible to AI Agents"
          color="var(--cr-accent-red)"
        />
      </div>

      {/* Product table */}
      {data.sampleProducts.length > 0 && (
        <div
          className="cr-table-wrap"
          style={{
            background: "var(--cr-bg-card)",
            border: "1px solid var(--cr-border)",
            borderRadius: "8px",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "16px 20px",
              borderBottom: "1px solid var(--cr-border)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span
              style={{
                fontFamily: "var(--cr-font-mono)",
                fontSize: "12px",
                letterSpacing: "1px",
                textTransform: "uppercase",
                color: "var(--cr-text-muted)",
              }}
            >
              Products Requiring Attention — Sample ({data.sampleProducts.length} of{" "}
              {data.invisible + data.partial})
            </span>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["Product", "SKU", "Status", "Missing Attributes"].map((h) => (
                  <th
                    key={h}
                    style={{
                      fontFamily: "var(--cr-font-mono)",
                      fontSize: "10px",
                      letterSpacing: "1.5px",
                      textTransform: "uppercase",
                      color: "var(--cr-text-muted)",
                      textAlign: "left",
                      padding: "12px 20px",
                      borderBottom: "1px solid var(--cr-border)",
                      background: "rgba(0,0,0,0.2)",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.sampleProducts.slice(0, 5).map((product, i) => (
                <tr key={i}>
                  <td
                    style={{
                      padding: "14px 20px",
                      borderBottom: "1px solid rgba(30,41,59,0.5)",
                      fontSize: "13px",
                      color: "var(--cr-text-primary)",
                      fontWeight: 500,
                      maxWidth: "260px",
                    }}
                  >
                    {product.name}
                  </td>
                  <td
                    style={{
                      padding: "14px 20px",
                      borderBottom: "1px solid rgba(30,41,59,0.5)",
                      fontFamily: "var(--cr-font-mono)",
                      fontSize: "12px",
                      color: "var(--cr-text-secondary)",
                    }}
                  >
                    {product.sku || "—"}
                  </td>
                  <td
                    style={{
                      padding: "14px 20px",
                      borderBottom: "1px solid rgba(30,41,59,0.5)",
                    }}
                  >
                    <StatusTag status={product.status} />
                  </td>
                  <td
                    style={{
                      padding: "14px 20px",
                      borderBottom: "1px solid rgba(30,41,59,0.5)",
                    }}
                  >
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                      {product.missingAttributes.slice(0, 4).map((attr) => (
                        <span
                          key={attr}
                          style={{
                            fontFamily: "var(--cr-font-mono)",
                            fontSize: "10px",
                            padding: "2px 6px",
                            background: "rgba(239, 68, 68, 0.12)",
                            color: "var(--cr-accent-red)",
                            borderRadius: "2px",
                          }}
                        >
                          {attr}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
