-- Adds the remaining columns the billing server reads/writes on
-- subscriptions but didn't previously exist:
--   founder_ends_at      — set by /start-billing when the schedule's
--                          founder phase has a known end date, used by
--                          the dashboard to show when standard pricing
--                          kicks in.
--   current_period_end   — synced from the Stripe subscription on every
--                          customer.subscription.updated webhook so the
--                          dashboard can show the next renewal date.
--   referral_count       — incremented by the trigger below so the
--                          match-notification email can render the
--                          "referral N of M" line.
--
-- Idempotent — safe to re-run.
--
-- Run via: Supabase Dashboard → SQL Editor → paste & execute.

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS founder_ends_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS referral_count     INTEGER DEFAULT 0;
