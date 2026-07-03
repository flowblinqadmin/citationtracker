/**
 * ES-090 §b.1 / §b.2 CRIT-1 — shared token TTL.
 *
 * Used by fresh-verify writes, regenerate rotation, and HP-224 re-login
 * rotation. Extracted per HP-235 to eliminate drift between the two call
 * sites (verify + regenerate). If this TTL ever changes, this file is
 * the only edit surface.
 */

export const TOKEN_TTL_MS = 7 * 86_400_000; // 7 days in milliseconds
