-- Adds the columns that /start-billing and /check-billing read/write on the
-- subscriptions table. Idempotent — safe to re-run.
--
-- Run via: Supabase Dashboard → SQL Editor → paste & execute.

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS provider_count      INTEGER     DEFAULT 1,
  ADD COLUMN IF NOT EXISTS billing_ready       BOOLEAN     DEFAULT false,
  ADD COLUMN IF NOT EXISTS billing_error       TEXT,
  ADD COLUMN IF NOT EXISTS billing_started_at  TIMESTAMPTZ;

-- Partial index speeds up the /check-billing scan, which looks for rows that
-- are flagged ready but don't yet have a Stripe subscription.
CREATE INDEX IF NOT EXISTS idx_subscriptions_billing_pending
  ON subscriptions (billing_ready)
  WHERE billing_ready = true AND stripe_subscription_id IS NULL;
