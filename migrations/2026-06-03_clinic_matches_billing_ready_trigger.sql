-- Flips subscriptions.billing_ready=true when a clinic crosses its
-- free-match threshold on clinic_matches (sister to the existing trigger
-- on the matches table for solo providers).
--
-- Mapping: clinic_matches.clinic_id → clinics.owner_id → subscriptions.therapist_id
-- (clinic owners are billed via the same subscriptions row keyed by their user_id).
--
-- Thresholds match the founder-pricing rules:
--   aba_founder       → 1 free, billing starts on 1st clinic match
--   mh_group_founder  → 3 free, billing starts on 3rd clinic match
--
-- Run via: Supabase Dashboard → SQL Editor → paste & execute.

CREATE OR REPLACE FUNCTION mark_billing_ready_on_clinic_match()
RETURNS TRIGGER AS $$
DECLARE
  v_owner_id  UUID;
  v_plan_type TEXT;
  v_count     INTEGER;
  v_threshold INTEGER;
BEGIN
  SELECT owner_id INTO v_owner_id
  FROM clinics
  WHERE id = NEW.clinic_id;

  IF v_owner_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT plan_type INTO v_plan_type
  FROM subscriptions
  WHERE therapist_id = v_owner_id;

  IF v_plan_type IS NULL THEN
    RETURN NEW;
  END IF;

  v_threshold := CASE v_plan_type
    WHEN 'aba_founder' THEN 1
    WHEN 'mh_group_founder' THEN 3
    ELSE 9999
  END;

  SELECT COUNT(*) INTO v_count
  FROM clinic_matches
  WHERE clinic_id = NEW.clinic_id;

  IF v_count >= v_threshold THEN
    UPDATE subscriptions
    SET billing_ready = true,
        updated_at    = NOW()
    WHERE therapist_id          = v_owner_id
      AND billing_ready         = false
      AND stripe_subscription_id IS NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_mark_billing_ready_clinic ON clinic_matches;
CREATE TRIGGER trg_mark_billing_ready_clinic
AFTER INSERT ON clinic_matches
FOR EACH ROW
EXECUTE FUNCTION mark_billing_ready_on_clinic_match();
