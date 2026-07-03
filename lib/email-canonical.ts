/**
 * canonicalizeEmail — email address canonicalization for free-audit-limit enforcement.
 *
 * Problem (NEW-A-02): Gmail ignores dots in the local-part and everything after
 * `+`, so `u.s.e.r@gmail.com`, `user+1@gmail.com`, and `user+2@gmail.com` all
 * deliver to `user@gmail.com`. Counting by exact lowercased email lets a
 * single user create unlimited free audits via aliasing.
 *
 * Fix: for Gmail (gmail.com + googlemail.com), strip dots from the local-part
 * and drop the sub-address suffix (`+...`), then normalise googlemail → gmail.
 * For all other providers, only lowercase + trim (other providers treat dots
 * and plus literally — don't over-normalise and accidentally merge distinct
 * accounts).
 *
 * This canonical form is used ONLY for counting free-audit slots.
 * The raw ownerEmail is stored as-is (for delivery and display).
 */

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * Return the canonical form of `email` for free-audit-limit counting.
 *
 * Examples:
 *   "U.S.Er+promo@gmail.com"   → "user@gmail.com"
 *   "user@googlemail.com"      → "user@gmail.com"
 *   "A.B+C@outlook.com"        → "a.b+c@outlook.com"   (unchanged except lowercase)
 *   "  User@Example.COM  "     → "user@example.com"
 */
export function canonicalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const atIdx = trimmed.lastIndexOf("@");
  if (atIdx === -1) {
    // Not a valid email — return as-is (validation happens elsewhere)
    return trimmed;
  }

  const local = trimmed.slice(0, atIdx);
  const domain = trimmed.slice(atIdx + 1);

  if (GMAIL_DOMAINS.has(domain)) {
    // 1. Strip everything from `+` onwards (sub-address tag)
    const localWithoutTag = local.split("+")[0];
    // 2. Remove all dots from the local-part
    const localNormalized = localWithoutTag.replace(/\./g, "");
    // 3. Normalise googlemail.com → gmail.com
    return `${localNormalized}@gmail.com`;
  }

  // Non-Gmail: only lowercase + trim (already done above)
  return trimmed;
}
