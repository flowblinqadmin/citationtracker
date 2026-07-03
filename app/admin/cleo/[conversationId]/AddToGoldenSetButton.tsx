"use client";

import { useState } from "react";

const COPPER = "#c2652a";
const BORDER = "#e5e5ea";
const TEXT = "#1d1d1f";
const T2 = "#86868b";
const FONT_STACK = "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

export default function AddToGoldenSetButton({
  conversationId,
  isProd,
  defaultExpected,
}: {
  conversationId: string;
  isProd: boolean;
  defaultExpected: string;
}) {
  const [open, setOpen] = useState(false);
  const [expected, setExpected] = useState(defaultExpected);
  const [mustContain, setMustContain] = useState("");
  const [mustNotContain, setMustNotContain] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  if (isProd) {
    return (
      <button
        type="button"
        disabled
        title="Add-to-golden-set runs locally only — write target eval/failures/curated.jsonl is read-only on Vercel. Pull this conversation locally via npm run dev against prod DB."
        style={{
          padding: "8px 14px", borderRadius: 8, border: `1px solid ${BORDER}`,
          background: "#f5f5f7", color: T2, fontFamily: FONT_STACK, fontSize: 13,
          cursor: "not-allowed",
        }}
      >
        Add to golden set (local only)
      </button>
    );
  }

  const submit = async () => {
    setPending(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/cleo/golden", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          expectedAnswer: expected,
          mustContain: splitList(mustContain),
          mustNotContain: splitList(mustNotContain),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setResult({ ok: true, msg: `Added as ${data.id}` });
      } else {
        setResult({ ok: false, msg: data.error ?? `HTTP ${res.status}` });
      }
    } catch (err) {
      setResult({ ok: false, msg: err instanceof Error ? err.message : "Failed" });
    } finally {
      setPending(false);
    }
  };

  return (
    <div>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{
            padding: "8px 14px", borderRadius: 8, border: `1px solid ${COPPER}`,
            background: COPPER, color: "#fff", fontFamily: FONT_STACK, fontSize: 13,
            cursor: "pointer",
          }}
        >
          Add to golden set
        </button>
      )}
      {open && (
        <div style={{ border: `1px solid ${BORDER}`, borderRadius: 8, padding: 12, background: "#fff", maxWidth: 640 }}>
          <label style={labelStyle}>Expected answer (human-curated)</label>
          <textarea
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
            rows={4}
            style={textareaStyle}
          />
          <label style={labelStyle}>Must contain (comma-separated)</label>
          <input
            value={mustContain}
            onChange={(e) => setMustContain(e.target.value)}
            style={inputStyle}
            placeholder="vercel.json, rewrites"
          />
          <label style={labelStyle}>Must NOT contain (comma-separated)</label>
          <input
            value={mustNotContain}
            onChange={(e) => setMustNotContain(e.target.value)}
            style={inputStyle}
            placeholder="I don't have specific information"
          />
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              type="button"
              onClick={submit}
              disabled={pending}
              style={{
                padding: "8px 14px", borderRadius: 8, border: `1px solid ${COPPER}`,
                background: COPPER, color: "#fff", fontFamily: FONT_STACK, fontSize: 13,
                cursor: pending ? "wait" : "pointer", opacity: pending ? 0.6 : 1,
              }}
            >
              {pending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => { setOpen(false); setResult(null); }}
              style={{
                padding: "8px 14px", borderRadius: 8, border: `1px solid ${BORDER}`,
                background: "#fff", color: TEXT, fontFamily: FONT_STACK, fontSize: 13,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
          {result && (
            <div style={{ marginTop: 10, fontSize: 12, color: result.ok ? "#047857" : "#b91c1c" }}>
              {result.ok ? "✓ " : "✗ "}{result.msg}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function splitList(s: string): string[] {
  return s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

const labelStyle: React.CSSProperties = { display: "block", fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: "0.4px", marginTop: 8, marginBottom: 4 };
const textareaStyle: React.CSSProperties = {
  width: "100%", border: `1px solid ${BORDER}`, borderRadius: 6,
  padding: "8px 10px", fontSize: 13, fontFamily: FONT_STACK, color: TEXT,
  background: "#fafafa", outline: "none", resize: "vertical",
};
const inputStyle: React.CSSProperties = {
  width: "100%", border: `1px solid ${BORDER}`, borderRadius: 6,
  padding: "8px 10px", fontSize: 13, fontFamily: FONT_STACK, color: TEXT,
  background: "#fafafa", outline: "none",
};
