// Flip the global monetization switch (platform_config.monetization_enabled).
//
// Usage (PowerShell, one command):
//   node scripts/toggle-monetization.js on
//   node scripts/toggle-monetization.js off
//
// Protection: requires SUPABASE_SERVICE_ROLE_KEY (the server secret already set
// on the Railway billing service). Without it the script refuses to run, so only
// someone holding the service role key can flip monetization.
//
// IMPORTANT: this switch only gates TOOLING (capacity tools, payer display,
// analytics, seats, multi-site). It NEVER gates matching, and turning it ON does
// NOT charge anyone — existing accounts sit on the free tier until they actively
// subscribe.
//
// Emergency SQL fallback (Supabase SQL editor):
//   update platform_config set monetization_enabled = true  where id = 1;  -- ON
//   update platform_config set monetization_enabled = false where id = 1;  -- OFF

const { createClient } = require('@supabase/supabase-js');

const arg = (process.argv[2] || '').toLowerCase();
if (arg !== 'on' && arg !== 'off') {
  console.error('Usage: node scripts/toggle-monetization.js on|off');
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the environment.');
  process.exit(1);
}

const enabled = arg === 'on';

(async () => {
  try {
    const supabase = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await supabase
      .from('platform_config')
      .update({ monetization_enabled: enabled, updated_at: new Date().toISOString(), updated_by: 'toggle-monetization.js' })
      .eq('id', 1)
      .select('monetization_enabled, updated_at')
      .single();
    if (error) throw error;

    console.log('--------------------------------------------------------------');
    console.log(`monetization_enabled is now: ${data.monetization_enabled ? 'ON' : 'OFF'}`);
    console.log(data.monetization_enabled
      ? '  Paid tooling entitlements are ENFORCED. Upgrade CTAs show. No one is charged until they actively subscribe.'
      : '  FREE MODE: full tooling for everyone. No billing UI.');
    console.log('  Matching is unaffected either way (never gated by tier/payment).');
    console.log(`  updated_at: ${data.updated_at}`);
    console.log('--------------------------------------------------------------');
    process.exit(0);
  } catch (e) {
    console.error('Failed to flip the switch:', e && e.message ? e.message : e);
    process.exit(1);
  }
})();
