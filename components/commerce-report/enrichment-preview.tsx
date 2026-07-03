"use client";

import type { L2Enrichment, EnrichmentPreview as EnrichmentPreviewType } from "@/lib/types/commerce-report";

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

function isL2Enrichment(data: L2Enrichment | EnrichmentPreviewType): data is L2Enrichment {
  return "before" in data && typeof data.before === "object" && !Array.isArray(data.before) && !("fields" in data);
}

export function EnrichmentPreviewSection({
  data,
}: {
  data: L2Enrichment | EnrichmentPreviewType;
}) {
  // Handle both old and new data format
  if (isL2Enrichment(data)) {
    return <L2EnrichmentView data={data} />;
  }

  // Legacy format — render old way
  return <LegacyEnrichmentView data={data} />;
}

function L2EnrichmentView({ data }: { data: L2Enrichment }) {
  const allKeys = Object.keys(data.after);
  const beforeKeys = Object.keys(data.before);
  // Merge keys (after has all fields)
  const fields = allKeys.length > 0 ? allKeys : beforeKeys;

  return (
    <section style={{ marginBottom: "64px" }}>
      <SectionHeader
        number="03"
        title="What AI Agents See vs. What They Should See"
      />

      <div
        className="cr-grid-2"
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 0,
          border: "1px solid var(--cr-border)",
          borderRadius: "8px",
          overflow: "hidden",
        }}
      >
        {/* Before panel */}
        <div
          style={{
            padding: "28px",
            background: "rgba(239, 68, 68, 0.12)",
            borderRight: "1px solid var(--cr-border)",
          }}
        >
          <div
            style={{
              fontFamily: "var(--cr-font-mono)",
              fontSize: "10px",
              letterSpacing: "2px",
              textTransform: "uppercase",
              color: "var(--cr-accent-red)",
              marginBottom: "16px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <div
              style={{
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                background: "var(--cr-accent-red)",
              }}
            />
            Today — Raw Catalog Data
          </div>
          <div
            style={{
              fontWeight: 600,
              fontSize: "15px",
              color: "var(--cr-text-primary)",
              marginBottom: "16px",
              lineHeight: 1.4,
            }}
          >
            {data.productName}
          </div>
          <div
            style={{
              fontFamily: "var(--cr-font-mono)",
              fontSize: "12px",
              lineHeight: 2,
              color: "var(--cr-text-secondary)",
              overflowWrap: "break-word",
            }}
          >
            {fields.map((key) => (
              <div key={key}>
                <span style={{ color: "var(--cr-text-muted)" }}>{key}:</span>{" "}
                {data.before[key] ? (
                  <span style={{ color: "var(--cr-text-primary)" }}>
                    {data.before[key]}
                  </span>
                ) : (
                  <span
                    style={{
                      color: "var(--cr-accent-red)",
                      fontStyle: "italic",
                    }}
                  >
                    null
                  </span>
                )}
              </div>
            ))}
            <div style={{ marginTop: "8px" }}>
              <span style={{ color: "var(--cr-accent-red)" }}>
                {"\u2192"} {data.fieldsTotal - data.fieldsBefore} of {data.fieldsTotal} agent-critical
                fields missing
              </span>
            </div>
          </div>
        </div>

        {/* After panel */}
        <div
          style={{
            padding: "28px",
            background: "rgba(34, 197, 94, 0.1)",
          }}
        >
          <div
            style={{
              fontFamily: "var(--cr-font-mono)",
              fontSize: "10px",
              letterSpacing: "2px",
              textTransform: "uppercase",
              color: "var(--cr-accent-green)",
              marginBottom: "16px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <div
              style={{
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                background: "var(--cr-accent-green)",
              }}
            />
            After — FlowBlinq Enrichment
          </div>
          <div
            style={{
              fontWeight: 600,
              fontSize: "15px",
              color: "var(--cr-text-primary)",
              marginBottom: "16px",
              lineHeight: 1.4,
            }}
          >
            {data.productName}
          </div>
          <div
            style={{
              fontFamily: "var(--cr-font-mono)",
              fontSize: "12px",
              lineHeight: 2,
              color: "var(--cr-text-secondary)",
              overflowWrap: "break-word",
            }}
          >
            {fields.map((key) => (
              <div key={key}>
                <span style={{ color: "var(--cr-text-muted)" }}>{key}:</span>{" "}
                <span
                  style={{
                    color: !data.before[key]
                      ? "var(--cr-accent-green)"
                      : "var(--cr-text-primary)",
                  }}
                >
                  {data.after[key] || data.before[key] || "—"}
                </span>
              </div>
            ))}
            <div style={{ marginTop: "8px" }}>
              <span style={{ color: "var(--cr-accent-green)" }}>
                {"\u2192"} {data.fieldsAfter} of {data.fieldsTotal} agent-critical
                fields populated {"\u2713"}
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function LegacyEnrichmentView({ data }: { data: EnrichmentPreviewType }) {
  const beforeFields = data.fields.filter((f) => f.before !== null || !f.after);
  const afterFields = data.fields;

  return (
    <section style={{ marginBottom: "64px" }}>
      <SectionHeader
        number="03"
        title="What AI Agents See vs. What They Should See"
      />

      <div
        className="cr-grid-2"
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 0,
          border: "1px solid var(--cr-border)",
          borderRadius: "8px",
          overflow: "hidden",
        }}
      >
        {/* Before panel */}
        <div
          style={{
            padding: "28px",
            background: "rgba(239, 68, 68, 0.12)",
            borderRight: "1px solid var(--cr-border)",
          }}
        >
          <div
            style={{
              fontFamily: "var(--cr-font-mono)",
              fontSize: "10px",
              letterSpacing: "2px",
              textTransform: "uppercase",
              color: "var(--cr-accent-red)",
              marginBottom: "16px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <div
              style={{
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                background: "var(--cr-accent-red)",
              }}
            />
            Today — Raw Catalog Data
          </div>
          <div
            style={{
              fontWeight: 600,
              fontSize: "15px",
              color: "var(--cr-text-primary)",
              marginBottom: "16px",
              lineHeight: 1.4,
            }}
          >
            {data.productName}
          </div>
          <div
            style={{
              fontFamily: "var(--cr-font-mono)",
              fontSize: "12px",
              lineHeight: 2,
              color: "var(--cr-text-secondary)",
            }}
          >
            {beforeFields.map((field) => (
              <div key={field.key}>
                <span style={{ color: "var(--cr-text-muted)" }}>{field.key}:</span>{" "}
                {field.before ? (
                  <span style={{ color: "var(--cr-text-primary)" }}>
                    {field.before}
                  </span>
                ) : (
                  <span
                    style={{
                      color: "var(--cr-accent-red)",
                      fontStyle: "italic",
                    }}
                  >
                    null
                  </span>
                )}
              </div>
            ))}
            <div style={{ marginTop: "8px" }}>
              <span style={{ color: "var(--cr-accent-red)" }}>
                {"\u2192"} {data.missingCount} of {data.totalFields} agent-critical
                fields missing
              </span>
            </div>
          </div>
        </div>

        {/* After panel */}
        <div
          style={{
            padding: "28px",
            background: "rgba(34, 197, 94, 0.1)",
          }}
        >
          <div
            style={{
              fontFamily: "var(--cr-font-mono)",
              fontSize: "10px",
              letterSpacing: "2px",
              textTransform: "uppercase",
              color: "var(--cr-accent-green)",
              marginBottom: "16px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <div
              style={{
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                background: "var(--cr-accent-green)",
              }}
            />
            After — FlowBlinq Enrichment
          </div>
          <div
            style={{
              fontWeight: 600,
              fontSize: "15px",
              color: "var(--cr-text-primary)",
              marginBottom: "16px",
              lineHeight: 1.4,
            }}
          >
            {data.productName}
          </div>
          <div
            style={{
              fontFamily: "var(--cr-font-mono)",
              fontSize: "12px",
              lineHeight: 2,
              color: "var(--cr-text-secondary)",
            }}
          >
            {afterFields.map((field) => (
              <div key={field.key}>
                <span style={{ color: "var(--cr-text-muted)" }}>{field.key}:</span>{" "}
                <span
                  style={{
                    color: field.before
                      ? "var(--cr-text-primary)"
                      : "var(--cr-accent-green)",
                  }}
                >
                  {field.after}
                </span>
              </div>
            ))}
            <div style={{ marginTop: "8px" }}>
              <span style={{ color: "var(--cr-accent-green)" }}>
                {"\u2192"} {data.totalFields} of {data.totalFields} agent-critical
                fields populated {"\u2713"}
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
