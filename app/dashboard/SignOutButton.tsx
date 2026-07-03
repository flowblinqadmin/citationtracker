"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function SignOutButton() {
  const router = useRouter();

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    sessionStorage.removeItem("geo-authed");
    Object.keys(localStorage).filter(k => k.startsWith("sb-")).forEach(k => localStorage.removeItem(k));
    const websiteUrl = process.env.NEXT_PUBLIC_WEBSITE_URL || "https://www.flowblinq.com";
    window.location.href = `${websiteUrl}/login`;
  }

  return (
    <button
      onClick={handleSignOut}
      style={{
        background: "transparent",
        border: "1px solid rgba(194, 101, 42, 0.25)",
        borderRadius: 8,
        padding: "6px 14px",
        color: "#c2652a",
        fontSize: 13,
        fontFamily: "inherit",
        cursor: "pointer",
        transition: "background 0.2s",
      }}
    >
      Sign out
    </button>
  );
}
