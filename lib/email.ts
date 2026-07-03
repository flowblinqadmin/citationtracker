import { Resend } from "resend";
import sgMail from "@sendgrid/mail";
import * as crypto from "crypto";

// ES-090 §b.7 (RM-flagged blocker): Resend's constructor throws when
// RESEND_API_KEY is unset — which crashed every import of this module at
// test time. Wrap in a lazy getter so the Resend client only materializes
// on the first actual send. Production behavior is unchanged (key is always
// set); test/CI environments that never send email never instantiate it.
//
// HP-231 — cache semantics: `_resend` is populated on first send and never
// re-read from process.env.RESEND_API_KEY afterward. Env-var rotation
// during a warm process lifetime is NOT reflected. On Vercel, env rotation
// triggers redeploy which cold-starts warm instances — so the cache
// invalidates at the platform boundary. Local-dev env-var hot-reload
// without process restart would require promoting this to a rotation-
// checking getter in a follow-up PR; out of PR #1 scope.
let _resend: Resend | null = null;
function getResend(): Resend {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("Resend: RESEND_API_KEY not configured");
  _resend = new Resend(key);
  return _resend;
}

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const RESEND_FROM = "FlowBlinq GEO <noreply@send.flowblinq.com>";
const SENDGRID_FROM = "FlowBlinq GEO <noreply@send2.flowblinq.com>";

// FIND-031: the 7 billing-customer lifecycle emails are intentionally
// fire-and-forget (a transient email outage must not fail a paid pipeline or
// Stripe webhook). But a *permanent* failure was swallowed by `console.warn`,
// so an operator never learned a customer missed their confirmation /
// payment-failed / low-credits notice. There is no durable retry-queue infra in
// this codebase to enqueue against, so the idiomatic loud fix — matching the
// structured-alert + in-memory-counter observability convention used elsewhere
// (e.g. getLlmParseFailureCount) — is a critical-severity ops-alert metric:
// a structured `billing_email_permanent_failure` log line plus a cumulative
// counter that surfaces a sustained regression.
let billingEmailFailureCount = 0;
export function getBillingEmailFailureCount(): number {
  return billingEmailFailureCount;
}
export function resetBillingEmailFailureCount(): void {
  billingEmailFailureCount = 0;
}

function onBillingEmailPermanentFailure(emailType: string, to: string, err: unknown): void {
  billingEmailFailureCount++;
  console.error(JSON.stringify({
    event: "billing_email_permanent_failure",
    emailType, to, severity: "critical",
    cumulative_count: billingEmailFailureCount,
    err: err instanceof Error ? err.message : String(err),
  }));
}

interface EmailAttachment {
  filename: string;
  content: Buffer | string;
}

interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
}

class ResendError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number | null
  ) {
    super(message);
    this.name = "ResendError";
  }
}

// Transient errors → safe to retry via SendGrid
const TRANSIENT_ERROR_CODES = new Set([
  "rate_limit_exceeded",
  "monthly_quota_exceeded",
  "daily_quota_exceeded",
  "concurrent_idempotent_requests",
  "application_error",
  "internal_server_error",
]);

async function sendWithResend(payload: EmailPayload): Promise<void> {
  const { attachments, ...rest } = payload;
  const { error } = await getResend().emails.send({
    from: RESEND_FROM,
    ...rest,
    ...(attachments && attachments.length > 0
      ? {
          attachments: attachments.map((a) => ({
            filename: a.filename,
            content: a.content,
          })),
        }
      : {}),
  });
  if (error) {
    throw new ResendError(error.message, error.name, error.statusCode ?? null);
  }
}

async function sendWithSendGrid(payload: EmailPayload): Promise<void> {
  if (!process.env.SENDGRID_API_KEY) {
    throw new Error("SendGrid: SENDGRID_API_KEY not configured");
  }
  const { attachments, ...rest } = payload;
  await sgMail.send({
    from: SENDGRID_FROM,
    ...rest,
    ...(attachments && attachments.length > 0
      ? {
          attachments: attachments.map((a) => ({
            filename: a.filename,
            content: Buffer.isBuffer(a.content)
              ? a.content.toString("base64")
              : Buffer.from(a.content as string).toString("base64"),
            type: "application/pdf",
            disposition: "attachment",
          })),
        }
      : {}),
  });
}

async function sendEmail(payload: EmailPayload): Promise<void> {
  try {
    await sendWithResend(payload);
  } catch (err) {
    // Permanent Resend errors (bad email, validation, auth) → throw immediately
    if (err instanceof ResendError && !TRANSIENT_ERROR_CODES.has(err.code)) {
      throw new Error(`Email failed: ${err.message}`);
    }

    // Transient Resend errors or network failures → fall back to SendGrid
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Resend failed (${msg}), falling back to SendGrid`);
    await sendWithSendGrid(payload);
  }
}

export function generateVerificationCode(): string {
  return String(crypto.randomInt(100000, 1000000));
}

export function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

export function verifyCode(inputCode: string, storedHash: string): boolean {
  const inputHash = hashCode(inputCode);
  return crypto.timingSafeEqual(
    Buffer.from(inputHash, "hex"),
    Buffer.from(storedHash, "hex")
  );
}

export async function sendVerificationEmail(
  email: string,
  code: string,
  domain: string
): Promise<void> {
  await sendEmail({
    to: email,
    subject: "Your GEO Profile Verification Code",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background: #000; color: #fff;">
        <h1 style="font-size: 24px; font-weight: 700; margin-bottom: 8px; color: #fff;">Verify your website</h1>
        <p style="color: #999; margin-bottom: 32px; font-size: 16px;">
          Enter this code to verify your website for AI discovery optimization.
        </p>

        <div style="background: #111; border: 1px solid #222; border-radius: 12px; padding: 32px; text-align: center; margin-bottom: 32px;">
          <p style="color: #666; font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 16px;">Your verification code</p>
          <div style="font-size: 48px; font-weight: 700; letter-spacing: 0.3em; color: #fff; font-family: 'Courier New', monospace;">${code}</div>
          <p style="color: #666; font-size: 12px; margin-top: 16px;">Expires in 15 minutes</p>
        </div>

        <p style="color: #666; font-size: 14px; line-height: 1.6;">
          You requested an AI visibility profile for <strong style="color: #fff;">${domain}</strong>.
          Once verified, we'll analyze your website across 16 GEO pillars and generate
          your llms.txt, UCP manifest, and Schema.org blocks.
        </p>

        <p style="color: #444; font-size: 12px; margin-top: 32px;">
          If you didn't request this, you can safely ignore this email.
        </p>
      </div>
    `,
  });
}

