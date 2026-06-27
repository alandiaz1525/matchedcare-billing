// Railway cron entry point for the profile-completion reminder sweep.
//
// Runs as a SEPARATE Railway service (same repo) whose start command is
// `node cron-reminders.js` and whose Cron Schedule is set in the Railway
// dashboard (e.g. "0 15 * * *"). It triggers the reminder logic by calling the
// deployed billing server's cron-token-protected endpoint, logs the JSON
// summary, and exits cleanly so the cron container stops.
//
// Why call the HTTP endpoint instead of importing the function: server.js
// starts the Express server and its interval crons on import, so importing it
// here would spin up a second server. Calling the live endpoint keeps this a
// thin, side-effect-free trigger.
//
// Required env (set on the cron service): CRON_SECRET (same value as the API
// service). Optional: REMINDER_CHECK_URL to override the target base URL.

const BASE = (process.env.REMINDER_CHECK_URL || process.env.BILLING_PUBLIC_URL || 'https://matchedcare-billing-production.up.railway.app').replace(/\/$/, '');
const TOKEN = process.env.CRON_SECRET;
const TIMEOUT_MS = 60000;

async function main() {
  if (!TOKEN) {
    console.error('[cron-reminders] CRON_SECRET is not set; aborting.');
    process.exit(1);
  }
  const url = `${BASE}/check-incomplete-profiles`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', headers: { 'x-cron-token': TOKEN }, signal: controller.signal });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) {
      console.error(`[cron-reminders] check failed: HTTP ${res.status}`, body);
      process.exit(1);
    }
    console.log('[cron-reminders] success:', JSON.stringify(body));
    process.exit(0);
  } catch (err) {
    console.error('[cron-reminders] error:', err && err.message ? err.message : err);
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }
}

main();
