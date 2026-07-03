-- Migration: add purchase_token_expires_at to audit_purchases
-- Fix #32: purchaseToken had no expiry — stays valid forever.
-- Set 30-day TTL from creation/delivery so stale tokens can't
-- be used to access PDF/competitor-discovery/citation-check endpoints.

ALTER TABLE audit_purchases
  ADD COLUMN IF NOT EXISTS purchase_token_expires_at timestamptz;
