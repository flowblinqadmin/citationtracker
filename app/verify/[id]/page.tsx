"use client";

import { useState, useRef, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

interface PageProps { params: Promise<{ id: string }>; }

export default function VerifyPage({ params }: PageProps) {
  const { id: siteId } = use(params);
  const router = useRouter();
  const [code, setCode] = useState(["", "", "", "", "", ""]);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [maskedEmail, setMaskedEmail] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resendSuccess, setResendSuccess] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // TOS consent checkbox
  const [tosAccepted, setTosAccepted] = useState(false);

  useEffect(() => {
    fetch(`/api/sites/${siteId}/info`)
      .then((r) => r.ok ? r.json() as Promise<{ maskedEmail?: string }> : null)
      .then((data) => { if (data?.maskedEmail) setMaskedEmail(data.maskedEmail); })
      .catch(() => {});
  }, [siteId]);

  function handleInput(index: number, value: string) {
    const digit = value.replace(/\D/g, '').slice(-1);
    const newCode = [...code];
    newCode[index] = digit;
    setCode(newCode);
    setError(null);
    if (digit && index < 5) inputRefs.current[index + 1]?.focus();
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent) {
    if (e.key === "Backspace" && !code[index] && index > 0) inputRefs.current[index - 1]?.focus();
  }

  function handlePaste(e: React.ClipboardEvent) {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (pasted.length === 6) { setCode(pasted.split("")); inputRefs.current[5]?.focus(); }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const fullCode = code.join("");
    if (fullCode.length !== 6) { setError("Please enter the 6-digit code"); return; }
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: fullCode, tosAccepted: tosAccepted || undefined }),
      });
      const data = await res.json() as {
        siteId?: string; accessToken?: string; error?: string;
        authOtp?: string; email?: string; exchangeCode?: string;
        requiresConsent?: boolean;
      };
      if (!res.ok) { setError(data.error ?? "Invalid code. Check your email and try again."); return; }
      if (data.accessToken && data.siteId) {
        sessionStorage.setItem(`geo-token-${data.siteId}`, data.accessToken);
      }
      // Sign into Supabase so dashboard/upgrade work without re-login.
      if (data.authOtp) {
        try {
          const tokens = JSON.parse(data.authOtp) as { access_token?: string; refresh_token?: string };
          if (tokens.access_token && tokens.refresh_token) {
            const supabase = createClient();
            await supabase.auth.signOut();
            await supabase.auth.setSession({
              access_token: tokens.access_token,
              refresh_token: tokens.refresh_token,
            });
          }
        } catch {
          // Non-fatal — user can still view results via accessToken
        }
      }

      // Use exchange code route (sets session via cookie, no token in URL)
      if (data.exchangeCode) {
        window.location.href = `/auth/exchange?code=${encodeURIComponent(data.exchangeCode)}`;
      } else {
        router.replace(`/sites/${data.siteId ?? siteId}?token=${data.accessToken ?? ''}`);
      }
    } catch { setError("Network error. Please try again."); }
    finally { setLoading(false); }
  }

  async function handleResend() {
    if (!email) { setError("Enter your email address to resend the code."); return; }
    setResending(true); setResendSuccess(false); setError(null);
    try {
      await fetch("/api/sites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://placeholder.flowblinq.com", email }),
      });
      setResendSuccess(true);
      setTimeout(() => setResendSuccess(false), 5000);
    } catch { setError("Failed to resend. Please try again."); }
    finally { setResending(false); }
  }

  const inputStyle: React.CSSProperties = {
    width: "52px", height: "64px", background: "#0a0a0a", border: "1px solid #222",
    borderRadius: "10px", color: "#fff", fontSize: "24px", fontWeight: 700, textAlign: "center", outline: "none",
  };
  const isCodeComplete = code.join("").length === 6;

  return (
    <main style={{ minHeight: "100vh", background: "#000", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ maxWidth: "440px", width: "100%", padding: "24px" }}>
        <div style={{ textAlign: "center", marginBottom: "40px" }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>✉</div>
          <h1 style={{ fontSize: '24px', fontWeight: 700, margin: '0 0 8px' }}>Check your email</h1>
          <p style={{ color: '#666', fontSize: '15px', lineHeight: 1.6 }}>
            {maskedEmail
              ? (<>We sent a 6-digit code to <strong style={{ color: '#fff' }}>{maskedEmail}</strong>. Enter it below.</>)
              : 'We sent a 6-digit verification code. Enter it below to start your AI audit.'}
          </p>
        </div>
        {error && (
          <div style={{ background: '#1a0000', border: '1px solid #440000', borderRadius: '8px', padding: '12px 16px', marginBottom: '20px' }}>
            <p style={{ color: '#ef4444', margin: 0, fontSize: '14px' }}>{error}</p>
          </div>
        )}
        {resendSuccess && (
          <div style={{ background: '#001a00', border: '1px solid #004400', borderRadius: '8px', padding: '12px 16px', marginBottom: '20px' }}>
            <p style={{ color: '#22c55e', margin: 0, fontSize: '14px' }}>Code resent! Check your email.</p>
          </div>
        )}
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', marginBottom: '24px' }} onPaste={handlePaste}>
            {code.map((digit, i) => (
              <input key={i} ref={(el) => { inputRefs.current[i] = el; }}
                type='text' inputMode='numeric' maxLength={1} value={digit}
                onChange={(e) => handleInput(i, e.target.value)} onKeyDown={(e) => handleKeyDown(i, e)}
                style={inputStyle} autoFocus={i === 0}
              />
            ))}
          </div>
          <label style={{
            display: 'flex', alignItems: 'flex-start', gap: '10px',
            padding: '12px 14px', background: '#0a0a0a', border: '1px solid #222',
            borderRadius: '10px', cursor: 'pointer', marginBottom: '16px',
          }}>
            <input
              type="checkbox"
              checked={tosAccepted}
              onChange={(e) => setTosAccepted(e.target.checked)}
              style={{ marginTop: '2px', width: '16px', height: '16px', accentColor: '#fff', flexShrink: 0 }}
            />
            <span style={{ color: '#999', fontSize: '12px', lineHeight: 1.5 }}>
              I agree to the{' '}
              <a href="https://www.flowblinq.com/terms" target="_blank" rel="noopener noreferrer"
                 style={{ color: '#ccc', textDecoration: 'underline' }}>Terms of Service</a>
              {' '}and{' '}
              <a href="https://www.flowblinq.com/eula" target="_blank" rel="noopener noreferrer"
                 style={{ color: '#ccc', textDecoration: 'underline' }}>EULA</a>
            </span>
          </label>
          <button type='submit' disabled={loading || !isCodeComplete || !tosAccepted}
            style={{ width: '100%', background: loading || !isCodeComplete || !tosAccepted ? '#222' : '#fff', color: loading || !isCodeComplete || !tosAccepted ? '#666' : '#000', fontWeight: 700, fontSize: '16px', padding: '14px', borderRadius: '10px', border: 'none', cursor: loading || !tosAccepted ? 'not-allowed' : 'pointer', marginBottom: '24px' }}>
            {loading ? 'Verifying...' : 'Verify & Start Audit'}
          </button>
        </form>
        <div style={{ borderTop: '1px solid #1a1a1a', paddingTop: '24px' }}>
          <p style={{ color: '#666', fontSize: '13px', marginBottom: '12px', textAlign: 'center' }}>Did not receive the code?</p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input type='email' placeholder='Enter your email' value={email} onChange={(e) => setEmail(e.target.value)}
              style={{ flex: 1, background: '#0a0a0a', border: '1px solid #222', borderRadius: '8px', color: '#fff', padding: '10px 14px', fontSize: '14px', outline: 'none' }}
            />
            <button onClick={handleResend} disabled={resending}
              style={{ background: '#1a1a1a', color: resending ? '#666' : '#fff', border: '1px solid #333', borderRadius: '8px', padding: '10px 16px', fontSize: '13px', fontWeight: 600, cursor: resending ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}>
              {resending ? 'Sending...' : 'Resend code'}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
