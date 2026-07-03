"use client";

import { useState } from "react";
import UpgradeModal from "@/app/components/UpgradeModal";

export default function BuyCreditsButton({ credits }: { credits: number }) {
  const [showModal, setShowModal] = useState(false);

  return (
    <>
      <button onClick={() => setShowModal(true)} style={{
        background: "#c2652a", color: "#fff", border: "none",
        borderRadius: 8, padding: "6px 14px",
        fontSize: 13, fontWeight: 600, cursor: "pointer",
        fontFamily: "inherit", transition: "opacity 0.2s",
      }}>
        {credits} credits
      </button>

      {showModal && (
        <UpgradeModal
          credits={credits}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
}
