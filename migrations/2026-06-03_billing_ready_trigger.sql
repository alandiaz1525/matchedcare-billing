-- Flips subscriptions.billing_ready=true when a therapist crosses their
-- free-match threshold. /check-billing (cron) or /start-billing then picks
-- it up and creates the Stripe subscription.
--
-- Thresholds match the founder-pricing rules:
--   provider_founder  → 3 free, billing starts on 3rd accepted match
--   aba_founder       → 1 free, billing starts on 1st accepted match
--   mh_group_founder  → 3 free, billing starts on 3rd accepted match
--
-- Run via: Supabase Dashboard → SQL Editor → paste & execute.

CREATE OR REPLACE FUNCTION mark_billing_ready_on_match()
RETURNS TRIGGER AS $$
DECLARE
  v_plan_type TEXT;
  v_count     INTEGER;
  v_threshold INTEGER;
BEGIN
  IF NEW.status IS DISTINCT FROM 'accepted' THEN
    RETURN NEW;
  END IF;

  SELECT plan_type INTO v_plan_type
  FROM subscriptions
  WHERE therapist_id = NEW.therapist_id;

  IF v_plan_type IS NULL THEN
    RETURN NEW;
  END IF;

  v_threshold := CASE v_plan_type
    WHEN 'aba_founder' THEN 1
    ELSE 3
  END;

  SELECT COUNT(*) INTO v_count
  FROM matches
  WHERE therapist_id = NEW.therapist_id
    AND status = 'accepted';

  IF v_count >= v_threshold THEN
    UPDATE subscriptions
    SET billing_ready = true,
        updated_at    = NOW()
    WHERE therapist_id          = NEW.therapist_id
      AND billing_ready         = false
      AND stripe_subscription_id IS NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_mark_billing_ready ON matches;
CREATE TRIGGER trg_mark_billing_ready
AFTER INSERT ON matches
FOR EACH ROW
EXECUTE FUNCTION mark_billing_ready_on_match();
