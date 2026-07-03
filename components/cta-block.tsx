"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface CtaBlockProps {
  platformDetected?: string | null;
}

export function CtaBlock({ platformDetected }: CtaBlockProps) {
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function handleClick() {
    setSubmitting(true);
    // Brief delay for visual feedback
    setTimeout(() => {
      setSubmitting(false);
      setSubmitted(true);
    }, 800);
  }

  if (submitted) {
    return (
      <div className="rounded-2xl bg-gradient-to-br from-green-500/15 to-green-600/5 border border-green-500/30 p-8 text-center space-y-4">
        <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center mx-auto">
          <CheckCircle2 className="w-8 h-8 text-green-500" />
        </div>
        <h3
          className="text-2xl font-bold text-foreground"
          style={{ fontFamily: "'Instrument Serif', Georgia, serif" }}
        >
          Thank you!
        </h3>
        <p className="text-muted-foreground max-w-lg mx-auto">
          We&apos;ll reach out very soon with your live{" "}
          {platformDetected ? (
            <strong className="text-foreground">{platformDetected}</strong>
          ) : (
            "store"
          )}{" "}
          integration for review and next steps.
        </p>
        <p className="text-sm text-muted-foreground">
          Expect to hear from us within 24 hours.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-gradient-to-br from-orange-500/20 to-orange-600/5 border border-orange-500/30 p-8 text-center space-y-5">
      <h3
        className="text-2xl font-bold text-foreground"
        style={{ fontFamily: "'Instrument Serif', Georgia, serif" }}
      >
        Ready to get your products in front of AI?
      </h3>
      <p className="text-muted-foreground max-w-lg mx-auto">
        We&apos;ll set up your{" "}
        {platformDetected ? (
          <strong className="text-foreground">{platformDetected}</strong>
        ) : (
          "e-commerce"
        )}{" "}
        store to show up on ChatGPT, Claude, and Gemini — and send you a live
        preview to review before anything goes live.
      </p>

      <Button
        size="lg"
        className="bg-orange-500 hover:bg-orange-600 text-white"
        onClick={handleClick}
        disabled={submitting}
      >
        {submitting ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <>
            Yes, let&apos;s do it <ArrowRight className="w-4 h-4" />
          </>
        )}
      </Button>

      <p className="text-xs text-muted-foreground">
        No credit card. No commitment. We&apos;ll reach out with next steps.
      </p>
    </div>
  );
}
