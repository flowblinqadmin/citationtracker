"use client";

// Step 3 — review & select prompts, pick frequency, and see the honest credit
// meter (recomputed on every toggle). The meter is the ship-now innovation:
// prompts × 10 credits (per-model breakdown below), live balance, and a "buy
// credits" nudge when the first run would overdraw.
import { useState } from "react";
import { runCost, MAX_PROMPTS, BUY_CREDITS_FALLBACK } from "@/lib/onboarding";
import type { WizardPrompt } from "@/lib/onboarding";
import type { TrackerRunFrequency } from "@/lib/types/tracker";
import { UI } from "@/app/ui";

const CARD = UI.CARD;
const BORDER = UI.BORDER_CSS;
const MUTED = UI.T2;
const ACCENT = UI.COPPER;

const MAX_CUSTOM_LEN = 500;

export default function Step3Prompts({
  prompts,
  onPrompts,
  runFrequency,
  onFrequency,
  balance,
  buyCreditsUrl,
}: {
  prompts: WizardPrompt[];
  onPrompts: (p: WizardPrompt[]) => void;
  runFrequency: TrackerRunFrequency;
  onFrequency: (f: TrackerRunFrequency) => void;
  balance: number | null;
  buyCreditsUrl: string | null;
}) {
  const [custom, setCustom] = useState("");

  const selectedCount = prompts.filter((p) => p.selected).length;
  const cost = runCost(selectedCount).credits;
  const short = balance !== null && cost > balance ? cost - balance : 0;

  function toggle(i: number) {
    onPrompts(prompts.map((p, idx) => (idx === i ? { ...p, selected: !p.selected } : p)));
  }

  function addCustom() {
    const text = custom.trim();
    if (!text) return;
    if (prompts.length >= MAX_PROMPTS) return;
    onPrompts([...prompts, { name: text.split(/\s+/).slice(0, 6).join(" "), category: "topic", text, selected: true }]);
    setCustom("");
  }

  const buyHref = buyCreditsUrl ?? BUY_CREDITS_FALLBACK;

  return (
    <div>
      <h2 style={{ margin: 0, fontSize: 22 }}>Review &amp; select prompts</h2>
      <p style={{ color: MUTED, fontSize: 14, marginTop: 6 }}>
        We recommend at least 15 prompts for better data.
      </p>

      <p style={{ fontSize: 13, color: MUTED, marginTop: 16, fontWeight: 600 }}>
        {selectedCount}/{prompts.length} prompts selected
      </p>

      <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
        {prompts.map((p, i) => (
          <label
            key={i}
            style={{ display: "flex", gap: 10, alignItems: "flex-start", background: CARD, border: BORDER, borderRadius: 8, padding: "10px 12px", cursor: "pointer" }}
          >
            <input type="checkbox" checked={p.selected} onChange={() => toggle(i)} style={{ marginTop: 3 }} />
            <span style={{ fontSize: 14 }}>{p.text}</span>
          </label>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value.slice(0, MAX_CUSTOM_LEN))}
          placeholder="Add a custom prompt…"
          maxLength={MAX_CUSTOM_LEN}
          disabled={prompts.length >= MAX_PROMPTS}
          style={{ flex: 1, padding: "10px 12px", border: BORDER, borderRadius: 8, fontSize: 14 }}
        />
        <button
          onClick={addCustom}
          disabled={!custom.trim() || prompts.length >= MAX_PROMPTS}
          style={{ padding: "10px 18px", background: ACCENT, color: "#fff", border: "none", borderRadius: 8, fontSize: 14, cursor: "pointer", opacity: !custom.trim() || prompts.length >= MAX_PROMPTS ? 0.5 : 1 }}
        >
          Add
        </button>
      </div>
      {prompts.length >= MAX_PROMPTS && (
        <p style={{ color: MUTED, fontSize: 12, marginTop: 6 }}>Maximum of {MAX_PROMPTS} prompts.</p>
      )}

      <label style={{ display: "block", marginTop: 20, fontSize: 13, color: MUTED }}>
        Run frequency{" "}
        <select
          value={runFrequency}
          onChange={(e) => onFrequency(e.target.value as TrackerRunFrequency)}
          style={{ padding: "6px 8px", border: BORDER, borderRadius: 6, marginLeft: 6 }}
        >
          <option value="manual">Manual only</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
        </select>
      </label>

      {/* The credit meter — persistent, recomputed on every toggle. */}
      <div style={{ marginTop: 20, background: UI.COPPER_BG, border: `1px solid ${ACCENT}`, borderRadius: 12, padding: 16 }}>
        <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: ACCENT }}>
          {selectedCount} prompts × 10 credits = {cost} credits per run
        </p>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: MUTED }}>
          Per prompt: ChatGPT 2 · Perplexity 2 · Gemini 2 · Claude 4 credits
        </p>
        {balance !== null && (
          <p style={{ margin: "8px 0 0", fontSize: 13, color: MUTED }}>
            Balance: {balance} → after first run: {balance - cost}
          </p>
        )}
        {short > 0 && (
          <p style={{ margin: "8px 0 0", fontSize: 13, color: ACCENT }}>
            You&apos;re {short} credits short.{" "}
            <a href={buyHref} style={{ color: ACCENT, fontWeight: 600 }}>
              Buy credits
            </a>
          </p>
        )}
      </div>
    </div>
  );
}
