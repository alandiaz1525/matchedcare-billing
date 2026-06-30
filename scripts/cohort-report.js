// Informational: pricing-cohort + billing-opt-in breakdown.
//
//   founder  = grandfathered providers who joined while the platform was free
//              (keep the founder->standard schedule forever).
//   standard = providers who joined after monetization went live
//              (start at standard pricing, no founder discount).
//
// Also shows how many providers have voluntarily opted into billing
// (billing_opt_in=true). Flipping the monetization switch can only ever charge
// the opted-in set — this script lets you confirm that before/after a flip.
//
// Usage (PowerShell): node scripts/cohort-report.js

const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the environment.');
  process.exit(1);
}

(async () => {
  try {
    const supabase = createClient(url, key, { auth: { persistSession: false } });

    const counts = async (table, col, val) => {
      const q = supabase.from(table).select('*', { count: 'exact', head: true });
      const { count, error } = val === undefined ? await q : await q.eq(col, val);
      if (error) throw error;
      return count || 0;
    };

    const orgsTotal = await counts('organizations');
    const orgsFounder = await counts('organizations', 'cohort', 'founder');
    const orgsStandard = await counts('organizations', 'cohort', 'standard');
    const optedIn = await counts('subscriptions', 'billing_opt_in', true);
    const withSub = await (async () => {
      const { count, error } = await supabase
        .from('subscriptions').select('*', { count: 'exact', head: true })
        .not('stripe_subscription_id', 'is', null);
      if (error) throw error;
      return count || 0;
    })();

    const { data: cfg } = await supabase
      .from('platform_config').select('monetization_enabled').eq('id', 1).single();
    const mon = cfg ? cfg.monetization_enabled : false;

    console.log('--------------------------------------------------------------');
    console.log(`Monetization switch:            ${mon ? 'ON' : 'OFF (free mode)'}`);
    console.log(`Organizations (total):          ${orgsTotal}`);
    console.log(`  founder (grandfathered):      ${orgsFounder}`);
    console.log(`  standard (post-monetization): ${orgsStandard}`);
    console.log(`Providers opted into billing:   ${optedIn}`);
    console.log(`Active Stripe subscriptions:    ${withSub}`);
    console.log('--------------------------------------------------------------');
    console.log('Note: only opted-in providers can ever be charged. Flipping the');
    console.log('switch ON never auto-charges anyone (invariant 6).');
    process.exit(0);
  } catch (e) {
    console.error('cohort-report failed:', e && e.message ? e.message : e);
    process.exit(1);
  }
})();
