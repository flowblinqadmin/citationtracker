"use client";

import { Linkedin, Twitter, Mail, Link2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";

interface ShareBarProps {
  storeName: string;
  score: number;
  auditId: string;
}

export function ShareBar({ storeName, score, auditId }: ShareBarProps) {
  const [copied, setCopied] = useState(false);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://audit.flowblinq.com";
  const shareUrl = `${appUrl}/audit/${auditId}`;
  const shareText = `${storeName} scored ${score}% on AI visibility. See how your store compares:`;

  function copyLink() {
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          window.open(
            `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}`,
            "_blank"
          )
        }
      >
        <Linkedin className="w-4 h-4" /> LinkedIn
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          window.open(
            `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}`,
            "_blank"
          )
        }
      >
        <Twitter className="w-4 h-4" /> X
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          window.open(
            `mailto:?subject=${encodeURIComponent(`AI Visibility Audit: ${storeName}`)}&body=${encodeURIComponent(`${shareText}\n\n${shareUrl}`)}`,
            "_blank"
          )
        }
      >
        <Mail className="w-4 h-4" /> Email
      </Button>
      <Button variant="outline" size="sm" onClick={copyLink}>
        {copied ? (
          <>
            <Check className="w-4 h-4" /> Copied
          </>
        ) : (
          <>
            <Link2 className="w-4 h-4" /> Copy link
          </>
        )}
      </Button>
    </div>
  );
}
