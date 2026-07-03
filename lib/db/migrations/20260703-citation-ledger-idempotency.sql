-- Citation-service ledger idempotency (the ONE migration this repo ships).
--
-- Additive + geo-compatible: geo never writes these `type` values, so the
-- partial index cannot affect its ledger writes. For citation types,
-- site_id carries the tracker run id (geo precedent: BB-03 stores Stripe
-- session ids in site_id), and this index makes each (run, op) exactly-once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_tx_citation_run_op
  ON credit_transactions (site_id, type)
  WHERE type IN ('citation_run', 'citation_run_refund', 'citation_redebit');
