/**
 * Admin email allowlist. Single source of truth for operator-only routes.
 * Already hardcoded elsewhere (app/api/audit, verify-domain) — centralised here.
 */

export const ADMIN_EMAILS: ReadonlySet<string> = new Set(["ar@flowblinq.com"]);

export function isAdminEmail(email: string | null | undefined): boolean {
  return !!email && ADMIN_EMAILS.has(email.toLowerCase());
}
