"use client";
import React from "react";
import { createPortal } from "react-dom";
import { CARD, BORDER, TEXT, T2, COPPER } from "../design-tokens";

interface ConfirmCreditModalProps {
  action: string;
  description: string;
  cost: number;
  balance: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmCreditModal({
  action,
  description,
  cost,
  balance,
  onConfirm,
  onCancel,
}: ConfirmCreditModalProps) {
  const canAfford = balance >= cost;

  // Auto-confirm if user previously chose "don't ask again"
  React.useEffect(() => {
    if (
      typeof window !== "undefined" &&
      sessionStorage.getItem("skip-credit-confirm") === "1"
    ) {
      onConfirm();
    }
  }, [onConfirm]);

  // Render nothing until we know whether to skip (effect runs after first render)
  // We still render the modal — the effect will immediately call onConfirm if skip flag is set
  if (
    typeof window !== "undefined" &&
    sessionStorage.getItem("skip-credit-confirm") === "1"
  ) {
    return null;
  }

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: CARD,
          borderRadius: 16,
          padding: "24px 28px",
          maxWidth: 400,
          width: "90%",
          boxShadow: "0 20px 60px rgba(0,0,0,0.15)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ fontSize: 16, fontWeight: 600, color: TEXT, margin: "0 0 8px" }}>
          {action}
        </h3>
        <p style={{ fontSize: 13, color: T2, margin: "0 0 16px", lineHeight: 1.5 }}>
          {description}
        </p>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "12px 0",
            borderTop: `1px solid ${BORDER}`,
            borderBottom: `1px solid ${BORDER}`,
            marginBottom: 16,
          }}
        >
          <span style={{ fontSize: 13, color: T2 }}>Cost</span>
          <span style={{ fontSize: 14, fontWeight: 600, color: COPPER }}>{cost} credits</span>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 20,
          }}
        >
          <span style={{ fontSize: 12, color: T2 }}>
            Balance after: {balance - cost} credits
          </span>
          <label
            style={{
              fontSize: 11,
              color: T2,
              display: "flex",
              alignItems: "center",
              gap: 4,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              onChange={(e) => {
                if (e.target.checked) {
                  sessionStorage.setItem("skip-credit-confirm", "1");
                } else {
                  sessionStorage.removeItem("skip-credit-confirm");
                }
              }}
            />
            Don&apos;t ask again
          </label>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              flex: 1,
              padding: "10px 16px",
              borderRadius: 8,
              border: `1px solid ${BORDER}`,
              background: CARD,
              color: TEXT,
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!canAfford}
            style={{
              flex: 1,
              padding: "10px 16px",
              borderRadius: 8,
              border: "none",
              background: canAfford ? COPPER : "#ccc",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              cursor: canAfford ? "pointer" : "not-allowed",
              fontFamily: "inherit",
            }}
          >
            {canAfford ? "Proceed" : "Not enough credits"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
