// OTP helper — Gmail IMAP direct (imapflow).
// Design: /tmp/flowblinq/otp-helper-design.md; Aditya decisions Q8/Q9/Q10/Q11.
// Credentials: process.env.GMAIL_APP_PASSWORD (sourced at launch from ~/.mailenv).
// Plus-addressing: adityanittoor+geotests@gmail.com.
// Post-read: archive + label 'flowblinq-test-otp' (NO hard delete).
// Freshness probing: OFF per Q11 — helper returns latest matching message unconditionally.
// Security: NEVER log the code.

// Lazy dynamic import — keeps `playwright test --list` working even before
// `npm install imapflow` has run. Tests that actually call getLatestOtp()
// require the package at runtime.

const GMAIL_USER = "adityanittoor@gmail.com";
const TO_FILTER = "adityanittoor+geotests@gmail.com";
const FROM_ALLOWLIST = ["noreply@send.flowblinq.com", "noreply@send2.flowblinq.com"];
const SUBJECT = "Your GEO Profile Verification Code";
const LABEL = "flowblinq-test-otp";
const CODE_TIGHT = /<div[^>]*font-family:\s*'Courier New'[^>]*>\s*(\d{6})\s*<\/div>/i;
const CODE_LOOSE = /verification code[\s\S]{0,400}?\b(\d{6})\b/i;

export interface GetLatestOtpOptions {
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

export class OtpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OtpTimeoutError";
  }
}

export async function getLatestOtp(
  toAddress: string = TO_FILTER,
  opts: GetLatestOtpOptions = {},
): Promise<string> {
  const pollInterval = opts.pollIntervalMs ?? 500;
  const maxWait = opts.maxWaitMs ?? 20_000;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!pass) throw new Error("GMAIL_APP_PASSWORD not set (source ~/.mailenv before launch)");

  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: GMAIL_USER, pass },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const deadline = Date.now() + maxWait;
      while (Date.now() < deadline) {
        const uids = await client.search({
          to: toAddress,
          subject: SUBJECT,
        });
        for (let i = uids.length - 1; i >= 0; i--) {
          const uid = uids[i];
          const msg = await client.fetchOne(String(uid), { source: true, envelope: true, uid: true });
          if (!msg) continue;
          const fromAddr = msg.envelope?.from?.[0]?.address?.toLowerCase() ?? "";
          if (!FROM_ALLOWLIST.includes(fromAddr)) continue;
          const html = msg.source?.toString("utf8") ?? "";
          const m = html.match(CODE_TIGHT) ?? html.match(CODE_LOOSE);
          if (!m) continue;
          await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
          try {
            await client.messageMove(String(uid), LABEL, { uid: true });
          } catch {
            await client.mailboxCreate(LABEL).catch(() => {});
            await client.messageMove(String(uid), LABEL, { uid: true }).catch(() => {});
          }
          return m[1];
        }
        await new Promise((r) => setTimeout(r, pollInterval));
      }
      throw new OtpTimeoutError(`No OTP for ${toAddress} within ${maxWait}ms`);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}
