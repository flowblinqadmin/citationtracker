import { Resend } from "resend";
import crypto from "crypto";
import { escapeHtml } from "@/lib/sanitize";

function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

export function generateVerificationCode(): string {
  return crypto.randomInt(100000, 999999).toString();
}

export function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

export function verifyCode(input: string, hashedCode: string): boolean {
  // L1 (2026-05-27 audit): crypto.timingSafeEqual throws RangeError on
  // length mismatch. Guard explicitly so corrupted rows / malformed inputs
  // return false instead of 500ing the request.
  if (typeof input !== "string" || input.length === 0) return false;
  if (typeof hashedCode !== "string" || hashedCode.length !== 64) return false;
  const inputHash = hashCode(input);
  return crypto.timingSafeEqual(
    Buffer.from(inputHash, "hex"),
    Buffer.from(hashedCode, "hex")
  );
}

export async function sendCommerceVerificationEmail(
  to: string,
  merchantName: string,
  code: string
) {
  const { data, error } = await getResend().emails.send({
    from: "FlowBlinq Audit <noreply@send.flowblinq.com>",
    to,
    subject: "Your AI Visibility Audit Code",
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'DM Sans',system-ui,sans-serif">
  <div style="max-width:480px;margin:0 auto;padding:40px 24px">
    <div style="text-align:center;margin-bottom:32px">
      <h1 style="color:#f97316;font-size:20px;font-weight:700;margin:0">FlowBlinq</h1>
      <p style="color:#a3a3a3;font-size:13px;margin:4px 0 0">AI Commerce Enablement</p>
    </div>
    <div style="background:#171717;border-radius:12px;padding:32px 24px;text-align:center">
      <h2 style="color:#fafafa;font-size:18px;font-weight:600;margin:0 0 8px">Your verification code</h2>
      <p style="color:#a3a3a3;font-size:14px;margin:0 0 24px">
        Enter this code to start your AI visibility audit for <strong style="color:#fafafa">${escapeHtml(merchantName)}</strong>.
      </p>
      <div style="background:#0a0a0a;border:2px solid #f97316;border-radius:8px;padding:16px;margin:0 auto;max-width:200px">
        <span style="font-family:'JetBrains Mono',monospace;font-size:32px;font-weight:700;letter-spacing:8px;color:#f97316">${code}</span>
      </div>
      <p style="color:#737373;font-size:12px;margin:24px 0 0">This code expires in 15 minutes.</p>
    </div>
    <p style="color:#525252;font-size:11px;text-align:center;margin:24px 0 0">
      You received this because someone requested an AI visibility audit. If this wasn't you, ignore this email.
    </p>
  </div>
</body>
</html>`,
  });

  if (error) {
    console.error("Resend verification email failed:", JSON.stringify(error));
    throw new Error(`Failed to send verification email: ${error.message}`);
  }

  console.warn(`Verification email sent to ${to} (id: ${data?.id})`);
}
