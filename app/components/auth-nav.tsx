"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

export function AuthNav() {
  const [isAuthenticated, setIsAuthenticated] = useState(() =>
    typeof window !== "undefined" && sessionStorage.getItem("geo-authed") === "1"
  );

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      const user = data.session?.user ?? null;
      if (user) {
        sessionStorage.setItem("geo-authed", "1");
        setIsAuthenticated(true);
      } else {
        sessionStorage.removeItem("geo-authed");
        setIsAuthenticated(false);
      }
    }).catch(() => {});
  }, []);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    sessionStorage.removeItem("geo-authed");
    Object.keys(localStorage)
      .filter((k) => k.startsWith("sb-"))
      .forEach((k) => localStorage.removeItem(k));
    setIsAuthenticated(false);
    window.location.href = "/auth/login";
  }

  return (
    <div>
      {isAuthenticated ? (
        <button
          onClick={handleSignOut}
          style={{
            fontSize: "13px",
            fontWeight: 600,
            color: "#78716c",
            background: "#ffffff",
            border: "1px solid rgba(0,0,0,0.07)",
            borderRadius: "8px",
            padding: "6px 14px",
            cursor: "pointer",
            fontFamily: "system-ui, -apple-system, sans-serif",
            boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
          }}
        >
          Sign out
        </button>
      ) : (
        <a
          href="/auth/login"
          style={{
            fontSize: "13px",
            fontWeight: 600,
            color: "#ffffff",
            background: "#b45309",
            border: "none",
            borderRadius: "8px",
            padding: "6px 14px",
            textDecoration: "none",
            fontFamily: "system-ui, -apple-system, sans-serif",
            boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
            display: "inline-block",
          }}
        >
          Sign in
        </a>
      )}
    </div>
  );
}
