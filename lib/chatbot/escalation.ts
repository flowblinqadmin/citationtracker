/**
 * Detects customer dissatisfaction in chatbot conversations and sends
 * an alert email to the team when sentiment goes south.
 */

import { Resend } from "resend";

function getResend() {
  return new Resend(process.env.RESEND_API_KEY!);
}
const ALERT_EMAIL = "hello@flowblinq.ai";
const FROM_EMAIL = "FlowBlinq GEO <noreply@send.flowblinq.com>";

// ── Frustration signals ─────────────────────────────────────────────────────

const FRUSTRATION_PATTERNS = [
  // Direct frustration
  /\b(useless|worthless|garbage|trash|terrible|horrible|awful|waste of time)\b/i,
  /\b(doesn'?t work|not working|broken|buggy|glitchy)\b/i,
  /\b(hate|hating|annoying|annoyed|frustrated|frustrating|infuriating)\b/i,
  /\b(scam|rip ?off|fraud|misleading|false|lying|lied)\b/i,
  /\b(worst|sucks|stupid|dumb|idiotic|ridiculous)\b/i,
  // Demands
  /\b(refund|money back|cancel|unsubscribe|delete my account)\b/i,
  /\b(talk to|speak to|speak with|connect me|human|real person|agent|manager|supervisor)\b/i,
  /\b(complaint|complain|report|escalate)\b/i,
  // Repeated failure
  /\b(still not|still doesn'?t|still can'?t|again|already told you|already asked)\b/i,
  /\b(nothing helps|no help|unhelpful|not helpful|pointless)\b/i,
  // Profanity (light check)
  /\b(wtf|bs|damn|hell|crap)\b/i,
];

const DISSATISFACTION_THRESHOLD = 2; // Trigger after 2 frustrated messages in a conversation

// ── Detection ───────────────────────────────────────────────────────────────

export function detectFrustration(message: string): boolean {
  let hits = 0;
  for (const pattern of FRUSTRATION_PATTERNS) {
    if (pattern.test(message)) hits++;
  }
  return hits >= 1; // A single strong signal is enough per message
}

export function shouldEscalate(
  messages: Array<{ role: string; text: string }>,
): boolean {
  const userMessages = messages.filter((m) => m.role === "user");
  let frustrationCount = 0;

  for (const msg of userMessages) {
    if (detectFrustration(msg.text)) {
      frustrationCount++;
    }
  }

  return frustrationCount >= DISSATISFACTION_THRESHOLD;
}

// ── Email alert ─────────────────────────────────────────────────────────────

export async function sendEscalationAlert(opts: {
  domain: string;
  siteId: string;
  userEmail?: string | null;
  conversationHistory: Array<{ role: string; text: string }>;
  triggerMessage: string;
}): Promise<void> {
  const { domain, siteId, userEmail, conversationHistory, triggerMessage } = opts;

  const conversationHtml = conversationHistory
    .map((m) => {
      const label = m.role === "user" ? "Customer" : "Bot";
      const color = m.role === "user" ? "#c2652a" : "#666";
      return `<p style="margin:4px 0"><strong style="color:${color}">${label}:</strong> ${escapeHtml(m.text)}</p>`;
    })
    .join("");

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:600px">
      <h2 style="color:#c2652a;margin-bottom:4px">⚠ Customer Dissatisfaction Alert</h2>
      <p style="color:#666;margin-top:0">The chatbot detected frustration in a conversation.</p>

      <table style="border-collapse:collapse;width:100%;margin:16px 0">
        <tr><td style="padding:4px 8px;color:#666;width:120px">Domain:</td><td style="padding:4px 8px;font-weight:600">${escapeHtml(domain)}</td></tr>
        <tr><td style="padding:4px 8px;color:#666">Site ID:</td><td style="padding:4px 8px"><code>${escapeHtml(siteId)}</code></td></tr>
        ${userEmail ? `<tr><td style="padding:4px 8px;color:#666">User Email:</td><td style="padding:4px 8px">${escapeHtml(userEmail)}</td></tr>` : ""}
        <tr><td style="padding:4px 8px;color:#666">Trigger:</td><td style="padding:4px 8px;color:#c00">"${escapeHtml(triggerMessage)}"</td></tr>
      </table>

      <h3 style="margin-bottom:8px">Conversation</h3>
      <div style="background:#f5f5f7;padding:12px 16px;border-radius:8px;font-size:14px">
        ${conversationHtml}
      </div>

      <p style="color:#999;font-size:12px;margin-top:16px">
        Sent by FlowBlinq GEO Chatbot • <a href="https://geo.flowblinq.com/sites/${encodeURIComponent(siteId)}">View Site</a>
      </p>
    </div>
  `;

  try {
    await getResend().emails.send({
      from: FROM_EMAIL,
      to: ALERT_EMAIL,
      subject: `⚠ Dissatisfied customer on ${domain}`,
      html,
    });
    console.info(`[chatbot-escalation] Alert sent for ${domain} (siteId=${siteId})`);
  } catch (err) {
    console.error("[chatbot-escalation] Failed to send alert:", err);
  }
}

// ── Slack alert (optional — no-op when SLACK_CLEO_WEBHOOK_URL unset) ─────────

type EscalationOpts = {
  domain: string;
  siteId: string;
  userEmail?: string | null;
  conversationHistory: Array<{ role: string; text: string }>;
  triggerMessage: string;
};

const RECENT_TRANSCRIPT_LIMIT = 12;

function recentTranscript(history: Array<{ role: string; text: string }>): Array<{ role: string; text: string }> {
  return history.slice(-RECENT_TRANSCRIPT_LIMIT);
}

function escapeSlackMrkdwn(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function transcriptToText(history: Array<{ role: string; text: string }>): string {
  return history
    .map((m) => `${m.role === "user" ? "Customer" : "Bot"}: ${m.text}`)
    .join("\n");
}

export async function sendSlackAlert(opts: EscalationOpts): Promise<void> {
  const webhook = process.env.SLACK_CLEO_WEBHOOK_URL;
  if (!webhook) {
    console.info("[chatbot-escalation] Slack disabled (env unset)");
    return;
  }

  const { domain, siteId, userEmail, conversationHistory, triggerMessage } = opts;
  // Backticks would let a user message break out of the triple-backtick code
  // block in the Slack payload and inject mrkdwn — strip before embedding.
  const transcript = transcriptToText(recentTranscript(conversationHistory))
    .replace(/`/g, "'")
    .slice(0, 4000);

  const fields: Array<{ type: "mrkdwn"; text: string }> = [
    { type: "mrkdwn", text: `*Domain:*\n${escapeSlackMrkdwn(domain)}` },
    { type: "mrkdwn", text: `*Site ID:*\n\`${escapeSlackMrkdwn(siteId)}\`` },
    { type: "mrkdwn", text: `*Trigger:*\n${escapeSlackMrkdwn(triggerMessage)}` },
  ];
  if (userEmail) {
    fields.push({ type: "mrkdwn", text: `*User Email:*\n${escapeSlackMrkdwn(userEmail)}` });
  }

  const payload = {
    text: `⚠ Cleo escalation on ${escapeSlackMrkdwn(domain)}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "⚠ Cleo escalation", emoji: true },
      },
      { type: "section", fields },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Recent conversation*\n\`\`\`${escapeSlackMrkdwn(transcript)}\`\`\``,
        },
      },
    ],
  };

  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    console.info(`[chatbot-escalation] Slack alert sent for ${domain}`);
  } catch (err) {
    console.error("[chatbot-escalation] Slack alert failed:", err);
  }
}

