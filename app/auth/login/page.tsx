"use client";

import { Suspense, useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useSearchParams } from "next/navigation";

const BG     = "#faf8f5";
const CARD   = "#ffffff";
const BORDER = "rgba(0,0,0,0.07)";
const TEXT   = "#1c1917";
const TEXT_2 = "#78716c";
const TEXT_3 = "#a8a29e";
const ACCENT = "#b45309";
const RED    = "#dc2626";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirectTo");
  const switchAccount = searchParams.get("switch");
  const errorParam = searchParams.get("error");
  const [email, setEmail] = useState("");

  // If ?switch=1, sign out any existing session so a different user can log in
  useEffect(() => {
    if (switchAccount) {
      createClient().auth.signOut().catch(() => {});
    }
  }, [switchAccount]);
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const initialError = (() => {
    switch (errorParam) {
      case "server-misconfigured": return "We can't sign you in right now — server configuration issue. Please try again shortly.";
      case "exchange-expired":     return "Your sign-in link has expired. Please request a new code.";
      case "invalid-exchange":     return "Invalid sign-in link. Please request a new code.";
      default:                     return null;
    }
  })();
  const [error, setError] = useState<string | null>(initialError);
  const [requiresConsent, setRequiresConsent] = useState(false);
  const [tosAccepted, setTosAccepted] = useState(false);
  const [consentLoading, setConsentLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;

    setLoading(true);
    setError(null);

    const supabase = createClient();
    // OTP-only: do NOT pass emailRedirectTo. When emailRedirectTo is set,
    // Supabase's default Magic Link template embeds a {{ .ConfirmationURL }}
    // alongside the {{ .Token }}, and email link-scanners (Gmail, Outlook,
    // corporate gateways) prefetch the URL and consume the single-use token
    // BEFORE the user types the 6-digit code — so verifyOtp then returns
    // "Token has expired or is invalid" on the correct OTP. The OTP template
    // must also be stripped of {{ .ConfirmationURL }} in the Supabase
    // dashboard to fully close this hole.
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        shouldCreateUser: true,
      },
    });

    setLoading(false);

    if (otpError) {
      setError(otpError.message);
      return;
    }

    setSent(true);
  }

  function resolveRedirectDest(): string {
    return redirectTo && /^\/[a-zA-Z0-9\-_/?=&#%[\]]+$/.test(redirectTo)
      ? redirectTo
      : "/dashboard";
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    if (!otp.trim()) return;

    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { error: verifyError } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: otp.trim(),
      type: "email",
    });

    if (verifyError) {
      setLoading(false);
      setError(verifyError.message);
      return;
    }

    // Check if user needs to accept TOS/EULA before proceeding
    try {
      const consentRes = await fetch("/api/consent");
      if (consentRes.ok) {
        const { hasConsent } = await consentRes.json() as { hasConsent: boolean };
        if (!hasConsent) {
          setLoading(false);
          setRequiresConsent(true);
          return;
        }
      }
    } catch {
      // Non-fatal — proceed to dashboard if consent check fails
    }

    window.location.href = resolveRedirectDest();
  }

  async function handleAcceptConsent(e: React.FormEvent) {
    e.preventDefault();
    if (!tosAccepted) {
      setError("You must accept the Terms and EULA to continue.");
      return;
    }

    setConsentLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tosAccepted: true }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setConsentLoading(false);
        setError(data.error ?? "Failed to record consent. Please try again.");
        return;
      }

      window.location.href = resolveRedirectDest();
    } catch {
      setConsentLoading(false);
      setError("Network error. Please try again.");
    }
  }

  return (
    <main style={{ minHeight: "100vh", background: BG, color: TEXT, fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      {/* Nav */}
      <nav style={{ borderBottom: `1px solid ${BORDER}`, padding: "16px 24px", display: "flex", alignItems: "center", background: CARD }}>
        <a href="/" style={{ fontWeight: 700, fontSize: "18px", color: TEXT, textDecoration: "none" }}>FlowBlinq GEO</a>
      </nav>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "calc(100vh - 57px)" }}>
      <div style={{ maxWidth: "400px", width: "100%", padding: "32px 24px" }}>

        {requiresConsent ? (
          <div>
            <div style={{ marginBottom: "28px" }}>
              <div style={{ fontSize: "20px", fontWeight: 700, marginBottom: "8px", color: TEXT }}>One last step</div>
              <div style={{ color: TEXT_2, fontSize: "14px", lineHeight: 1.6 }}>
                Review and accept our Terms and EULA to continue to your dashboard.
              </div>
            </div>

            <form onSubmit={handleAcceptConsent} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={tosAccepted}
                  onChange={(e) => { setTosAccepted(e.target.checked); setError(null); }}
                  style={{ marginTop: "3px", width: "16px", height: "16px", accentColor: ACCENT, flexShrink: 0 }}
                  aria-label="Accept Terms of Service and EULA"
                />
                <span style={{ fontSize: "13px", color: TEXT, lineHeight: 1.5 }}>
                  I agree to the{" "}
                  <a href="/terms" target="_blank" rel="noopener noreferrer" style={{ color: ACCENT, textDecoration: "underline" }}>
                    Terms of Service
                  </a>
                  {" "}and{" "}
                  <a href="/eula" target="_blank" rel="noopener noreferrer" style={{ color: ACCENT, textDecoration: "underline" }}>
                    EULA
                  </a>
                  .
                </span>
              </label>

              {error && (
                <div role="alert" style={{ color: RED, fontSize: "13px", paddingLeft: "4px" }}>{error}</div>
              )}

              <button
                type="submit"
                disabled={consentLoading || !tosAccepted}
                style={{
                  background: consentLoading || !tosAccepted ? TEXT_3 : ACCENT,
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: "15px",
                  padding: "14px",
                  borderRadius: "10px",
                  border: "none",
                  cursor: consentLoading || !tosAccepted ? "not-allowed" : "pointer",
                }}
              >
                {consentLoading ? "Saving..." : "Accept and continue"}
              </button>
            </form>
          </div>
        ) : sent ? (
          <div>
            <div style={{ textAlign: "center", marginBottom: "28px" }}>
              <div style={{ fontSize: "36px", marginBottom: "12px" }}>✉️</div>
              <div style={{ fontSize: "20px", fontWeight: 700, marginBottom: "8px", color: TEXT }}>Check your email</div>
              <div style={{ color: TEXT_2, fontSize: "14px", lineHeight: 1.6 }}>
                We sent a 6-digit code to <strong style={{ color: TEXT }}>{email}</strong>.<br />
                Enter it below to sign in.
              </div>
            </div>

            <form onSubmit={handleVerifyOtp} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <input
                type="text"
                inputMode="numeric"
                placeholder="6-digit code"
                value={otp}
                onChange={(e) => { setOtp(e.target.value); setError(null); }}
                autoFocus
                maxLength={6}
                style={{
                  background: CARD,
                  border: `1px solid ${error ? RED : BORDER}`,
                  borderRadius: "10px",
                  padding: "14px 18px",
                  color: TEXT,
                  fontSize: "24px",
                  letterSpacing: "0.3em",
                  textAlign: "center",
                  outline: "none",
                }}
              />

              {error && (
                <div role="alert" style={{ color: RED, fontSize: "13px", paddingLeft: "4px" }}>{error}</div>
              )}

              <button
                type="submit"
                disabled={loading || otp.trim().length < 6}
                style={{
                  background: loading || otp.trim().length < 6 ? TEXT_3 : ACCENT,
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: "15px",
                  padding: "14px",
                  borderRadius: "10px",
                  border: "none",
                  cursor: loading || otp.trim().length < 6 ? "not-allowed" : "pointer",
                }}
              >
                {loading ? "Verifying..." : "Verify Code"}
              </button>
            </form>

            <div style={{ marginTop: "20px", textAlign: "center" }}>
              <button
                onClick={() => { setSent(false); setOtp(""); setError(null); }}
                style={{ background: "transparent", border: "none", color: TEXT_2, fontSize: "13px", cursor: "pointer" }}
              >
                ← Use a different email
              </button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ marginBottom: "32px" }}>
              <div style={{ fontSize: "22px", fontWeight: 800, marginBottom: "8px", color: TEXT }}>Sign in</div>
              <div style={{ color: TEXT_2, fontSize: "14px" }}>
                Enter your email and we'll send you a verification code.
              </div>
            </div>

            <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <input
                type="email"
                placeholder="you@yourcompany.com"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setError(null); }}
                autoFocus
                required
                style={{
                  background: CARD,
                  border: `1px solid ${error ? RED : BORDER}`,
                  borderRadius: "10px",
                  padding: "14px 18px",
                  color: TEXT,
                  fontSize: "16px",
                  outline: "none",
                }}
              />

              {error && (
                <div role="alert" style={{ color: RED, fontSize: "13px", paddingLeft: "4px" }}>{error}</div>
              )}

              <button
                type="submit"
                disabled={loading || !email.trim()}
                style={{
                  background: loading || !email.trim() ? TEXT_3 : ACCENT,
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: "15px",
                  padding: "14px",
                  borderRadius: "10px",
                  border: "none",
                  cursor: loading || !email.trim() ? "not-allowed" : "pointer",
                  transition: "background 0.2s",
                }}
              >
                {loading ? "Sending..." : "Send Code"}
              </button>
            </form>

            <div style={{ marginTop: "24px", textAlign: "center" }}>
              <a href="/" style={{ color: TEXT_2, fontSize: "13px", textDecoration: "none" }}>
                ← Back to home
              </a>
            </div>
          </>
        )}
      </div>
      </div>
    </main>
  );
}
