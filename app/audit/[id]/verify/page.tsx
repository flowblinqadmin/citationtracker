"use client";

import { useState, useRef, use } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIsEmbedded } from "@/lib/use-embedded";

export default function VerifyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const isEmbedded = useIsEmbedded();
  const [code, setCode] = useState(["", "", "", "", "", ""]);
  const [error, setError] = useState("");
  const [verifying, setVerifying] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  function handleChange(index: number, value: string) {
    if (!/^\d*$/.test(value)) return;
    const newCode = [...code];
    newCode[index] = value.slice(-1);
    setCode(newCode);

    // Auto-advance to next input
    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto-submit when all 6 digits entered
    const fullCode = newCode.join("");
    if (fullCode.length === 6) {
      submitCode(fullCode);
    }
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent) {
    if (e.key === "Backspace" && !code[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (pasted.length === 4) {
      setCode(pasted.split(""));
      submitCode(pasted);
    }
  }

  async function submitCode(codeStr: string) {
    setVerifying(true);
    setError("");

    try {
      const res = await fetch(`/api/audit/${id}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: codeStr }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Verification failed");

      router.push(`/audit/${id}`);
    } catch (err) {
      setError((err as Error).message);
      setCode(["", "", "", "", "", ""]);
      inputRefs.current[0]?.focus();
      setVerifying(false);
    }
  }

  return (
    <div className={`${isEmbedded ? "" : "min-h-screen"} flex flex-col`}>
      {!isEmbedded && (
        <header className="border-b border-border py-4 px-6">
          <div className="max-w-5xl mx-auto">
            <div className="flex items-center gap-2">
              <img src="/logo.jpg" alt="" className="h-8 w-8 rounded-full" />
              <span
                className="text-xl font-bold text-orange-500"
                style={{ fontFamily: "'Instrument Serif', Georgia, serif" }}
              >
                FlowBlinq
              </span>
            </div>
          </div>
        </header>
      )}

      <main className={`flex-1 flex items-center justify-center ${isEmbedded ? "p-2" : "p-6"}`}>
        <div className="max-w-md w-full text-center space-y-6">
          <div className="w-16 h-16 rounded-full bg-orange-500/10 flex items-center justify-center mx-auto">
            <Mail className="w-8 h-8 text-orange-500" />
          </div>

          <div className="space-y-2">
            <h1
              className="text-2xl font-bold text-foreground"
              style={{ fontFamily: "'Instrument Serif', Georgia, serif" }}
            >
              Check your email
            </h1>
            <p className="text-sm text-muted-foreground">
              We sent a 6-digit verification code to your email. Enter it
              below to start your audit.
            </p>
          </div>

          <div className="flex justify-center gap-2" onPaste={handlePaste}>
            {code.map((digit, i) => (
              <input
                key={i}
                ref={(el) => { inputRefs.current[i] = el; }}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={digit}
                onChange={(e) => handleChange(i, e.target.value)}
                onKeyDown={(e) => handleKeyDown(i, e)}
                autoFocus={i === 0}
                className="w-12 h-14 text-center text-2xl font-bold font-mono rounded-xl border border-border bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
              />
            ))}
          </div>

          {error && (
            <p className="text-sm text-red-400">{error}</p>
          )}

          {verifying && (
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Verifying...
            </div>
          )}

          <Button
            onClick={() => {
              const fullCode = code.join("");
              if (fullCode.length === 6) submitCode(fullCode);
            }}
            disabled={code.join("").length < 6 || verifying}
            className="bg-orange-500 hover:bg-orange-600"
          >
            Verify & Start Audit <ArrowRight className="w-4 h-4" />
          </Button>

          <p className="text-xs text-muted-foreground">
            Code expires in 15 minutes.{" "}
            <button
              className="text-orange-500 hover:underline"
              onClick={() => {
                // Re-create the audit to get a new code
                window.history.back();
              }}
            >
              Resend code
            </button>
          </p>
        </div>
      </main>
    </div>
  );
}
