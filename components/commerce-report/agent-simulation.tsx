"use client";

import type { L2Simulation, AgentSimulation as AgentSimulationType } from "@/lib/types/commerce-report";

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

// New L2 simulation component
function L2SimulationView({ sim }: { sim: L2Simulation }) {
  return (
    <div
      style={{
        background: "var(--cr-bg-card)",
        border: "1px solid var(--cr-border)",
        borderRadius: "8px",
        overflow: "hidden",
        marginBottom: "32px",
      }}
    >
      {/* macOS-style header */}
      <div
        style={{
          background: "rgba(0,0,0,0.3)",
          padding: "12px 20px",
          display: "flex",
          alignItems: "center",
          gap: "8px",
          borderBottom: "1px solid var(--cr-border)",
        }}
      >
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#ef4444" }} />
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#eab308" }} />
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#22c55e" }} />
        <span
          style={{
            fontFamily: "var(--cr-font-mono)",
            fontSize: "12px",
            color: "var(--cr-text-muted)",
            marginLeft: "8px",
          }}
        >
          ChatGPT — Shopping Agent Simulation
        </span>
      </div>

      <div style={{ padding: "28px" }}>
        {/* Buyer query — chat bubble */}
        <div
          style={{
            background: "rgba(255,255,255,0.04)",
            borderRadius: "12px",
            padding: "16px 20px",
            marginBottom: "24px",
            border: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          <div
            style={{
              fontFamily: "var(--cr-font-mono)",
              fontSize: "10px",
              letterSpacing: "1.5px",
              textTransform: "uppercase",
              color: "var(--cr-text-muted)",
              marginBottom: "6px",
            }}
          >
            Customer Query
          </div>
          <div
            style={{
              fontSize: "15px",
              color: "var(--cr-text-primary)",
              fontStyle: "italic",
            }}
          >
            &ldquo;{sim.buyerQuery}&rdquo;
          </div>
        </div>

        {/* Two column layout: With ACP / Without ACP */}
        <div
          className="cr-grid-2"
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "16px",
          }}
        >
          {/* WITH AI Commerce panel */}
          <div
            style={{
              background: "rgba(34, 197, 94, 0.08)",
              border: "1px solid rgba(34, 197, 94, 0.2)",
              borderRadius: "8px",
              padding: "20px",
            }}
          >
            <div
              style={{
                fontFamily: "var(--cr-font-mono)",
                fontSize: "10px",
                letterSpacing: "1.5px",
                textTransform: "uppercase",
                color: "var(--cr-accent-green)",
                marginBottom: "16px",
              }}
            >
              With AI Commerce
            </div>

            {/* Product card */}
            <div
              style={{
                fontWeight: 600,
                fontSize: "14px",
                color: "var(--cr-text-primary)",
                marginBottom: "6px",
              }}
            >
              {sim.withAcp.productName}
            </div>
            <div
              style={{
                fontFamily: "var(--cr-font-mono)",
                fontSize: "20px",
                fontWeight: 700,
                color: "var(--cr-accent-green)",
                marginBottom: "12px",
              }}
            >
              {sim.withAcp.price}
            </div>

            {/* Specs */}
            {sim.withAcp.specs.length > 0 && (
              <div style={{ marginBottom: "12px" }}>
                {sim.withAcp.specs.map((spec, i) => (
                  <div
                    key={i}
                    style={{
                      fontFamily: "var(--cr-font-mono)",
                      fontSize: "11px",
                      color: "var(--cr-text-secondary)",
                      padding: "4px 0",
                      borderBottom: i < sim.withAcp.specs.length - 1 ? "1px solid rgba(255,255,255,0.05)" : "none",
                    }}
                  >
                    {spec}
                  </div>
                ))}
              </div>
            )}

            {/* Reason */}
            <div
              style={{
                fontSize: "13px",
                color: "var(--cr-text-secondary)",
                lineHeight: 1.6,
                marginBottom: "16px",
              }}
            >
              {sim.withAcp.reason}
            </div>

            {/* Bundle */}
            {sim.withAcp.bundle && (
              <div
                style={{
                  background: "rgba(34, 197, 94, 0.1)",
                  borderRadius: "6px",
                  padding: "12px 16px",
                  border: "1px solid rgba(34, 197, 94, 0.15)",
                }}
              >
                <div
                  style={{
                    fontFamily: "var(--cr-font-mono)",
                    fontSize: "10px",
                    letterSpacing: "1px",
                    textTransform: "uppercase",
                    color: "var(--cr-accent-green)",
                    marginBottom: "8px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span>Bundle Suggestion</span>
                  <span
                    style={{
                      background: "var(--cr-accent-green)",
                      color: "var(--cr-bg-primary)",
                      padding: "2px 8px",
                      borderRadius: "3px",
                      fontWeight: 700,
                      fontSize: "9px",
                    }}
                  >
                    +{sim.withAcp.bundle.aovUpliftPct} AOV
                  </span>
                </div>
                {sim.withAcp.bundle.items.map((item, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: "12px",
                      color: "var(--cr-text-secondary)",
                      padding: "4px 0",
                    }}
                  >
                    <span style={{ maxWidth: "70%" }}>{item.name}</span>
                    <span style={{ fontFamily: "var(--cr-font-mono)", fontWeight: 600, color: "var(--cr-text-primary)" }}>
                      {item.price}
                    </span>
                  </div>
                ))}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontWeight: 700,
                    fontSize: "14px",
                    color: "var(--cr-accent-green)",
                    borderTop: "1px solid rgba(34, 197, 94, 0.2)",
                    marginTop: "8px",
                    paddingTop: "8px",
                  }}
                >
                  <span>Bundle Total</span>
                  <span style={{ fontFamily: "var(--cr-font-mono)" }}>{sim.withAcp.bundle.total}</span>
                </div>
              </div>
            )}
          </div>

          {/* WITHOUT AI Commerce panel */}
          <div
            style={{
              background: "rgba(239, 68, 68, 0.08)",
              border: "1px solid rgba(239, 68, 68, 0.2)",
              borderRadius: "8px",
              padding: "20px",
            }}
          >
            <div
              style={{
                fontFamily: "var(--cr-font-mono)",
                fontSize: "10px",
                letterSpacing: "1.5px",
                textTransform: "uppercase",
                color: "var(--cr-accent-red)",
                marginBottom: "16px",
              }}
            >
              Without AI Commerce — Today
            </div>

            <div
              style={{
                fontWeight: 600,
                fontSize: "14px",
                color: "var(--cr-text-primary)",
                marginBottom: "6px",
              }}
            >
              Agent recommends: {sim.withoutAcp.competitorName}
            </div>
            <div
              style={{
                fontSize: "13px",
                color: "var(--cr-text-muted)",
                marginBottom: "16px",
                fontStyle: "italic",
              }}
            >
              {sim.withoutAcp.competitorProduct}
            </div>
            <div
              style={{
                fontSize: "13px",
                color: "var(--cr-text-secondary)",
                lineHeight: 1.6,
              }}
            >
              {sim.withoutAcp.narrative}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Legacy simulation card (old format)
