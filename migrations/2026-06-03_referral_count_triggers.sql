-- Increments subscriptions.referral_count whenever a new match is created
-- for a therapist or a clinic. The /notify-match email reads this column
-- to render "referral N" lines; previously it was always NULL.
--
-- Two triggers: one on matches (solo provider path), one on clinic_matches
-- (clinic path, mapped through clinics.owner_id → subscriptions.therapist_id).
--
-- Idempotent — safe to re-run.
--
-- Run via: Supabase Dashboard → SQL Editor → paste & execute.

CREATE OR REPLACE FUNCTION bump_referral_count_on_match()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE subscriptions
  SET referral_count = COALESCE(referral_count, 0) + 1,
      updated_at     = NOW()
  WHERE therapist_id = NEW.therapist_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_bump_referral_count ON matches;
CREATE TRIGGER trg_bump_referral_count
AFTER INSERT ON matches
FOR EACH ROW
EXECUTE FUNCTION bump_referral_count_on_match();

CREATE OR REPLACE FUNCTION bump_referral_count_on_clinic_match()
RETURNS TRIGGER AS $$
DECLARE
  v_owner_id UUID;
BEGIN
  SELECT owner_id INTO v_owner_id FROM clinics WHERE id = NEW.clinic_id;
  IF v_owner_id IS NULL THEN
    RETURN NEW;
  END IF;
  UPDATE subscriptions
  SET referral_count = COALESCE(referral_count, 0) + 1,
      updated_at     = NOW()
  WHERE therapist_id = v_owner_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_bump_referral_count_clinic ON clinic_matches;
CREATE TRIGGER trg_bump_referral_count_clinic
AFTER INSERT ON clinic_matches
FOR EACH ROW
EXECUTE FUNCTION bump_referral_count_on_clinic_match();
