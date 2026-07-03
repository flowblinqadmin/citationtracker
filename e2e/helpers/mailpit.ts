/**
 * Mailpit API helper for E2E tests.
 * Fetches OTP codes from emails captured by local Supabase's Mailpit instance.
 *
 * Mailpit runs at http://127.0.0.1:54324 (configured in supabase/config.toml).
 */

const MAILPIT_URL = "http://127.0.0.1:54324";

interface MailpitMessage {
  ID: string;
  From: { Name: string; Address: string };
  To: { Name: string; Address: string }[];
  Subject: string;
  Created: string;
  Snippet: string;
}

interface MailpitSearchResponse {
  total: number;
  messages: MailpitMessage[];
}

/**
 * Fetch the latest OTP code sent to a given email address.
 * Polls Mailpit until an email arrives (up to `timeoutMs`).
 */
export async function getOtpForEmail(
  email: string,
  timeoutMs = 10_000,
): Promise<string> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const res = await fetch(
      `${MAILPIT_URL}/api/v1/search?query=to:${encodeURIComponent(email)}`,
    );
    if (!res.ok) throw new Error(`Mailpit search failed: ${res.status}`);

    const data: MailpitSearchResponse = await res.json();

    if (data.messages.length > 0) {
      // Sort by Created desc — get the latest email
      const latest = data.messages.sort(
        (a, b) =>
          new Date(b.Created).getTime() - new Date(a.Created).getTime(),
      )[0];

      // Extract 6-digit OTP from snippet (format: "...enter the code: 305416")
      const match = latest.Snippet.match(/\b(\d{6})\b/);
      if (match) return match[1];
    }

    // Poll every 500ms
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(
    `No OTP email received for ${email} within ${timeoutMs}ms`,
  );
}

/**
 * Delete all emails in Mailpit (clean slate for tests).
 */
export async function clearMailpit(): Promise<void> {
  await fetch(`${MAILPIT_URL}/api/v1/messages`, { method: "DELETE" });
}
