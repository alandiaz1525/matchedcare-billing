// Informational: how many providers are on the platform vs the free target.
// Helps decide when you're near ~100 and might consider flipping monetization on.
// The switch stays MANUAL — this never flips anything.
//
// Usage (PowerShell): node scripts/provider-count.js

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

    // Total provider accounts.
    const { count: total, error: e1 } = await supabase
      .from('therapists').select('*', { count: 'exact', head: true });
    if (e1) throw e1;

    // "Completed" = finished onboarding (has credentials) — the meaningful supply number.
    const { count: completed, error: e2 } = await supabase
      .from('therapists').select('*', { count: 'exact', head: true }).not('credentials', 'is', null);
    if (e2) throw e2;

    const { data: cfg } = await supabase
      .from('platform_config').select('free_provider_target, monetization_enabled').eq('id', 1).single();

    const target = cfg && cfg.free_provider_target != null ? cfg.free_provider_target : 100;
    const mon = cfg ? cfg.monetization_enabled : false;

    console.log('--------------------------------------------------------------');
    console.log(`Providers (completed profiles): ${completed} / ${target} target`);
    console.log(`Providers (total accounts):     ${total}`);
    console.log(`Monetization switch:            ${mon ? 'ON' : 'OFF (free mode)'}`);
    if (!mon && completed >= target) {
      console.log('  >> You are at/above the target. Consider: node scripts/toggle-monetization.js on');
    }
    console.log('--------------------------------------------------------------');
    process.exit(0);
  } catch (e) {
    console.error('Failed to count providers:', e && e.message ? e.message : e);
    process.exit(1);
  }
})();
