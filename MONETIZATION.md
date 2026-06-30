# Monetization switch & operating guide

MatchedCare operates under Florida's Patient Brokering Act. The hard invariants below are **unbreakable** and are enforced in data/architecture, not policy.

## Hard invariants
1. **Matching is never gated by tier, subscription, or payment.** Every account — including free — gets unlimited matches.
2. **Match ranking reads clinical-fit signals only.** No tier/subscription/payment input. `match_audit` logs the fit inputs as proof.
3. **No tier buys better placement.** Enforced architecturally.
4. The global switch only gates **TOOLING** (capacity tools, payer display, analytics, seats, multi-site). OFF = everyone gets full tooling. ON = tooling enforced per tier. Invariants 1–3 hold in both states.
5. **On subscription lapse, an account drops to free tooling but keeps matching.** Never cut matches for non-payment.
6. **Flipping the switch ON never auto-charges anyone.** Accounts default to free and are charged only if they actively subscribe.
7. **Existing providers are preserved through every migration** (additive, idempotent, backed up, counts verified).

## The switch
Single source of truth: `platform_config.monetization_enabled` (Postgres), read everywhere via `is_monetization_enabled()`. Flippable **without a redeploy**. Default `false` (launch/free mode).

> Note: the legacy env `FREE_MODE` / `VITE_FREE_MODE` is being superseded by this DB flag (Phase 2 wires the app to read `is_monetization_enabled()` live). Until then the DB flag is the canonical state.

### Flip it (PowerShell, one command at a time)
```powershell
node scripts/toggle-monetization.js on
node scripts/toggle-monetization.js off
```
Requires `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (already set on the Railway billing service — possessing the service-role key is the protection).

### Emergency SQL fallback (Supabase SQL editor)
```sql
update platform_config set monetization_enabled = true  where id = 1;  -- ON
update platform_config set monetization_enabled = false where id = 1;  -- OFF
```

### Check progress toward the free target
```powershell
node scripts/provider-count.js
```
Prints completed/total providers vs the `free_provider_target` (100). Informational only — the switch stays manual.

## Founder cohort & billing opt-in (Phase 5)
Grandfathering and the no-auto-charge guarantee are structural, not policy:

- **Cohort** lives on `organizations.cohort` (`founder` | `standard`), stamped at signup by the live switch state via the `trg_stamp_org_cohort` trigger:
  - joined while the switch is **OFF** → `founder` (grandfathered, keeps founder→standard pricing forever),
  - joined while the switch is **ON** → `standard` (starts at standard pricing, no founder discount).
  - All providers who existed before Phase 5 were backfilled to `founder`.
  - `account_cohort(uid)` resolves an account's cohort; the billing server pins it onto `subscriptions.cohort` at opt-in time.
- **Billing opt-in** (`subscriptions.billing_opt_in`, default `false`) is the structural form of invariant 6. It is set `true` only when a provider **voluntarily saves a payment method** (`/confirm-setup-intent`, `/verify-payment-method`). The sole automated billing path (`runBillingCheck`) charges **only** `billing_opt_in = true` rows, and `startBillingForTherapist` refuses to charge anyone not opted in. So flipping the switch ON can never auto-charge a provider who hasn't opted in.

### Inspect cohorts / opt-in before flipping
```powershell
node scripts/cohort-report.js
```
Shows founder vs standard counts, how many providers have opted into billing, and how many have active Stripe subscriptions.

## Operating timeline
- **Launch / today:** `monetization_enabled = false`. Everyone free, full tooling, unlimited matching. Build everything dormant.
- **When ready to monetize:** `node scripts/toggle-monetization.js on`. Activates tooling entitlements + upgrade CTAs. Charges no one; accounts sit on free until they subscribe. Founder cohort keeps locked founder pricing.
- **Roll back instantly:** `node scripts/toggle-monetization.js off`.
