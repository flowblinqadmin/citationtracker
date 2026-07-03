"use client";

import { useEffect, useState, useCallback } from "react";

// ── Design tokens (match dashboard/page.tsx) ─────────────────────────────────
const CARD    = "#ffffff";
const TEXT    = "#1c1917";
const TEXT_2  = "#78716c";
const ACCENT  = "#b45309";
const BORDER  = "rgba(0,0,0,0.07)";
const RED     = "#dc2626";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ApiClient {
  client_id: string;
  name: string;
  scopes: string[];
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface NewCredentials {
  client_id: string;
  client_secret: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ApiAccessSection({ teamId }: { teamId: string }) {
  const [clients, setClients] = useState<ApiClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Generate-key modal state
  const [showGenerate, setShowGenerate] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [generating, setGenerating] = useState(false);
  const [newCredentials, setNewCredentials] = useState<NewCredentials | null>(null);

  // Revoke confirm state
  const [revokeTarget, setRevokeTarget] = useState<ApiClient | null>(null);
  const [revoking, setRevoking] = useState(false);

  const fetchClients = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/teams/${teamId}/api-clients`);
      if (!res.ok) throw new Error("Failed to load API keys");
      const data: ApiClient[] = await res.json();
      setClients(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => { fetchClients(); }, [fetchClients]);

  // ── Generate new key ────────────────────────────────────────────────────────

  async function handleGenerate() {
    if (!keyName.trim()) return;
    setGenerating(true);
    try {
      const res = await fetch(`/api/teams/${teamId}/api-clients`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: keyName.trim() }),
      });
      if (!res.ok) throw new Error("Failed to create API key");
      const data: NewCredentials = await res.json();
      setNewCredentials(data);
      setKeyName("");
      setShowGenerate(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to create key");
    } finally {
      setGenerating(false);
    }
  }

  function handleCredentialsDismiss() {
    setNewCredentials(null);
    fetchClients();
  }

  // ── Revoke ──────────────────────────────────────────────────────────────────

  async function handleRevoke() {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      const res = await fetch(
        `/api/teams/${teamId}/api-clients/${revokeTarget.client_id}`,
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error("Failed to revoke key");
      setRevokeTarget(null);
      fetchClients();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to revoke key");
    } finally {
      setRevoking(false);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function fmtDate(iso: string | null): string {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <section style={{ marginTop: "56px" }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" }}>
        <div>
          <h2 style={{ fontSize: "20px", fontWeight: 800, margin: "0 0 4px", color: TEXT }}>API Access</h2>
          <p style={{ color: TEXT_2, fontSize: "14px", margin: 0 }}>
            Manage API keys for external integrations (WordPress plugin, CI/CD, custom scripts).
          </p>
        </div>
        <button
          onClick={() => setShowGenerate(true)}
          style={{
            background: ACCENT,
            color: "#fff",
            border: "none",
            borderRadius: "8px",
            padding: "9px 18px",
            fontSize: "14px",
            fontWeight: 600,
            cursor: "pointer",
            whiteSpace: "nowrap",
            flexShrink: 0,
            marginLeft: "16px",
          }}
        >
          + Generate new key
        </button>
      </div>

      {/* Table card */}
      <div style={{
        background: CARD,
        border: `1px solid ${BORDER}`,
        borderRadius: "16px",
        overflow: "hidden",
      }}>
        {loading ? (
          <div style={{ padding: "40px", textAlign: "center", color: TEXT_2, fontSize: "14px" }}>
            Loading…
          </div>
        ) : error ? (
          <div style={{ padding: "40px", textAlign: "center", color: RED, fontSize: "14px" }}>
            {error}
          </div>
        ) : clients.length === 0 ? (
          <div style={{ padding: "56px 32px", textAlign: "center" }}>
            <div style={{ fontSize: "32px", marginBottom: "12px" }}>🔑</div>
            <div style={{ fontSize: "16px", fontWeight: 700, color: TEXT, marginBottom: "6px" }}>
              No API keys yet
            </div>
            <div style={{ color: TEXT_2, fontSize: "14px" }}>
              Generate one to get started.
            </div>
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${BORDER}`, background: "#faf8f5" }}>
                {["Name", "Client ID", "Created", "Last used", "Status", ""].map((h) => (
                  <th
                    key={h}
                    style={{
                      padding: "10px 16px",
                      textAlign: "left",
                      fontWeight: 600,
                      color: TEXT_2,
                      fontSize: "12px",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {clients.map((c, i) => {
                const isRevoked = !!c.revoked_at;
                return (
                  <tr
                    key={c.client_id}
                    style={{
                      borderBottom: i < clients.length - 1 ? `1px solid ${BORDER}` : "none",
                      opacity: isRevoked ? 0.6 : 1,
                    }}
                  >
                    <td style={{ padding: "12px 16px", fontWeight: 600, color: TEXT }}>
                      {c.name}
                    </td>
                    <td style={{ padding: "12px 16px", color: TEXT_2, fontFamily: "monospace", fontSize: "12px" }}>
                      {c.client_id}
                    </td>
                    <td style={{ padding: "12px 16px", color: TEXT_2 }}>
                      {fmtDate(c.created_at)}
                    </td>
                    <td style={{ padding: "12px 16px", color: TEXT_2 }}>
                      {fmtDate(c.last_used_at)}
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      {isRevoked ? (
                        <span style={{ color: TEXT_2, fontStyle: "italic", fontSize: "13px" }}>Revoked</span>
                      ) : (
                        <span style={{
                          display: "inline-block",
                          background: "#d1fae5",
                          color: "#065f46",
                          borderRadius: "100px",
                          padding: "2px 10px",
                          fontSize: "12px",
                          fontWeight: 600,
                        }}>
                          Active
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "12px 16px", textAlign: "right" }}>
                      {!isRevoked && (
                        <button
                          onClick={() => setRevokeTarget(c)}
                          style={{
                            background: "transparent",
                            border: `1px solid rgba(220,38,38,0.35)`,
                            color: RED,
                            borderRadius: "6px",
                            padding: "4px 12px",
                            fontSize: "13px",
                            cursor: "pointer",
                          }}
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Generate key modal ─────────────────────────────────────────────────── */}
      {showGenerate && (
        <Modal onClose={() => { setShowGenerate(false); setKeyName(""); }}>
          <h3 style={{ margin: "0 0 16px", fontSize: "18px", fontWeight: 700, color: TEXT }}>
            Generate new API key
          </h3>
          <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: TEXT_2, marginBottom: "6px" }}>
            Key name
          </label>
          <input
            type="text"
            placeholder="e.g. WordPress Plugin, CI Runner"
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleGenerate(); }}
            autoFocus
            style={{
              display: "block",
              width: "100%",
              boxSizing: "border-box",
              border: `1px solid ${BORDER}`,
              borderRadius: "8px",
              padding: "10px 12px",
              fontSize: "14px",
              color: TEXT,
              marginBottom: "20px",
              outline: "none",
            }}
          />
          <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
            <button
              onClick={() => { setShowGenerate(false); setKeyName(""); }}
              style={secondaryBtn}
            >
              Cancel
            </button>
            <button
              onClick={handleGenerate}
              disabled={!keyName.trim() || generating}
              style={{
                ...primaryBtn,
                opacity: !keyName.trim() || generating ? 0.6 : 1,
                cursor: !keyName.trim() || generating ? "not-allowed" : "pointer",
              }}
            >
              {generating ? "Generating…" : "Generate"}
            </button>
          </div>
        </Modal>
      )}

      {/* ── New credentials modal (one-time display) ──────────────────────────── */}
      {newCredentials && (
        <Modal onClose={handleCredentialsDismiss}>
          <h3 style={{ margin: "0 0 8px", fontSize: "18px", fontWeight: 700, color: TEXT }}>
            Your new API credentials
          </h3>
          <p style={{ color: RED, fontSize: "13px", fontWeight: 600, margin: "0 0 20px" }}>
            Copy these credentials now — the secret will not be shown again.
          </p>
          <CredentialField label="Client ID" value={newCredentials.client_id} />
          <CredentialField label="Client Secret" value={newCredentials.client_secret} mono />
          <div style={{ marginTop: "24px", textAlign: "right" }}>
            <button onClick={handleCredentialsDismiss} style={primaryBtn}>
              Done — I&apos;ve copied my credentials
            </button>
          </div>
        </Modal>
      )}

      {/* ── Revoke confirm modal ───────────────────────────────────────────────── */}
      {revokeTarget && (
        <Modal onClose={() => !revoking && setRevokeTarget(null)}>
          <h3 style={{ margin: "0 0 12px", fontSize: "18px", fontWeight: 700, color: TEXT }}>
            Revoke this key?
          </h3>
          <p style={{ color: TEXT_2, fontSize: "14px", margin: "0 0 6px" }}>
            <strong style={{ color: TEXT }}>{revokeTarget.name}</strong>
          </p>
          <p style={{ color: TEXT_2, fontSize: "14px", margin: "0 0 24px" }}>
            Any apps using this key will immediately lose access. This cannot be undone.
          </p>
          <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
            <button
              onClick={() => setRevokeTarget(null)}
              disabled={revoking}
              style={secondaryBtn}
            >
              Cancel
            </button>
            <button
              onClick={handleRevoke}
              disabled={revoking}
              style={{
                background: RED,
                color: "#fff",
                border: "none",
                borderRadius: "8px",
                padding: "9px 18px",
                fontSize: "14px",
                fontWeight: 600,
                cursor: revoking ? "not-allowed" : "pointer",
                opacity: revoking ? 0.7 : 1,
              }}
            >
              {revoking ? "Revoking…" : "Revoke key"}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

// ── Shared button styles ──────────────────────────────────────────────────────

const primaryBtn: React.CSSProperties = {
  background: ACCENT,
  color: "#fff",
  border: "none",
  borderRadius: "8px",
  padding: "9px 18px",
  fontSize: "14px",
  fontWeight: 600,
  cursor: "pointer",
};

const secondaryBtn: React.CSSProperties = {
  background: "transparent",
  border: `1px solid ${BORDER}`,
  color: TEXT_2,
  borderRadius: "8px",
  padding: "9px 18px",
  fontSize: "14px",
  cursor: "pointer",
};

// ── Modal ─────────────────────────────────────────────────────────────────────

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
    >
      <div style={{
        background: CARD,
        borderRadius: "16px",
        padding: "28px",
        width: "100%",
        maxWidth: "440px",
        boxShadow: "0 20px 60px rgba(0,0,0,0.15)",
        position: "relative",
      }}>
        <button
          onClick={onClose}
          style={{
            position: "absolute",
            top: "16px",
            right: "16px",
            background: "transparent",
            border: "none",
            fontSize: "18px",
            cursor: "pointer",
            color: TEXT_2,
            lineHeight: 1,
          }}
          aria-label="Close"
        >
          ×
        </button>
        {children}
      </div>
    </div>
  );
}

// ── Credential field with copy button ─────────────────────────────────────────

function CredentialField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div style={{ marginBottom: "16px" }}>
      <div style={{ fontSize: "12px", fontWeight: 600, color: TEXT_2, marginBottom: "4px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </div>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        background: "#f5f5f4",
        borderRadius: "8px",
        padding: "10px 12px",
        border: `1px solid ${BORDER}`,
      }}>
        <span style={{
          flex: 1,
          fontFamily: mono ? "monospace" : "inherit",
          fontSize: "13px",
          color: TEXT,
          overflowWrap: "anywhere",
          wordBreak: "break-all",
        }}>
          {value}
        </span>
        <button
          onClick={handleCopy}
          style={{
            background: "transparent",
            border: `1px solid ${BORDER}`,
            borderRadius: "6px",
            padding: "4px 10px",
            fontSize: "12px",
            cursor: "pointer",
            color: copied ? "#065f46" : TEXT_2,
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
    </div>
  );
}