// ── Linear ticket (optional — no-op when LINEAR_API_KEY/LINEAR_TEAM_ID unset) ─

export async function createLinearIssue(opts: EscalationOpts): Promise<void> {
  const apiKey = process.env.LINEAR_API_KEY;
  const teamId = process.env.LINEAR_TEAM_ID;
  if (!apiKey || !teamId) {
    console.info("[chatbot-escalation] Linear disabled (env unset)");
    return;
  }

  const { domain, siteId, userEmail, conversationHistory, triggerMessage } = opts;
  const transcript = transcriptToText(recentTranscript(conversationHistory));

  const description = [
    `**Domain:** ${domain}`,
    `**Site ID:** \`${siteId}\``,
    userEmail ? `**User:** ${userEmail}` : null,
    `**Trigger:** ${triggerMessage}`,
    "",
    "**Recent conversation**",
    "```",
    transcript,
    "```",
  ]
    .filter(Boolean)
    .join("\n");

  const mutation = `mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier } }
}`;

  try {
    await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          input: {
            teamId,
            title: `Cleo escalation on ${domain}`,
            description,
          },
        },
      }),
    });
    console.info(`[chatbot-escalation] Linear issue created for ${domain}`);
  } catch (err) {
    console.error("[chatbot-escalation] Linear issue failed:", err);
  }
}

// ── Combined escalation (parallel, fire-and-forget) ──────────────────────────

export async function escalateToOps(opts: EscalationOpts): Promise<void> {
  await Promise.allSettled([
    sendEscalationAlert(opts),
    sendSlackAlert(opts),
    createLinearIssue(opts),
  ]);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