function LegacySimulationCard({ sim }: { sim: AgentSimulationType }) {
  return (
    <div
      style={{
        background: "var(--cr-bg-card)",
        border: "1px solid var(--cr-border)",
        borderRadius: "8px",
        overflow: "hidden",
        marginBottom: "32px",
      }}
    >
      <div
        style={{
          background: "rgba(0,0,0,0.3)",
          padding: "12px 20px",
          display: "flex",
          alignItems: "center",
          gap: "8px",
          borderBottom: "1px solid var(--cr-border)",
        }}
      >
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#ef4444" }} />
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#eab308" }} />
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#22c55e" }} />
        <span
          style={{
            fontFamily: "var(--cr-font-mono)",
            fontSize: "12px",
            color: "var(--cr-text-muted)",
            marginLeft: "8px",
          }}
        >
          {sim.title}
        </span>
      </div>

      <div style={{ padding: "28px" }}>
        <div
          style={{
            background: "rgba(255,255,255,0.04)",
            borderRadius: "12px",
            padding: "16px 20px",
            marginBottom: "20px",
            border: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          <div
            style={{
              fontFamily: "var(--cr-font-mono)",
              fontSize: "10px",
              letterSpacing: "1.5px",
              textTransform: "uppercase",
              color: "var(--cr-text-muted)",
              marginBottom: "6px",
            }}
          >
            User Prompt
          </div>
          <div
            style={{
              fontSize: "15px",
              color: "var(--cr-text-primary)",
              fontStyle: "italic",
            }}
          >
            &ldquo;{sim.query}&rdquo;
          </div>
        </div>

        <div style={{ paddingLeft: "20px", borderLeft: "2px solid var(--cr-border)" }}>
          <div
            style={{
              fontFamily: "var(--cr-font-mono)",
              fontSize: "10px",
              letterSpacing: "1.5px",
              textTransform: "uppercase",
              color: "var(--cr-accent-teal)",
              marginBottom: "12px",
            }}
          >
            Agent Response (if ACP-enabled)
          </div>

          {sim.products.map((product, i) => (
            <div
              key={i}
              style={{
                background: "var(--cr-bg-secondary)",
                border: "1px solid var(--cr-border)",
                borderRadius: "8px",
                padding: "20px",
                marginBottom: "12px",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: "14px", color: "var(--cr-text-primary)", marginBottom: "6px" }}>
                {product.name}
              </div>
              <div
                style={{
                  fontFamily: "var(--cr-font-mono)",
                  fontSize: "18px",
                  fontWeight: 700,
                  color: "var(--cr-accent-green)",
                  marginBottom: "8px",
                }}
              >
                {product.price}
              </div>
              <div
                style={{ fontSize: "13px", color: "var(--cr-text-secondary)", lineHeight: 1.6 }}
                dangerouslySetInnerHTML={{ __html: product.reason }}
              />
            </div>
          ))}

          <div
            style={{
              background: "rgba(239, 68, 68, 0.12)",
              border: "1px solid rgba(239,68,68,0.2)",
              borderRadius: "8px",
              padding: "16px 20px",
              marginTop: "16px",
            }}
          >
            <div
              style={{
                fontFamily: "var(--cr-font-mono)",
                fontSize: "10px",
                letterSpacing: "1.5px",
                textTransform: "uppercase",
                color: "var(--cr-accent-red)",
                marginBottom: "8px",
              }}
            >
              Without ACP — What Actually Happens Today
            </div>
            <div
              style={{ fontSize: "13px", color: "var(--cr-text-secondary)", lineHeight: 1.6 }}
              dangerouslySetInnerHTML={{ __html: sim.excludedExplanation }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// Export supports both new L2Simulation and legacy AgentSimulation[]
export function AgentSimulationSection({
  simulation,
  simulations,
}: {
  simulation?: L2Simulation | null;
  simulations?: AgentSimulationType[] | null;
}) {
  return (
    <section style={{ marginBottom: "64px" }}>
      <SectionHeader
        number="04"
        title="Agent Simulation: What Happens When Someone Asks ChatGPT"
      />
      {/* New format */}
      {simulation && <L2SimulationView sim={simulation} />}
      {/* Legacy format */}
      {!simulation && simulations && simulations.map((sim, i) => (
        <LegacySimulationCard key={i} sim={sim} />
      ))}
    </section>
  );
}