export async function sendTeamInviteEmail(
  email: string,
  teamName: string,
  inviterEmail: string
): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com";
  const loginUrl = `${appUrl}/auth/login`;

  await sendEmail({
    to: email,
    subject: `You've been invited to ${teamName} on FlowBlinq GEO`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background: #000; color: #fff;">
        <h1 style="font-size: 24px; font-weight: 700; margin-bottom: 8px; color: #fff;">You're invited</h1>
        <p style="color: #999; margin-bottom: 32px; font-size: 16px;">
          <strong style="color: #fff;">${inviterEmail}</strong> invited you to join
          <strong style="color: #fff;">${teamName}</strong> on FlowBlinq GEO.
        </p>

        <div style="background: #111; border: 1px solid #222; border-radius: 12px; padding: 32px; text-align: center; margin-bottom: 32px;">
          <p style="color: #ccc; font-size: 16px; margin-bottom: 20px;">
            Sign in with your email to accept the invite.
          </p>
          <p style="color: #666; font-size: 13px;">
            Go to <strong style="color: #fff;">${loginUrl}</strong> and sign in with <strong style="color: #fff;">${email}</strong>.
            Your team membership will be activated automatically.
          </p>
        </div>

        <p style="color: #444; font-size: 12px; margin-top: 32px;">
          If you didn't expect this invite, you can safely ignore this email.
        </p>
      </div>
    `,
  });
}

export async function sendCompletionEmail(
  email: string,
  domain: string,
  siteId: string,
  accessToken: string,
  overallScore?: number,
  projectedScore?: number,
  // ES-083 AC-12: when > 0, mention auto-discovered brand pages in the email body.
  // Optional with zero default — existing callers continue to work unchanged.
  autoDiscoveredCount?: number,
): Promise<void> {
  const appBase = process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com";
  const profileUrl = `${appBase}/sites/${siteId}?token=${accessToken}`;

  const score = overallScore ?? 0;
  const projected = projectedScore ?? score;
  const scoreColor = score >= 65 ? "#22c55e" : score >= 40 ? "#f59e0b" : "#ef4444";
  const scoreLabel = score >= 65 ? "Strong foundation" : score >= 40 ? "Partially visible" : "Mostly invisible";

  let headline = "Your AI visibility score is in.";
  let lede = "";
  if (score < 40) {
    lede = `AI platforms can't find ${domain} right now. Not a ranking problem — a structural one. Here's what's blocking them.`;
  } else if (score < 65) {
    lede = `${domain} is showing up in some AI results. Not consistently, not prominently. The gap between ${score} and ${projected} is fixable.`;
  } else {
    lede = `${domain} is visible to AI platforms. Your score puts you ahead of most. The recommendations below show where to pull further away.`;
  }

  // ES-083 AC-12: append auto-discovery mention to the lede when count > 0.
  // Plain-text appended to the lede HTML so it appears inline without
  // restructuring the score-card layout.
  const autoDiscoveryNote = (autoDiscoveredCount ?? 0) > 0
    ? ` We also crawled ${autoDiscoveredCount} brand-level pages (homepage, about-us, services index) to enrich your audit.`
    : "";
  const ledeWithAuto = `${lede}${autoDiscoveryNote}`;

  try {
    await sendEmail({
      to: email,
      subject: `Your AI visibility score for ${domain}: ${score}/100`,
      html: `
<table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;">

  <!-- Header bar -->
  <tr><td style="background:#C2652A;padding:18px 40px;">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;font-weight:800;letter-spacing:0.06em;color:#fff;">FLOWBLINQ</td>
      <td style="padding-left:6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;font-weight:400;color:rgba(255,255,255,0.6);">GEO</td>
    </tr></table>
  </td></tr>

  <!-- Hero -->
  <tr><td style="padding:40px 40px 0;">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:30px;font-weight:800;color:#111;line-height:1.2;margin:0;">Your AI visibility<br>score is in.</p>
  </td></tr>
  <tr><td style="padding:14px 40px 0;">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;line-height:1.65;color:#555;margin:0;">${ledeWithAuto}</p>
  </td></tr>

  <!-- Score card -->
  <tr><td style="padding:28px 40px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAFA;border:1px solid #DCB09E;border-radius:12px;">
      <tr>
        <!-- Current score -->
        <td style="padding:28px 28px;border-right:1px solid #DCB09E;width:50%;vertical-align:top;">
          <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:#aaa;margin:0 0 10px;">AI Visibility Score</p>
          <table cellpadding="0" cellspacing="0"><tr>
            <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:60px;font-weight:900;line-height:1;color:${scoreColor};letter-spacing:-2px;">${score}</td>
            <td style="padding-left:4px;vertical-align:bottom;padding-bottom:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:18px;font-weight:600;color:#ccc;">/100</td>
          </tr></table>
          <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#999;margin:6px 0 0;">${scoreLabel}</p>
        </td>
        <!-- Projected score -->
        <td style="padding:28px 28px;width:50%;vertical-align:top;">
          <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:#aaa;margin:0 0 10px;">Potential Score</p>
          <table cellpadding="0" cellspacing="0"><tr>
            <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:60px;font-weight:900;line-height:1;color:#111;letter-spacing:-2px;">${projected}</td>
            <td style="padding-left:4px;vertical-align:bottom;padding-bottom:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:18px;font-weight:600;color:#ccc;">/100</td>
          </tr></table>
          <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#999;margin:6px 0 0;">With recommended fixes</p>
        </td>
      </tr>
      <!-- Domain footer -->
      <tr><td colspan="2" style="padding:12px 28px;background:#EDD6CC;border-radius:0 0 11px 11px;">
        <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#8a5a3a;margin:0;">${domain} &nbsp;·&nbsp; Analyzed across 16 GEO pillars</p>
      </td></tr>
    </table>
  </td></tr>

  <!-- CTA -->
  <tr><td style="padding:28px 40px 0;">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="background:#C2652A;border-radius:8px;">
        <a href="${profileUrl}" style="display:block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;font-weight:700;color:#fff;text-decoration:none;padding:14px 28px;white-space:nowrap;">See Full Breakdown →</a>
      </td>
    </tr></table>
  </td></tr>

  <!-- Body -->
  <tr><td style="padding:24px 40px 0;">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.7;color:#777;margin:0;">Your profile includes a GEO scorecard, ready-to-deploy llms.txt, UCP manifest, and Schema.org blocks — plus a fix list ranked by impact.</p>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:32px 40px 40px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="border-top:1px solid #EDD6CC;padding-top:20px;">
        <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#bbb;margin:0;">Your profile refreshes automatically. Trigger a manual re-audit anytime from the dashboard.</p>
      </td>
    </tr></table>
  </td></tr>

</table>
      `,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Failed to send completion email to ${email}: ${msg}`);
  }
}

// ── New lifecycle emails ─────────────────────────────────────────────────────

export async function sendPipelineFailedEmail(
  email: string,
  domain: string,
  dashboardUrl: string
): Promise<void> {
  await sendEmail({
    to: email,
    subject: `Audit failed for ${domain}`,
    html: `
<table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;">
  <tr><td style="background:#C2652A;padding:18px 40px;">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;font-weight:800;letter-spacing:0.06em;color:#fff;">FLOWBLINQ</td>
      <td style="padding-left:6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:rgba(255,255,255,0.6);">GEO</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:40px 40px 0;">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:30px;font-weight:800;color:#111;line-height:1.2;margin:0;">The audit<br>didn't finish.</p>
  </td></tr>
  <tr><td style="padding:14px 40px 0;">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;line-height:1.65;color:#555;margin:0;">Something went wrong while analyzing <strong style="color:#111;">${domain}</strong>. Your credits have been refunded. This usually resolves itself — run it again.</p>
  </td></tr>
  <tr><td style="padding:28px 40px 0;">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="background:#C2652A;border-radius:8px;">
        <a href="${dashboardUrl}" style="display:block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;font-weight:700;color:#fff;text-decoration:none;padding:14px 28px;white-space:nowrap;">Try Again →</a>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:32px 40px 40px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="border-top:1px solid #EDD6CC;padding-top:20px;">
        <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#bbb;margin:0;">If this keeps happening, reply to this email and we'll dig in.</p>
      </td>
    </tr></table>
  </td></tr>
</table>
    `,
  }).catch((err) => onBillingEmailPermanentFailure("sendPipelineFailedEmail", email, err));
}

export async function sendSubscriptionConfirmationEmail(
  email: string,
  opts: { planName: string; pageAllowance: number; dashboardUrl: string }
): Promise<void> {
  const { planName, pageAllowance, dashboardUrl } = opts;
  await sendEmail({
    to: email,
    subject: `You're on ${planName} — FlowBlinq GEO`,
    html: `
<table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;">
  <tr><td style="background:#C2652A;padding:18px 40px;">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;font-weight:800;letter-spacing:0.06em;color:#fff;">FLOWBLINQ</td>
      <td style="padding-left:6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:rgba(255,255,255,0.6);">GEO</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:40px 40px 0;">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:30px;font-weight:800;color:#111;line-height:1.2;margin:0;">You're on ${planName}.</p>
  </td></tr>
  <tr><td style="padding:14px 40px 0;">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;line-height:1.65;color:#555;margin:0;">Good call. Most brands won't be on AI platforms when the next wave of buyers arrives. You will be.</p>
  </td></tr>
  <!-- Plan card -->
  <tr><td style="padding:28px 40px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAFA;border:1px solid #DCB09E;border-radius:12px;">
      <tr>
        <td style="padding:22px 28px;border-right:1px solid #DCB09E;width:50%;">
          <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:#aaa;margin:0 0 8px;">Plan</p>
          <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:22px;font-weight:800;color:#111;margin:0;">${planName}</p>
        </td>
        <td style="padding:22px 28px;width:50%;">
          <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:#aaa;margin:0 0 8px;">Pages / month</p>
          <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:22px;font-weight:800;color:#111;margin:0;">${pageAllowance.toLocaleString()}</p>
        </td>
      </tr>
      <tr><td colspan="2" style="padding:12px 28px;background:#EDD6CC;border-radius:0 0 11px 11px;">
        <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#8a5a3a;margin:0;">Auto-refreshes weekly &nbsp;·&nbsp; Unlimited manual audits</p>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:28px 40px 0;">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="background:#C2652A;border-radius:8px;">
        <a href="${dashboardUrl}" style="display:block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;font-weight:700;color:#fff;text-decoration:none;padding:14px 28px;white-space:nowrap;">Go to Dashboard →</a>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:32px 40px 40px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="border-top:1px solid #EDD6CC;padding-top:20px;">
        <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#bbb;margin:0;">Questions? Reply here or reach us at hello@flowblinq.com.</p>
      </td>
    </tr></table>
  </td></tr>
</table>
    `,
  }).catch((err) => onBillingEmailPermanentFailure("sendSubscriptionConfirmationEmail", email, err));
}

export async function sendCreditsPurchasedEmail(
  email: string,
  opts: { creditsAdded: number; newBalance: number; dashboardUrl: string }
): Promise<void> {
  const { creditsAdded, newBalance, dashboardUrl } = opts;
  const pagesUnlocked = creditsAdded * 10;
  await sendEmail({
    to: email,
    subject: `${creditsAdded} credits added — FlowBlinq GEO`,
    html: `
<table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;">
  <tr><td style="background:#C2652A;padding:18px 40px;">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;font-weight:800;letter-spacing:0.06em;color:#fff;">FLOWBLINQ</td>
      <td style="padding-left:6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:rgba(255,255,255,0.6);">GEO</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:40px 40px 0;">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:30px;font-weight:800;color:#111;line-height:1.2;margin:0;">Fuel's in the tank.</p>
  </td></tr>
  <tr><td style="padding:14px 40px 0;">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;line-height:1.65;color:#555;margin:0;">${creditsAdded} credits just landed in your account. That's ${pagesUnlocked.toLocaleString()} pages of AI visibility auditing — run them whenever you want.</p>
  </td></tr>
  <tr><td style="padding:28px 40px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAFA;border:1px solid #DCB09E;border-radius:12px;">
      <tr>
        <td style="padding:22px 28px;border-right:1px solid #DCB09E;width:50%;">
          <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:#aaa;margin:0 0 8px;">Credits added</p>
          <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:36px;font-weight:900;color:#10b981;margin:0;letter-spacing:-1px;">+${creditsAdded}</p>
        </td>
        <td style="padding:22px 28px;width:50%;">
          <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:#aaa;margin:0 0 8px;">New balance</p>
          <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:36px;font-weight:900;color:#111;margin:0;letter-spacing:-1px;">${newBalance}</p>
        </td>
      </tr>
      <tr><td colspan="2" style="padding:12px 28px;background:#EDD6CC;border-radius:0 0 11px 11px;">
        <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#8a5a3a;margin:0;">1 credit = 10 pages &nbsp;·&nbsp; Credits never expire</p>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:28px 40px 0;">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="background:#C2652A;border-radius:8px;">
        <a href="${dashboardUrl}" style="display:block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;font-weight:700;color:#fff;text-decoration:none;padding:14px 28px;white-space:nowrap;">Run an Audit →</a>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:32px 40px 40px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="border-top:1px solid #EDD6CC;padding-top:20px;">
        <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#bbb;margin:0;">Use them at your own pace. No expiry, no limits.</p>
      </td>
    </tr></table>
  </td></tr>
</table>
    `,
  }).catch((err) => onBillingEmailPermanentFailure("sendCreditsPurchasedEmail", email, err));
}

export async function sendSubscriptionRenewalEmail(
  email: string,
  opts: { planName: string; pageAllowance: number; nextRenewalDate: string; dashboardUrl: string }
): Promise<void> {
  const { planName, pageAllowance, nextRenewalDate, dashboardUrl } = opts;
  await sendEmail({
    to: email,
    subject: `${planName} renewed — FlowBlinq GEO`,
    html: `
<table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;">
  <tr><td style="background:#C2652A;padding:18px 40px;">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;font-weight:800;letter-spacing:0.06em;color:#fff;">FLOWBLINQ</td>
      <td style="padding-left:6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:rgba(255,255,255,0.6);">GEO</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:40px 40px 0;">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:30px;font-weight:800;color:#111;line-height:1.2;margin:0;">Another month.<br>Pages reset.</p>
  </td></tr>
  <tr><td style="padding:14px 40px 0;">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;line-height:1.65;color:#555;margin:0;">Your ${planName} plan has renewed. ${pageAllowance.toLocaleString()} pages are ready to go.</p>
  </td></tr>
  <tr><td style="padding:28px 40px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAFA;border:1px solid #DCB09E;border-radius:12px;">
      <tr>
        <td style="padding:18px 22px;border-right:1px solid #DCB09E;width:33%;">
          <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:#aaa;margin:0 0 6px;">Plan</p>
          <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:17px;font-weight:800;color:#111;margin:0;">${planName}</p>
        </td>
        <td style="padding:18px 22px;border-right:1px solid #DCB09E;width:33%;">
          <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:#aaa;margin:0 0 6px;">Pages reset</p>
          <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:17px;font-weight:800;color:#111;margin:0;">${pageAllowance.toLocaleString()}</p>
        </td>
        <td style="padding:18px 22px;width:33%;">
          <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:#aaa;margin:0 0 6px;">Next renewal</p>
          <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:17px;font-weight:800;color:#111;margin:0;">${nextRenewalDate}</p>
        </td>
      </tr>
    </table>
  </td></tr>
  <tr><td style="padding:28px 40px 40px;">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="background:#C2652A;border-radius:8px;">
        <a href="${dashboardUrl}" style="display:block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;font-weight:700;color:#fff;text-decoration:none;padding:14px 28px;white-space:nowrap;">Open Dashboard →</a>
      </td>
    </tr></table>
  </td></tr>
</table>
    `,
  }).catch((err) => onBillingEmailPermanentFailure("sendSubscriptionRenewalEmail", email, err));
}

export async function sendPaymentFailedEmail(
  email: string,
  opts: { planName: string; updatePaymentUrl: string }
): Promise<void> {
  const { planName, updatePaymentUrl } = opts;
  await sendEmail({
    to: email,
    subject: "Payment failed — action needed",
    html: `
<table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;">
  <tr><td style="background:#C2652A;padding:18px 40px;">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;font-weight:800;letter-spacing:0.06em;color:#fff;">FLOWBLINQ</td>
      <td style="padding-left:6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:rgba(255,255,255,0.6);">GEO</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:40px 40px 0;">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:30px;font-weight:800;color:#111;line-height:1.2;margin:0;">Your payment<br>didn't go through.</p>
  </td></tr>
  <tr><td style="padding:14px 40px 0;">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;line-height:1.65;color:#555;margin:0;">We couldn't charge the card on file for your <strong style="color:#111;">${planName}</strong> plan. Update your payment method to keep your account active.</p>
  </td></tr>
  <tr><td style="padding:28px 40px 0;">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="background:#ef4444;border-radius:8px;">
        <a href="${updatePaymentUrl}" style="display:block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;font-weight:700;color:#fff;text-decoration:none;padding:14px 28px;white-space:nowrap;">Update Payment Method →</a>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:20px 40px 0;">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.7;color:#777;margin:0;">Stripe will retry automatically. If the payment continues to fail, your subscription will be paused. Your data stays intact.</p>
  </td></tr>
  <tr><td style="padding:32px 40px 40px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="border-top:1px solid #EDD6CC;padding-top:20px;">
        <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#bbb;margin:0;">Questions? Reply to this email.</p>
      </td>
    </tr></table>
  </td></tr>
</table>
    `,
  }).catch((err) => onBillingEmailPermanentFailure("sendPaymentFailedEmail", email, err));
}

export async function sendSubscriptionCancelledEmail(
  email: string,
  opts: { planName: string; reactivateUrl: string }
): Promise<void> {
  const { planName, reactivateUrl } = opts;
  await sendEmail({
    to: email,
    subject: `Your ${planName} plan has been cancelled`,
    html: `
<table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;">
  <tr><td style="background:#C2652A;padding:18px 40px;">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;font-weight:800;letter-spacing:0.06em;color:#fff;">FLOWBLINQ</td>
      <td style="padding-left:6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:rgba(255,255,255,0.6);">GEO</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:40px 40px 0;">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:30px;font-weight:800;color:#111;line-height:1.2;margin:0;">You're back on free.</p>
  </td></tr>
  <tr><td style="padding:14px 40px 0;">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;line-height:1.65;color:#555;margin:0;">Your <strong style="color:#111;">${planName}</strong> plan has been cancelled. Your audits, scores, and profile data are still here — you just won't get automatic refreshes or expanded page budgets.</p>
  </td></tr>
  <!-- Info box -->
  <tr><td style="padding:24px 40px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAFA;border:1px solid #DCB09E;border-radius:10px;">
      <tr><td style="padding:20px 24px;">
        <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.7;color:#777;margin:0;">AI search is moving fast. Every month without monitoring is a month your competitors are pulling ahead in the indexes that matter.</p>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:24px 40px 0;">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="background:#C2652A;border-radius:8px;">
        <a href="${reactivateUrl}" style="display:block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;font-weight:700;color:#fff;text-decoration:none;padding:14px 28px;white-space:nowrap;">Reactivate →</a>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:32px 40px 40px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="border-top:1px solid #EDD6CC;padding-top:20px;">
        <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#bbb;margin:0;">Changed your mind? Your previous settings are saved.</p>
      </td>
    </tr></table>
  </td></tr>
</table>
    `,
  }).catch((err) => onBillingEmailPermanentFailure("sendSubscriptionCancelledEmail", email, err));
}

export async function sendLowCreditsEmail(
  email: string,
  opts: { creditsRemaining: number; topUpUrl: string }
): Promise<void> {
  const { creditsRemaining, topUpUrl } = opts;
  const pagesLeft = creditsRemaining * 10;
  await sendEmail({
    to: email,
    subject: `Low credits: ${creditsRemaining} left — FlowBlinq GEO`,
    html: `
<table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;">
  <tr><td style="background:#C2652A;padding:18px 40px;">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;font-weight:800;letter-spacing:0.06em;color:#fff;">FLOWBLINQ</td>
      <td style="padding-left:6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:rgba(255,255,255,0.6);">GEO</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:40px 40px 0;">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:30px;font-weight:800;color:#111;line-height:1.2;margin:0;">Running low.</p>
  </td></tr>
  <tr><td style="padding:14px 40px 0;">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;line-height:1.65;color:#555;margin:0;">You have <strong style="color:#f59e0b;">${creditsRemaining} credits</strong> left — about ${pagesLeft} pages of audit capacity. Top up to keep running audits without interruption.</p>
  </td></tr>
  <tr><td style="padding:28px 40px 0;">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="background:#C2652A;border-radius:8px;">
        <a href="${topUpUrl}" style="display:block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;font-weight:700;color:#fff;text-decoration:none;padding:14px 28px;white-space:nowrap;">Top Up Credits →</a>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:32px 40px 40px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="border-top:1px solid #EDD6CC;padding-top:20px;">
        <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#bbb;margin:0;">Credits don't expire. Buy once, use anytime.</p>
      </td>
    </tr></table>
  </td></tr>
</table>
    `,
  }).catch((err) => onBillingEmailPermanentFailure("sendLowCreditsEmail", email, err));
}

export async function sendInternalSignupAlert(opts: {
  customerEmail: string;
  domain: string;
  siteId: string;
  source?: string;
}): Promise<void> {
  const { customerEmail, domain, siteId, source } = opts;
  const appBase = process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com";
  const ts = new Date().toISOString();
  await sendEmail({
    to: "hello@flowblinq.com",
    subject: `🆕 New audit started: ${domain} (${customerEmail})`,
    html: `
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e8e8e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <tr><td style="padding:32px 36px;">
    <p style="font-size:13px;font-weight:700;color:#111;margin:0 0 20px;">New customer started an audit</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #f0f0f0;">
      <tr><td style="font-size:13px;color:#999;padding:9px 0;width:120px;border-bottom:1px solid #f0f0f0;">Email</td><td style="font-size:13px;color:#111;font-weight:600;padding:9px 0;border-bottom:1px solid #f0f0f0;">${customerEmail}</td></tr>
      <tr><td style="font-size:13px;color:#999;padding:9px 0;border-bottom:1px solid #f0f0f0;">Domain</td><td style="font-size:13px;color:#C2652A;font-weight:700;padding:9px 0;border-bottom:1px solid #f0f0f0;">${domain}</td></tr>
      <tr><td style="font-size:13px;color:#999;padding:9px 0;border-bottom:1px solid #f0f0f0;">Source</td><td style="font-size:13px;color:#111;padding:9px 0;border-bottom:1px solid #f0f0f0;">${source ?? "single"}</td></tr>
      <tr><td style="font-size:13px;color:#999;padding:9px 0;border-bottom:1px solid #f0f0f0;">Site</td><td style="font-size:13px;padding:9px 0;border-bottom:1px solid #f0f0f0;"><a href="${appBase}/sites/${siteId}" style="color:#C2652A;text-decoration:none;">${siteId}</a></td></tr>
      <tr><td style="font-size:13px;color:#999;padding:9px 0;">Time</td><td style="font-size:13px;color:#bbb;padding:9px 0;">${ts}</td></tr>
    </table>
  </td></tr>
</table>
    `,
  }).catch((err) => console.warn("[email] sendInternalSignupAlert failed:", err));
}

export async function sendInternalPaymentAlert(opts: {
  customerEmail: string;
  type: "subscription" | "credits" | "audit_purchase" | "audit_purchase_failed" | "audit_purchase_refunded" | "audit_purchase_disputed" | "audit_purchase_expired" | "audit_purchase_refund_failed";
  planName?: string;
  creditsAdded?: number;
  timestamp?: string;
  domain?: string;
  note?: string;
}): Promise<void> {
  const { customerEmail, type, planName, creditsAdded, timestamp, domain, note } = opts;
  const ts = timestamp ?? new Date().toISOString();
  const subjectMap: Record<string, string> = {
    subscription: `💸 New subscriber: ${customerEmail} → ${planName}`,
    audit_purchase: `💸 Audit purchase: ${customerEmail} → ${planName}`,
    credits: `💸 Credits purchase: ${customerEmail} → ${creditsAdded} credits`,
    audit_purchase_failed: `🔴 Audit FAILED + refund issued: ${customerEmail} — ${domain ?? "unknown"}`,
    audit_purchase_refunded: `↩️ Audit refunded: ${customerEmail} — ${domain ?? "unknown"}`,
    audit_purchase_disputed: `🚨 CHARGEBACK: ${customerEmail} — ${domain ?? "unknown"} — RESPOND IN STRIPE`,
    audit_purchase_expired: `⏱️ Checkout expired (no charge): ${customerEmail}`,
    audit_purchase_refund_failed: `🚨 REFUND FAILED — manual action required: ${customerEmail} — ${domain ?? "unknown"}`,
  };
  const subject = subjectMap[type] ?? `[audit] ${type}: ${customerEmail}`;
  const typeLabelMap: Record<string, string> = {
    subscription: "Subscription",
    audit_purchase: "Audit purchase",
    credits: "Credit pack",
    audit_purchase_failed: "Audit failed",
    audit_purchase_refunded: "Audit refunded",
    audit_purchase_disputed: "CHARGEBACK DISPUTE",
    audit_purchase_expired: "Checkout expired",
    audit_purchase_refund_failed: "Refund failed — manual action needed",
  };
  const typeLabel = typeLabelMap[type] ?? type;
  const detailLabel = type === "credits" ? "Credits" : "Plan";
  const detailValue = type === "credits" ? String(creditsAdded ?? "") : (planName ?? domain ?? note ?? "");
  await sendEmail({
    to: "hello@flowblinq.com",
    subject,
    html: `
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e8e8e8;">
  <tr><td style="padding:32px 36px;">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;font-weight:700;color:#111;margin:0 0 20px;">Payment received</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #f0f0f0;">
      <tr><td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#999;padding:9px 0;width:120px;border-bottom:1px solid #f0f0f0;">Customer</td><td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#111;font-weight:600;padding:9px 0;border-bottom:1px solid #f0f0f0;">${customerEmail}</td></tr>
      <tr><td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#999;padding:9px 0;border-bottom:1px solid #f0f0f0;">Type</td><td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#111;font-weight:600;padding:9px 0;border-bottom:1px solid #f0f0f0;">${typeLabel}</td></tr>
      <tr><td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#999;padding:9px 0;border-bottom:1px solid #f0f0f0;">${detailLabel}</td><td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#C2652A;font-weight:700;padding:9px 0;border-bottom:1px solid #f0f0f0;">${detailValue}</td></tr>
      <tr><td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#999;padding:9px 0;">Time</td><td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#bbb;padding:9px 0;">${ts}</td></tr>
    </table>
  </td></tr>
</table>
    `,
  }).catch((err) => console.warn("[email] sendInternalPaymentAlert failed:", err));
}

// ── Pipeline Health Alert ───────────────────────────────────────────────────

export type PipelineHealthSeverity = "warn" | "critical";
export type PipelineHealthCategory = "provider" | "audit-stuck" | "all-quiet";

export interface PipelineHealthAlertOpts {
  severity: PipelineHealthSeverity;
  category: PipelineHealthCategory;
  summary: string;
  // Rows shown in a key/value table. Order is preserved.
  details: Array<[string, string]>;
}

export async function sendInternalPipelineHealthAlert(
  opts: PipelineHealthAlertOpts,
): Promise<void> {
  const { severity, category, summary, details } = opts;
  const icon = severity === "critical" ? "🚨" : "⚠️";
  const ts = new Date().toISOString();
  const appBase = process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com";

  const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const rowsHtml = details
    .map(
      ([label, value]) =>
        `<tr><td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#999;padding:9px 0;width:160px;border-bottom:1px solid #f0f0f0;">${escapeHtml(label)}</td><td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#111;padding:9px 0;border-bottom:1px solid #f0f0f0;">${escapeHtml(value)}</td></tr>`,
    )
    .join("");

  await sendEmail({
    to: "hello@flowblinq.com",
    subject: `${icon} Pipeline health — ${category}: ${summary}`,
    html: `
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e8e8e8;">
  <tr><td style="padding:32px 36px;">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;font-weight:700;color:#111;margin:0 0 6px;">${icon} ${escapeHtml(severity.toUpperCase())} — ${escapeHtml(category)}</p>
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:#C2652A;font-weight:600;margin:0 0 20px;">${escapeHtml(summary)}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #f0f0f0;">
      ${rowsHtml}
      <tr><td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#999;padding:9px 0;">Detected at</td><td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#bbb;padding:9px 0;">${ts}</td></tr>
    </table>
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#bbb;margin:24px 0 0;">Source: ${appBase}/api/cron/pipeline-health</p>
  </td></tr>
</table>
    `,
  }).catch((err) => console.warn("[email] sendInternalPipelineHealthAlert failed:", err));
}

// ── GMC Audit Purchase Emails ───────────────────────────────────────────────

export async function sendAuditPurchaseConfirmationEmail(
  email: string,
  domain: string,
): Promise<void> {
  await sendEmail({
    to: email,
    subject: `Your AI Audit is Running — ${domain}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background: #000; color: #fff;">
        <h1 style="font-size: 24px; font-weight: 700; margin-bottom: 8px; color: #fff;">Your audit is running.</h1>
        <p style="color: #999; margin-bottom: 32px; font-size: 16px;">
          We're analyzing <strong style="color: #fff;">${domain}</strong> across ChatGPT, Claude, Gemini, and Perplexity.
        </p>

        <div style="background: #111; border: 1px solid #222; border-radius: 12px; padding: 32px; margin-bottom: 32px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="border-top: 1px solid #333;">
            <tr>
              <td style="font-size: 13px; color: #666; padding: 12px 0; border-bottom: 1px solid #333;">Domain</td>
              <td style="font-size: 13px; color: #fff; font-weight: 600; padding: 12px 0; border-bottom: 1px solid #333;">${domain}</td>
            </tr>
            <tr>
              <td style="font-size: 13px; color: #666; padding: 12px 0; border-bottom: 1px solid #333;">Amount</td>
              <td style="font-size: 13px; color: #C4841D; font-weight: 700; padding: 12px 0; border-bottom: 1px solid #333;">$10.00 USD</td>
            </tr>
            <tr>
              <td style="font-size: 13px; color: #666; padding: 12px 0;">Delivery</td>
              <td style="font-size: 13px; color: #fff; padding: 12px 0;">Within 24 hours (usually 1-3 hours)</td>
            </tr>
          </table>
        </div>

        <p style="color: #666; font-size: 13px; margin-bottom: 8px;">
          We'll email your full PDF report to this address when it's ready.
        </p>
        <p style="color: #444; font-size: 12px; margin-top: 32px;">
          FlowBlinq Inc. · hello@flowblinq.com
        </p>
      </div>
    `,
  });
}

export async function sendAuditPurchaseFailedEmail(
  email: string,
  domain: string,
  refundedCents: number,
): Promise<void> {
  const refundDollars = (refundedCents / 100).toFixed(2);
  await sendEmail({
    to: email,
    subject: `Your audit hit a snag — refund issued for ${domain}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background: #000; color: #fff;">
        <h1 style="font-size: 24px; font-weight: 700; margin-bottom: 8px; color: #fff;">We hit a snag.</h1>
        <p style="color: #999; margin-bottom: 32px; font-size: 16px;">
          Unfortunately the audit for <strong style="color: #fff;">${domain}</strong> encountered a technical error and could not complete.
        </p>

        <div style="background: #111; border: 1px solid #222; border-radius: 12px; padding: 32px; margin-bottom: 32px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="border-top: 1px solid #333;">
            <tr>
              <td style="font-size: 13px; color: #666; padding: 12px 0; border-bottom: 1px solid #333;">Domain</td>
              <td style="font-size: 13px; color: #fff; font-weight: 600; padding: 12px 0; border-bottom: 1px solid #333;">${domain}</td>
            </tr>
            <tr>
              <td style="font-size: 13px; color: #666; padding: 12px 0; border-bottom: 1px solid #333;">Refund</td>
              <td style="font-size: 13px; color: #C4841D; font-weight: 700; padding: 12px 0; border-bottom: 1px solid #333;">$${refundDollars} USD — auto-issued</td>
            </tr>
            <tr>
              <td style="font-size: 13px; color: #666; padding: 12px 0;">Timeline</td>
              <td style="font-size: 13px; color: #fff; padding: 12px 0;">3–5 business days to appear on your statement</td>
            </tr>
          </table>
        </div>

        <p style="color: #666; font-size: 13px; margin-bottom: 8px;">
          No action is needed on your end. If you have questions, reply to this email or contact us at
          <a href="mailto:hello@flowblinq.com" style="color: #C4841D;">hello@flowblinq.com</a>.
        </p>
        <p style="color: #444; font-size: 12px; margin-top: 32px;">
          FlowBlinq Inc. · hello@flowblinq.com
        </p>
      </div>
    `,
  });
}

export async function sendAuditPurchaseRefundedEmail(
  email: string,
  domain: string,
): Promise<void> {
  await sendEmail({
    to: email,
    subject: `Refund processed — ${domain}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background: #000; color: #fff;">
        <h1 style="font-size: 24px; font-weight: 700; margin-bottom: 8px; color: #fff;">Refund confirmed.</h1>
        <p style="color: #999; margin-bottom: 32px; font-size: 16px;">
          Your refund for the <strong style="color: #fff;">${domain}</strong> audit has been processed.
        </p>

        <div style="background: #111; border: 1px solid #222; border-radius: 12px; padding: 32px; margin-bottom: 32px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="border-top: 1px solid #333;">
            <tr>
              <td style="font-size: 13px; color: #666; padding: 12px 0; border-bottom: 1px solid #333;">Domain</td>
              <td style="font-size: 13px; color: #fff; font-weight: 600; padding: 12px 0; border-bottom: 1px solid #333;">${domain}</td>
            </tr>
            <tr>
              <td style="font-size: 13px; color: #666; padding: 12px 0; border-bottom: 1px solid #333;">Status</td>
              <td style="font-size: 13px; color: #C4841D; font-weight: 700; padding: 12px 0; border-bottom: 1px solid #333;">Refund issued</td>
            </tr>
            <tr>
              <td style="font-size: 13px; color: #666; padding: 12px 0;">Timeline</td>
              <td style="font-size: 13px; color: #fff; padding: 12px 0;">3–5 business days to appear on your statement</td>
            </tr>
          </table>
        </div>

        <p style="color: #666; font-size: 13px; margin-bottom: 8px;">
          If you have questions, reply to this email or contact us at
          <a href="mailto:hello@flowblinq.com" style="color: #C4841D;">hello@flowblinq.com</a>.
        </p>
        <p style="color: #444; font-size: 12px; margin-top: 32px;">
          FlowBlinq Inc. · hello@flowblinq.com
        </p>
      </div>
    `,
  });
}

export async function sendAuditPurchaseDeliveryEmail(
  email: string,
  domain: string,
  pdf: { buffer: Buffer; filename: string },
  options: { magicLink?: string; overallScore?: number; topPillars?: string[]; siteUrl?: string },
): Promise<void> {
  const { magicLink, overallScore, topPillars = [], siteUrl } = options;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com";
  // Primary CTA destination: magic link (lands logged-in) or app dashboard.
  const ctaHref = magicLink ?? `${appUrl}/dashboard`;

  const score = overallScore ?? 0;
  const scoreColor = score >= 65 ? "#3B7A4A" : score >= 40 ? "#C4841D" : "#B5403A";
  const scoreLabel = score >= 65 ? "Strong foundation" : score >= 40 ? "Partially visible" : "Mostly invisible";

  // Install CTA copy: reference top-N pillar count when available.
  const issueCount = topPillars.length;
  const ctaText = issueCount > 0
    ? `Install FlowBlinq &#8594; fix ${issueCount} issues automatically`
    : "Open your dashboard";

  await sendEmail({
    to: email,
    subject: `Your AI Visibility Score: ${score}/100 — ${domain}`,
    attachments: [{ filename: pdf.filename, content: pdf.buffer }],
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background: #000; color: #fff;">
        <h1 style="font-size: 24px; font-weight: 700; margin-bottom: 8px; color: #fff;">Your report is ready.</h1>
        <p style="color: #999; margin-bottom: 32px; font-size: 16px;">
          Your full audit PDF is attached. Here's how AI platforms see <strong style="color: #fff;">${domain}</strong>.
        </p>

        <div style="background: #111; border: 1px solid #222; border-radius: 12px; padding: 32px; text-align: center; margin-bottom: 32px;">
          <div style="font-family: 'JetBrains Mono', 'SF Mono', monospace; font-size: 56px; font-weight: 700; color: ${scoreColor}; line-height: 1; margin-bottom: 8px;">
            ${score}
          </div>
          <div style="font-family: 'JetBrains Mono', 'SF Mono', monospace; font-size: 12px; color: #666; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 16px;">
            / 100
          </div>
          <div style="font-size: 14px; color: ${scoreColor}; font-weight: 600;">
            ${scoreLabel}
          </div>
        </div>

        <!-- Primary install CTA -->
        <div style="text-align: center; margin-bottom: 24px;">
          <a href="${ctaHref}" style="display: inline-block; padding: 14px 32px; background: #C4841D; color: #fff; text-decoration: none; border-radius: 8px; font-size: 15px; font-weight: 600;">
            ${ctaText}
          </a>
        </div>

        <!-- Secondary interactive-report link -->
        <div style="text-align: center; margin-bottom: 32px;">
          <a href="${siteUrl ?? ctaHref}" style="font-size: 13px; color: #666; text-decoration: none;">
            View your interactive report &#8594;
          </a>
        </div>

        <!-- What FlowBlinq fixes for you -->
        <div style="background: #111; border: 1px solid #222; border-radius: 12px; padding: 24px; margin-bottom: 32px;">
          <p style="font-size: 13px; font-weight: 700; color: #fff; margin: 0 0 16px; text-transform: uppercase; letter-spacing: 1px;">
            What FlowBlinq fixes for you
          </p>
          <table width="100%" cellpadding="0" cellspacing="0" style="border-top: 1px solid #222;">
            <tr>
              <td style="padding: 12px 0; border-bottom: 1px solid #222; font-size: 13px; color: #ccc; width: 28px; vertical-align: top;">&#10003;</td>
              <td style="padding: 12px 0; border-bottom: 1px solid #222;">
                <span style="font-size: 13px; color: #fff; font-weight: 600;">llms.txt</span>
                <span style="font-size: 13px; color: #666;"> — auto-published so AI crawlers know what you do</span>
              </td>
            </tr>
            <tr>
              <td style="padding: 12px 0; border-bottom: 1px solid #222; font-size: 13px; color: #ccc; width: 28px; vertical-align: top;">&#10003;</td>
              <td style="padding: 12px 0; border-bottom: 1px solid #222;">
                <span style="font-size: 13px; color: #fff; font-weight: 600;">schema.org blocks</span>
                <span style="font-size: 13px; color: #666;"> — auto-injected so AI platforms cite you correctly</span>
              </td>
            </tr>
            <tr>
              <td style="padding: 12px 0; font-size: 13px; color: #ccc; width: 28px; vertical-align: top;">&#10003;</td>
              <td style="padding: 12px 0;">
                <span style="font-size: 13px; color: #fff; font-weight: 600;">business.json</span>
                <span style="font-size: 13px; color: #666;"> — auto-generated so your brand facts are machine-readable</span>
              </td>
            </tr>
          </table>
        </div>

        <p style="color: #444; font-size: 12px; margin-top: 32px;">
          FlowBlinq Inc. · hello@flowblinq.com
        </p>
      </div>
    `,
  });
}
