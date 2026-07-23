const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const twilio = require('twilio');

const app = express();
const PORT = process.env.PORT || 3001;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.FROM_EMAIL || 'MatchedCare <notifications@matchedcare.us>';

// Early-access FREE MODE. While ON, no subscription is ever started/charged and
// transactional emails say the platform is free. Mirrors VITE_FREE_MODE on the
// frontend. Flip OFF (set FREE_MODE=false on Railway) to resume billing.
// Defaults ON (current launch strategy) when unset.
const FREE_MODE = !['false', '0', 'off', 'no'].includes(String(process.env.FREE_MODE ?? 'true').toLowerCase());
const ALLOWED_RETURN_ORIGINS = new Set([
  'https://matchedcare.us',
  'https://www.matchedcare.us',
  'http://localhost:5173',
  'http://localhost:3000',
]);

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

async function requireUser(req, res, next) {
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: 'Invalid authentication token' });

  req.authUser = data.user;
  next();
}

async function requireAdmin(req, res, next) {
  await requireUser(req, res, async () => {
    // Admin authority comes ONLY from app_metadata.role — it is service-role-set
    // and not user-editable. Never trust user_metadata.role (settable by the user
    // via the auth API) NOR profiles.role: the profiles RLS UPDATE policy is
    // scoped only to `user_id = auth.uid()` with no column restriction, so any
    // authenticated user can PATCH their own profiles.role = 'admin' with the
    // public anon key and self-promote. app_metadata is the single source of truth.
    if (req.authUser.app_metadata?.role === 'admin') return next();
    return res.status(403).json({ error: 'Admin access required' });
  });
}

function allowedReturnUrl(value, fallback = 'https://matchedcare.us') {
  try {
    const url = new URL(value || fallback);
    if (ALLOWED_RETURN_ORIGINS.has(url.origin)) return url.toString();
  } catch {}
  return fallback;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeEmail(value) {
  const email = String(value || '').trim();
  return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email) ? email : '';
}

// Log the real error server-side, return a sanitized message to the client.
// Stripe and Supabase error messages can include internal details (rate-limit
// info, table names, payment_method IDs, etc.) that we shouldn't echo back.
function safeError(res, route, err, fallback, status = 500) {
  console.error(`${route}:`, err?.message || err);
  return res.status(status).json({ error: fallback });
}

// Shared per-IP rate limiter. Returns a function that returns true if the
// caller is within budget. Each limiter has its own bounded Map keyed by IP.
function makeRateLimiter(windowMs, maxHits) {
  const hits = new Map();
  return function check(ip) {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (recent.length >= maxHits) {
      hits.set(ip, recent);
      return false;
    }
    recent.push(now);
    hits.set(ip, recent);
    return true;
  };
}

// Express middleware that plugs a limiter into the route chain. Run BEFORE
// auth so we don't pay the auth lookup cost for spammers.
function rateLimit(limiter) {
  return (req, res, next) => {
    const ipHeader = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    const ip = String(ipHeader).split(',')[0].trim() || 'unknown';
    if (!limiter(ip)) return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    next();
  };
}

const setupIntentLimiter = makeRateLimiter(60 * 1000, 10);
const notifyMatchLimiter = makeRateLimiter(60 * 1000, 20);
const npiLookupLimiter = makeRateLimiter(60 * 1000, 10);

// In-memory webhook idempotency. Stripe retries failed events on an
// exponential backoff (first retry ~1h later) — if we already processed an
// event, we should ack it without re-running the side effects. Bounded set so
// memory doesn't grow without limit; events older than the cap can theoretically
// double-process if Stripe retries them after a long gap, but that's a far
// smaller risk than the current "every retry double-processes" state.
const WEBHOOK_EVENT_CAP = 1000;
const processedWebhookEvents = new Set();
const processedWebhookOrder = [];
function seenWebhookEvent(eventId) {
  if (processedWebhookEvents.has(eventId)) return true;
  processedWebhookEvents.add(eventId);
  processedWebhookOrder.push(eventId);
  if (processedWebhookOrder.length > WEBHOOK_EVENT_CAP) {
    const old = processedWebhookOrder.shift();
    processedWebhookEvents.delete(old);
  }
  return false;
}

// Twilio SMS client (only init if credentials exist)
let twilioClient = null;
let TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER || null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  console.log('Twilio SMS: ENABLED');
} else {
  console.log('Twilio SMS: DISABLED (no credentials)');
}

// Helper: send SMS if Twilio is configured and user opted in
async function sendSMS(to, message) {
  if (!twilioClient || !TWILIO_PHONE || !to) return false;
  // Clean phone number — ensure it starts with +1
  let phone = to.replace(/[^0-9+]/g, '');
  if (!phone.startsWith('+')) {
    if (phone.startsWith('1') && phone.length === 11) phone = '+' + phone;
    else if (phone.length === 10) phone = '+1' + phone;
    else return false;
  }
  try {
    // TCPA compliance: ensure every outgoing SMS carries an opt-out notice.
    // Appended centrally so no caller can forget it; skipped only if the
    // message already references STOP.
    const body = /\bstop\b/i.test(message) ? message : `${message} Reply STOP to opt out.`;
    await twilioClient.messages.create({ body, from: TWILIO_PHONE, to: phone });
    console.log('SMS sent to:', phone.replace(/(\+?\d{1,3})\d+(\d{4})/, '$1***$2'));
    return true;
  } catch (err) {
    console.error('SMS error:', err.message);
    return false;
  }
}

// Helper: check if user opted into SMS
async function userOptedInSMS(userId) {
  try {
    const { data } = await supabase.from('clients').select('sms_opt_in, phone').eq('user_id', userId).single();
    if (data?.sms_opt_in && data?.phone) return data.phone;
    // Also check intake_responses for smsOptIn
    const { data: intake } = await supabase.from('intake_responses').select('response_data').eq('client_id', userId).eq('section_key', 'full_intake').single();
    if (intake?.response_data?.smsOptIn && intake?.response_data?.phone) return intake.response_data.phone;
  } catch {}
  // Check profiles table
  try {
    const { data } = await supabase.from('profiles').select('phone').eq('user_id', userId).single();
    return data?.phone || null;
  } catch {}
  return null;
}

const corsOptions = {
  origin: [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5173',
    'https://matchedcare.us',
    'https://www.matchedcare.us',
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Stripe webhook (raw body)
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  // Stripe retries on failure — skip if already processed.
  if (seenWebhookEvent(event.id)) {
    return res.json({ received: true, duplicate: true });
  }
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.mode === 'setup' && session.metadata?.user_id) {
        await supabase.from('subscriptions').update({ stripe_customer_id: session.customer, status: 'active', updated_at: new Date().toISOString() }).eq('therapist_id', session.metadata.user_id);
      }
      break;
    }
    case 'setup_intent.succeeded': {
      const si = event.data.object;
      const userId = si.metadata?.user_id;
      if (userId) {
        if (si.payment_method && si.customer) {
          try {
            await stripe.customers.update(si.customer, {
              invoice_settings: { default_payment_method: si.payment_method },
            });
          } catch (e) {
            console.warn('default PM update failed:', e.message);
          }
        }
        await supabase
          .from('subscriptions')
          .update({
            payment_method_pending: false,
            stripe_customer_id: si.customer,
            status: 'active',
            updated_at: new Date().toISOString(),
          })
          .eq('therapist_id', userId);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const { data } = await supabase.from('subscriptions').select('therapist_id').eq('stripe_customer_id', sub.customer).single();
      if (data) {
        const patch = {
          stripe_subscription_id: sub.id,
          status: sub.status,
          current_period_end: sub.current_period_end
            ? new Date(sub.current_period_end * 1000).toISOString()
            : null,
          updated_at: new Date().toISOString(),
        };
        // Detect plan_type from the first item's price id by reverse-looking
        // up PLAN_PRICES. Lets admin changes in the Stripe dashboard flow
        // back to our DB instead of going stale.
        const firstPriceId = sub.items?.data?.[0]?.price?.id;
        if (firstPriceId) {
          for (const [planType, phases] of Object.entries(PLAN_PRICES)) {
            const all = [phases.founder, phases.standard];
            if (all.some((p) => p?.base === firstPriceId)) {
              patch.plan_type = planType;
              break;
            }
          }
        }
        // Quantity for MH-group addons is the per-provider headcount.
        const addonItem = (sub.items?.data || []).find((i) =>
          Object.values(PLAN_PRICES).some(
            (p) => p.founder?.perProvider === i.price?.id || p.standard?.perProvider === i.price?.id
          )
        );
        if (addonItem?.quantity) patch.provider_count = addonItem.quantity;
        await supabase.from('subscriptions').update(patch).eq('therapist_id', data.therapist_id);
      }
      break;
    }
    case 'customer.subscription.deleted': {
      await supabase.from('subscriptions').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('stripe_subscription_id', event.data.object.id);
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const reason = invoice.last_finalization_error?.message
        || invoice.last_payment_error?.message
        || `Invoice ${invoice.id} payment failed (attempt ${invoice.attempt_count})`;
      const subId = invoice.subscription;
      const customerId = invoice.customer;
      try {
        if (subId) {
          await supabase
            .from('subscriptions')
            .update({
              status: 'past_due',
              billing_error: reason,
              updated_at: new Date().toISOString(),
            })
            .eq('stripe_subscription_id', subId);
        } else if (customerId) {
          await supabase
            .from('subscriptions')
            .update({
              status: 'past_due',
              billing_error: reason,
              updated_at: new Date().toISOString(),
            })
            .eq('stripe_customer_id', customerId);
        }
      } catch (e) {
        console.error('invoice.payment_failed update error:', e.message);
      }
      break;
    }
  }
  res.json({ received: true });
});

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'matchedcare-billing', email: !!process.env.RESEND_API_KEY, sms: !!twilioClient });
});

// Deep health: actually pings each upstream dependency and reports per-check
// status. Use this from uptime monitors instead of /health when you want to
// catch "Resend down" / "Stripe degraded" / "Supabase RLS broken" before users
// do. Probes run in parallel with a 3s per-check timeout so a single hung
// dependency can't tarpit the response.
async function probeDependency(name, fn, timeoutMs = 3000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
  });
  try {
    await Promise.race([fn(), timeout]);
    return { name, status: 'ok' };
  } catch (e) {
    const msg = e?.message || String(e);
    console.error(`health-deep ${name}:`, msg);
    return { name, status: msg === 'timeout' ? 'timeout' : 'down' };
  } finally {
    clearTimeout(timer);
  }
}

app.get('/health/deep', async (req, res) => {
  const checks = await Promise.all([
    probeDependency('supabase', async () => {
      const { error } = await supabase.from('subscriptions').select('therapist_id').limit(1);
      if (error) throw new Error(error.message);
    }),
    probeDependency('stripe', async () => {
      await stripe.balance.retrieve();
    }),
    probeDependency('resend', async () => {
      if (!process.env.RESEND_API_KEY) throw new Error('not configured');
      const r = await fetch('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    }),
    probeDependency('twilio', async () => {
      if (!twilioClient || !process.env.TWILIO_ACCOUNT_SID) throw new Error('not configured');
      await twilioClient.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
    }),
  ]);
  const anyDown = checks.some((c) => c.status !== 'ok');
  res.status(anyDown ? 503 : 200).json({
    status: anyDown ? 'degraded' : 'ok',
    service: 'matchedcare-billing',
    checks,
  });
});

app.get('/npi-lookup', rateLimit(npiLookupLimiter), async (req, res) => {
  try {
    const number = String(req.query.number || '').trim();
    if (!/^\d{10}$/.test(number)) {
      return res.status(400).json({ error: 'number must be exactly 10 digits' });
    }
    const url = `https://npiregistry.cms.hhs.gov/api/?version=2.1&number=${number}&limit=1`;
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(502).json({ error: `NPI registry returned ${response.status}` });
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    safeError(res, 'npi-lookup', err, 'NPI lookup failed.');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// EMAIL TEMPLATES
// ═══════════════════════════════════════════════════════════════════════════

function emailWrapper(content) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>
body{margin:0;padding:0;background:#F5F3F0;font-family:'Helvetica Neue',Arial,sans-serif}
.container{max-width:560px;margin:0 auto;padding:40px 24px}
.card{background:white;border-radius:16px;padding:40px 32px;box-shadow:0 2px 12px rgba(0,0,0,0.06)}
.logo{text-align:center;margin-bottom:32px}
.logo-text{font-size:24px;font-weight:600;color:#1A242E;letter-spacing:-0.5px}
.logo-sub{font-size:11px;color:#9A9DA4;text-transform:uppercase;letter-spacing:2px;margin-top:4px}
h1{font-size:22px;font-weight:500;color:#1A242E;margin:0 0 8px;line-height:1.3}
.subtitle{font-size:15px;color:#6E7178;line-height:1.6;margin:0 0 28px}
.info-box{background:#ECF2F6;border-radius:12px;padding:20px 24px;margin-bottom:20px}
.info-label{font-size:11px;color:#9A9DA4;text-transform:uppercase;letter-spacing:1px;margin:0 0 4px}
.info-value{font-size:16px;color:#1A242E;font-weight:500;margin:0}
.cta{display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#4A7C9B,#3A6580);color:white;text-decoration:none;border-radius:28px;font-size:14px;font-weight:500;letter-spacing:0.3px;margin-top:8px}
.cta-wrap{text-align:center;margin-top:28px}
.highlight{background:#ECF2F6;border-left:3px solid #4A7C9B;padding:14px 18px;border-radius:0 10px 10px 0;margin:16px 0}
.highlight p{font-size:14px;color:#2C3038;line-height:1.6;margin:0}
.score{display:inline-block;background:#ECF2F6;border-radius:8px;padding:4px 12px;font-size:14px;font-weight:600;color:#2E5F7A}
.footer{text-align:center;padding:24px 0}
.footer-text{font-size:12px;color:#9A9DA4;line-height:1.5}
.footer-link{color:#4A7C9B;text-decoration:none}
</style></head><body><div class="container"><div class="card"><div class="logo"><div class="logo-text">MatchedCare</div><div class="logo-sub">The right provider changes everything</div></div>${content}</div><div class="footer"><p class="footer-text">This email was sent by MatchedCare.<br><a href="https://matchedcare.us" class="footer-link">matchedcare.us</a> · <a href="https://matchedcare.us?v=privacy" class="footer-link">Privacy Policy</a></p></div></div></body></html>`;
}

// Expectation-setting blocks shared across match emails so the client and the
// provider work from the SAME script (client knows what to send first; provider
// knows what the client was told to expect).
function clientNextStepsBlock(providerName) {
  return `<div class="info-box"><p class="info-label">What happens next</p>
    <p style="font-size:14px;color:#2C3038;line-height:1.7;margin:0 0 10px">Reach out to ${escapeHtml(providerName || 'your matched provider')} directly to get started. In your first message, it helps to include your insurance (or that you're planning to pay out of pocket), two or three times you're generally free, and a sentence about what's bringing you to therapy.</p>
    <p style="font-size:14px;color:#2C3038;line-height:1.7;margin:0">Most providers begin with a brief phone consultation — usually 10-15 minutes — before scheduling your first session, so you can both make sure it feels like the right fit.</p></div>`;
}
function providerFirstContactScript() {
  return `<div class="highlight"><p>The client has been asked to include their insurance, availability, and a brief note about what's bringing them in with their first message — and told to expect a short consultation call (10-15 min) before scheduling. You're both working from the same script.</p></div>`;
}

function clientMatchEmail({ clientName, providerName, providerCredentials, providerType, matchScore, providerEmail, explanation }) {
  const email = safeEmail(providerEmail);
  return emailWrapper(`
    <h1>You've been matched!</h1>
    <p class="subtitle">Great news, ${escapeHtml(clientName)}. We've found a provider who fits what you're looking for.</p>
    <div class="info-box"><p class="info-label">Your Match</p><p class="info-value">${escapeHtml(providerName)}</p>
    ${providerCredentials ? `<p style="font-size:13px;color:#6E7178;margin:4px 0 0">${escapeHtml(providerCredentials)} - ${escapeHtml(providerType || 'Provider')}</p>` : ''}
    ${matchScore ? `<p style="margin:8px 0 0"><span class="score">${Math.round(matchScore)}% compatibility</span></p>` : ''}</div>
    ${explanation ? `<div class="highlight"><p>${escapeHtml(explanation)}</p></div>` : ''}
    ${email ? `<div class="info-box"><p class="info-label">Contact</p><p class="info-value"><a href="mailto:${email}" style="color:#4A7C9B;text-decoration:none">${escapeHtml(email)}</a></p></div>` : ''}
    <p style="font-size:14px;color:#6E7178;line-height:1.6">Your provider has been notified and is ready to connect.</p>
    ${clientNextStepsBlock(providerName)}
    <div class="cta-wrap"><a href="https://matchedcare.us?v=dashboard" class="cta">Go to Dashboard</a></div>`);
}

function providerMatchEmail({ providerName, clientName, clientEmail, matchScore, concerns, explanation, referralCount }) {
  const email = safeEmail(clientEmail);
  return emailWrapper(`
    <h1>New client referral</h1>
    <p class="subtitle">${escapeHtml(providerName)}, you have a new matched client.</p>
    <div class="info-box"><p class="info-label">Client</p><p class="info-value">${escapeHtml(clientName)}</p>
    ${matchScore ? `<p style="margin:8px 0 0"><span class="score">${Math.round(matchScore)}% compatibility</span></p>` : ''}</div>
    ${concerns && concerns.length > 0 ? `<div class="info-box"><p class="info-label">Primary Concerns</p><p style="font-size:14px;color:#2C3038;margin:4px 0 0">${escapeHtml(concerns.join(', '))}</p></div>` : ''}
    ${explanation ? `<div class="highlight"><p><strong>Why you were matched:</strong> ${escapeHtml(explanation)}</p></div>` : ''}
    ${email ? `<div class="info-box"><p class="info-label">Client Contact</p><p class="info-value"><a href="mailto:${email}" style="color:#4A7C9B;text-decoration:none">${escapeHtml(email)}</a></p></div>` : ''}
    ${providerFirstContactScript()}
    ${FREE_MODE ? `<p style="font-size:13px;color:#9A9DA4;margin-top:16px">MatchedCare is free during early access — there's no charge for this or any referral right now.</p>` : (referralCount !== undefined ? `<p style="font-size:13px;color:#9A9DA4;margin-top:16px">This is referral #${escapeHtml(referralCount)}${referralCount < 5 ? ' of your 5 free referrals.' : '. Billing is now active.'}</p>` : '')}
    <div class="cta-wrap"><a href="https://matchedcare.us?v=dashboard" class="cta">View in Dashboard</a></div>`);
}

function clinicMatchEmail({ clinicName, clientName, clientEmail, serviceType, matchScore, explanation, ageGroup }) {
  const serviceLabels = { aba: 'ABA Services', speech: 'Speech Therapy', occupational_therapy: 'Occupational Therapy' };
  const email = safeEmail(clientEmail);
  return emailWrapper(`
    <h1>New client matched to your clinic</h1>
    <p class="subtitle">${escapeHtml(clinicName)}, a new client has been matched to your practice.</p>
    <div class="info-box"><p class="info-label">Client</p><p class="info-value">${escapeHtml(clientName)}</p>
    <p style="font-size:13px;color:#6E7178;margin:4px 0 0">Service: ${escapeHtml(serviceLabels[serviceType] || serviceType)}${ageGroup ? ' - Age group: ' + escapeHtml(ageGroup) : ''}</p>
    ${matchScore ? `<p style="margin:8px 0 0"><span class="score">${Math.round(matchScore)}% compatibility</span></p>` : ''}</div>
    ${explanation ? `<div class="highlight"><p>${escapeHtml(explanation)}</p></div>` : ''}
    ${email ? `<div class="info-box"><p class="info-label">Client Contact</p><p class="info-value"><a href="mailto:${email}" style="color:#4A7C9B;text-decoration:none">${escapeHtml(email)}</a></p></div>` : ''}
    <p style="font-size:14px;color:#6E7178;line-height:1.6">Please assign this client to an available provider and reach out to schedule.</p>
    ${providerFirstContactScript()}
    <div class="cta-wrap"><a href="https://matchedcare.us?v=dashboard" class="cta">View in Dashboard</a></div>`);
}

function welcomeEmail({ name, role }) {
  const msgs = FREE_MODE
    ? {
        client: "We're here to help you find a provider who truly fits.",
        therapist: "Complete your profile and you'll start receiving matched client referrals. MatchedCare is free for providers during early access — no payment method required.",
        clinic: "Once verified, you'll start receiving matched client referrals automatically. MatchedCare is free for clinics during early access — no payment method required.",
      }
    : {
        client: "We're here to help you find a provider who truly fits.",
        therapist: "Complete your profile and you'll start receiving matched client referrals. Your first 3 referrals are free.",
        clinic: "Once activated, you'll start receiving matched client referrals automatically.",
      };
  return emailWrapper(`<h1>Welcome to MatchedCare</h1><p class="subtitle">${escapeHtml(name)}, your account has been created.</p><p style="font-size:14px;color:#6E7178;line-height:1.7">${escapeHtml(msgs[role] || msgs.client)}</p><div class="cta-wrap"><a href="https://matchedcare.us" class="cta">Get Started</a></div>`);
}

// ── Warm-handoff templates ──────────────────────────────────────────────────
// Alert to the THERAPIST when a new match is pending their review.
function therapistMatchAlertEmail({ providerName, clientFirstName, concern, insurance, schedule, matchScore }) {
  return emailWrapper(`
    <h1>New client match</h1>
    <p class="subtitle">${escapeHtml(providerName || 'there')}, a new client has been matched to you and is waiting for your review.</p>
    <div class="info-box"><p class="info-label">Client</p><p class="info-value">${escapeHtml(clientFirstName || 'New client')}</p>
    ${matchScore ? `<p style="margin:8px 0 0"><span class="score">${Math.round(matchScore)}% compatibility</span></p>` : ''}</div>
    ${concern ? `<div class="info-box"><p class="info-label">Primary concern</p><p class="info-value">${escapeHtml(concern)}</p></div>` : ''}
    ${insurance ? `<div class="info-box"><p class="info-label">Insurance</p><p class="info-value">${escapeHtml(insurance)}</p></div>` : ''}
    ${schedule ? `<div class="info-box"><p class="info-label">Preferred schedule</p><p class="info-value">${escapeHtml(schedule)}</p></div>` : ''}
    <p style="font-size:14px;color:#6E7178;line-height:1.6">Review this match and accept to see full client details and connect.</p>
    ${providerFirstContactScript()}
    <div class="cta-wrap"><a href="https://matchedcare.us?v=dashboard" class="cta">Review Match</a></div>`);
}

// Avatar block for emails: photo if present, else an initials circle.
function emailAvatar(name, photoUrl) {
  const initials = String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0] ? w[0].toUpperCase() : '').join('') || '?';
  if (photoUrl) return `<img src="${escapeHtml(photoUrl)}" width="72" height="72" alt="" style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:3px solid #ECF2F6" />`;
  return `<div style="width:72px;height:72px;border-radius:50%;background:#4A7C9B;color:#fff;font-size:26px;font-weight:600;line-height:72px;text-align:center;font-family:'Helvetica Neue',Arial,sans-serif">${escapeHtml(initials)}</div>`;
}

// Notify the CLIENT that the therapist accepted.
function clientAcceptedEmail({ clientName, providerName, credentials, providerType, headline, specialties, photoUrl, contactEmail }) {
  const email = safeEmail(contactEmail);
  return emailWrapper(`
    <h1>Great news — we found your therapist!</h1>
    <p class="subtitle">${escapeHtml(clientName || 'there')}, ${escapeHtml(providerName || 'your therapist')} has accepted your match and is ready to connect.</p>
    <div style="text-align:center;margin:8px 0 20px">${emailAvatar(providerName, photoUrl)}
      <p style="font-size:18px;color:#1A242E;font-weight:600;margin:12px 0 2px">${escapeHtml(providerName || 'Your therapist')}</p>
      ${(credentials || providerType) ? `<p style="font-size:13px;color:#6E7178;margin:0">${escapeHtml([credentials, providerType].filter(Boolean).join(' · '))}</p>` : ''}
    </div>
    ${headline ? `<div class="highlight"><p>${escapeHtml(headline)}</p></div>` : ''}
    ${specialties && specialties.length ? `<div class="info-box"><p class="info-label">Specialties</p><p class="info-value">${escapeHtml(specialties.join(', '))}</p></div>` : ''}
    ${email ? `<div class="info-box"><p class="info-label">Contact</p><p class="info-value"><a href="mailto:${email}" style="color:#4A7C9B;text-decoration:none">${escapeHtml(email)}</a></p></div>` : ''}
    ${clientNextStepsBlock(providerName)}
    <div class="cta-wrap"><a href="https://matchedcare.us?v=dashboard" class="cta">View Your Therapist's Profile</a></div>`);
}

// Follow-up nudges (3-day / 7-day) to either party.
function followupEmail({ toName, otherName, contactEmail, role, stage }) {
  const email = safeEmail(contactEmail);
  const finalNudge = stage >= 2;
  const headline = role === 'therapist'
    ? `Have you connected with ${escapeHtml(otherName || 'your client')}?`
    : `Have you reached out to ${escapeHtml(otherName || 'your therapist')}?`;
  const body = role === 'therapist'
    ? `Just checking in on your recent match. Let us know if you need anything${finalNudge ? ", or we can find your client another provider if this isn't a fit." : '.'}`
    : `Your therapist is expecting to hear from you. ${email ? "Their contact info is below." : 'Open your dashboard for their contact info.'}${finalNudge ? " If it's not the right fit, you can request a new match." : ''}`;
  return emailWrapper(`
    <h1>${headline}</h1>
    <p class="subtitle">${escapeHtml(toName || 'there')}, ${escapeHtml(body)}</p>
    ${(role !== 'therapist' && email) ? `<div class="info-box"><p class="info-label">Contact</p><p class="info-value"><a href="mailto:${email}" style="color:#4A7C9B;text-decoration:none">${escapeHtml(email)}</a></p></div>` : ''}
    <div class="cta-wrap"><a href="https://matchedcare.us?v=dashboard" class="cta">Open Dashboard</a></div>`);
}

// Gentle nudge to a provider who hasn't finished their profile yet.
function profileReminderEmail({ name }) {
  return emailWrapper(`
    <h1>You're almost there</h1>
    <p class="subtitle">${escapeHtml(name || 'there')}, your MatchedCare profile is almost ready — there are just a few details left to add.</p>
    <p style="font-size:14px;color:#6E7178;line-height:1.7">Until your profile is complete, we can't match you with clients who are looking for a provider like you. The good news: finishing is <strong>free</strong> and takes about <strong>10 minutes</strong> — just your credentials, license, and a short bio.</p>
    <div class="highlight"><p>Complete your profile and you'll start receiving matched client referrals.</p></div>
    <div class="cta-wrap"><a href="https://matchedcare.us" class="cta">Complete My Profile</a></div>
    <p style="font-size:12px;color:#9A9DA4;margin-top:20px">You're receiving this because you started a MatchedCare provider account. Reply STOP to opt out.</p>`);
}

// ═══════════════════════════════════════════════════════════════════════════
// NOTIFICATION ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

app.post('/notify-match', rateLimit(notifyMatchLimiter), requireUser, async (req, res) => {
  try {
    const { match_id, match_type } = req.body;
    if (!match_id) return res.status(400).json({ error: 'match_id is required' });
    let emailsSent = 0;
    let smsSent = 0;

    if (match_type === 'clinic') {
      const { data: match } = await supabase.from('clinic_matches').select('*').eq('id', match_id).single();
      if (!match) return res.status(404).json({ error: 'Clinic match not found' });
      if (req.authUser.id !== match.client_id) return res.status(403).json({ error: 'Forbidden' });

      const { data: clientProfile } = await supabase.from('profiles').select('full_name, email, phone').eq('user_id', match.client_id).single();
      const { data: clinic } = await supabase.from('clinics').select('clinic_name, email, owner_id, phone').eq('id', match.clinic_id).single();
      const { data: ownerProfile } = await supabase.from('profiles').select('email, phone').eq('user_id', clinic?.owner_id).single();

      const clientEmail = clientProfile?.email;
      const clinicEmail = clinic?.email || ownerProfile?.email;

      // Email notifications
      if (clientEmail) {
        await resend.emails.send({ from: FROM_EMAIL, to: clientEmail, subject: `You've been matched with ${clinic?.clinic_name || 'a clinic'}!`, html: clientMatchEmail({ clientName: clientProfile?.full_name || 'there', providerName: clinic?.clinic_name || 'Your Clinic', providerCredentials: null, providerType: match.service_type, matchScore: match.composite_score, providerEmail: clinicEmail || '', explanation: match.explanation }) });
        emailsSent++;
      }
      if (clinicEmail) {
        await resend.emails.send({ from: FROM_EMAIL, to: clinicEmail, subject: `New client matched to ${clinic?.clinic_name}`, html: clinicMatchEmail({ clinicName: clinic?.clinic_name || 'Your Clinic', clientName: clientProfile?.full_name || 'New Client', clientEmail: clientEmail || '', serviceType: match.service_type, matchScore: match.composite_score, explanation: match.explanation, ageGroup: null }) });
        emailsSent++;
      }

      // SMS notifications
      const clientPhone = await userOptedInSMS(match.client_id);
      if (clientPhone) {
        const sent = await sendSMS(clientPhone, `MatchedCare: You've been matched with ${clinic?.clinic_name || 'a clinic'}! Log in to view details: matchedcare.us`);
        if (sent) smsSent++;
      }
      const clinicPhone = clinic?.phone || ownerProfile?.phone;
      if (clinicPhone) {
        const sent = await sendSMS(clinicPhone, `MatchedCare: New client referral for ${clinic?.clinic_name}. ${clientProfile?.full_name || 'A client'} has been matched. Log in to view: matchedcare.us`);
        if (sent) smsSent++;
      }

      res.json({ success: true, type: 'clinic', emails_sent: emailsSent, sms_sent: smsSent });

    } else {
      const { data: match } = await supabase.from('matches').select('*').eq('id', match_id).single();
      if (!match) return res.status(404).json({ error: 'Match not found' });
      if (req.authUser.id !== match.client_id && req.authUser.id !== match.therapist_id) return res.status(403).json({ error: 'Forbidden' });

      const { data: clientProfile } = await supabase.from('profiles').select('full_name, email, phone').eq('user_id', match.client_id).single();
      const { data: providerProfile } = await supabase.from('profiles').select('full_name, email, phone').eq('user_id', match.therapist_id).single();
      const { data: therapist } = await supabase.from('therapists').select('credentials, provider_type, phone').eq('user_id', match.therapist_id).single();
      const { data: sub } = await supabase.from('subscriptions').select('referral_count').eq('therapist_id', match.therapist_id).single();
      const { data: clientSummary } = await supabase.from('client_summaries').select('primary_concerns').eq('client_id', match.client_id).single();

      const clientEmail = clientProfile?.email;
      const providerEmail = providerProfile?.email;

      // Email notifications
      if (clientEmail) {
        await resend.emails.send({ from: FROM_EMAIL, to: clientEmail, subject: `You've been matched with ${providerProfile?.full_name || 'a provider'}!`, html: clientMatchEmail({ clientName: clientProfile?.full_name || 'there', providerName: providerProfile?.full_name || 'Your Provider', providerCredentials: therapist?.credentials, providerType: therapist?.provider_type, matchScore: match.composite_score, providerEmail: providerEmail || '', explanation: match.explanation }) });
        emailsSent++;
      }
      if (providerEmail) {
        await resend.emails.send({ from: FROM_EMAIL, to: providerEmail, subject: `New client referral — ${clientProfile?.full_name || 'New Client'}`, html: providerMatchEmail({ providerName: providerProfile?.full_name || 'there', clientName: clientProfile?.full_name || 'New Client', clientEmail: clientEmail || '', matchScore: match.composite_score, concerns: clientSummary?.primary_concerns || [], explanation: match.explanation, referralCount: sub?.referral_count }) });
        emailsSent++;
      }

      // SMS notifications
      const clientPhone = await userOptedInSMS(match.client_id);
      if (clientPhone) {
        const sent = await sendSMS(clientPhone, `MatchedCare: You've been matched with ${providerProfile?.full_name || 'a provider'}! ${Math.round(match.composite_score || 0)}% compatibility. View details: matchedcare.us`);
        if (sent) smsSent++;
      }
      const providerPhone = therapist?.phone || providerProfile?.phone;
      if (providerPhone) {
        const sent = await sendSMS(providerPhone, `MatchedCare: New client referral from ${clientProfile?.full_name || 'a client'}. ${Math.round(match.composite_score || 0)}% compatibility. View in dashboard: matchedcare.us`);
        if (sent) smsSent++;
      }

      res.json({ success: true, type: 'provider', emails_sent: emailsSent, sms_sent: smsSent });
    }
  } catch (err) {
    safeError(res, 'notify-match', err, 'Could not send notifications.');
  }
});

// Warm handoff: alert the matched THERAPIST about a new pending match (review needed).
app.post('/notify-therapist-match', rateLimit(notifyMatchLimiter), requireUser, async (req, res) => {
  try {
    const { match_id } = req.body;
    if (!match_id) return res.status(400).json({ error: 'match_id is required' });
    const { data: match } = await supabase.from('matches').select('*').eq('id', match_id).single();
    if (!match) return res.status(404).json({ error: 'Match not found' });
    if (req.authUser.id !== match.client_id) return res.status(403).json({ error: 'Forbidden' });

    const { data: clientProfile } = await supabase.from('profiles').select('full_name').eq('user_id', match.client_id).single();
    const { data: providerProfile } = await supabase.from('profiles').select('full_name, email, phone').eq('user_id', match.therapist_id).single();
    const { data: therapist } = await supabase.from('therapists').select('phone, display_name').eq('user_id', match.therapist_id).single();
    const { data: client } = await supabase.from('clients').select('insurance_provider, preferred_days, preferred_times').eq('user_id', match.client_id).single();
    const { data: summary } = await supabase.from('client_summaries').select('primary_concerns').eq('client_id', match.client_id).single();

    const firstName = (clientProfile?.full_name || '').trim().split(/\s+/)[0] || 'New client';
    const concern = summary?.primary_concerns?.length ? summary.primary_concerns.join(', ') : null;
    const schedule = [(client?.preferred_days || []).join('/'), (client?.preferred_times || []).join('/')].filter(Boolean).join(' · ') || null;
    const providerName = therapist?.display_name || providerProfile?.full_name || 'there';

    let emailsSent = 0, smsSent = 0;
    if (providerProfile?.email) {
      await resend.emails.send({ from: FROM_EMAIL, to: providerProfile.email, subject: 'New client match on MatchedCare', html: therapistMatchAlertEmail({ providerName, clientFirstName: firstName, concern, insurance: client?.insurance_provider || null, schedule, matchScore: match.composite_score }) });
      emailsSent++;
    }
    const providerPhone = therapist?.phone || providerProfile?.phone;
    if (providerPhone) {
      const sent = await sendSMS(providerPhone, `MatchedCare: New client match! ${firstName}${concern ? ', ' + concern : ''}${client?.insurance_provider ? ', ' + client.insurance_provider : ''}. Log in to review: matchedcare.us`);
      if (sent) smsSent++;
    }
    await supabase.from('matches').update({ match_status: 'notified', therapist_notified_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', match_id);
    res.json({ success: true, emails_sent: emailsSent, sms_sent: smsSent });
  } catch (err) {
    safeError(res, 'notify-therapist-match', err, 'Could not notify the therapist.');
  }
});

// Warm handoff: notify the CLIENT that the therapist accepted the match.
app.post('/notify-client-accepted', rateLimit(notifyMatchLimiter), requireUser, async (req, res) => {
  try {
    const { match_id } = req.body;
    if (!match_id) return res.status(400).json({ error: 'match_id is required' });
    const { data: match } = await supabase.from('matches').select('*').eq('id', match_id).single();
    if (!match) return res.status(404).json({ error: 'Match not found' });
    if (req.authUser.id !== match.therapist_id) return res.status(403).json({ error: 'Forbidden' });

    const { data: clientProfile } = await supabase.from('profiles').select('full_name, email').eq('user_id', match.client_id).single();
    const { data: providerProfile } = await supabase.from('profiles').select('full_name, email').eq('user_id', match.therapist_id).single();
    const { data: therapist } = await supabase.from('therapists').select('display_name, professional_headline, credentials, provider_type, profile_photo_url').eq('user_id', match.therapist_id).single();
    let specialties = [];
    try {
      const { data: specs } = await supabase.from('therapist_specialties').select('condition_id').eq('therapist_id', match.therapist_id);
      const ids = (specs || []).map(s => s.condition_id).filter(x => x != null);
      if (ids.length) { const { data: conds } = await supabase.from('conditions').select('id,label').in('id', ids); const m = Object.fromEntries((conds || []).map(c => [c.id, c.label])); specialties = ids.map(i => m[i]).filter(Boolean); }
    } catch {}

    const clientName = (clientProfile?.full_name || '').trim().split(/\s+/)[0] || 'there';
    const providerName = therapist?.display_name || providerProfile?.full_name || 'your therapist';

    let emailsSent = 0, smsSent = 0;
    if (clientProfile?.email) {
      await resend.emails.send({ from: FROM_EMAIL, to: clientProfile.email, subject: 'Great news — we found your therapist!', html: clientAcceptedEmail({ clientName, providerName, credentials: therapist?.credentials, providerType: therapist?.provider_type, headline: therapist?.professional_headline, specialties, photoUrl: therapist?.profile_photo_url, contactEmail: providerProfile?.email }) });
      emailsSent++;
    }
    const clientPhone = await userOptedInSMS(match.client_id);
    if (clientPhone) {
      const sent = await sendSMS(clientPhone, `MatchedCare: You've been matched with ${providerName}! Check your email for details.`);
      if (sent) smsSent++;
    }
    await supabase.from('matches').update({ connected_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', match_id);
    res.json({ success: true, emails_sent: emailsSent, sms_sent: smsSent });
  } catch (err) {
    safeError(res, 'notify-client-accepted', err, 'Could not notify the client.');
  }
});

app.post('/send-welcome', requireUser, async (req, res) => {
  try {
    const { name, role, phone, smsOptIn, waitlisted, state } = req.body;
    const email = req.authUser.email;
    if (!email) return res.status(400).json({ error: 'Authenticated user email is required' });
    // Out-of-state FULL account (provider/clinic created a real profile but is
    // held until launch): send the "ready for launch day" template instead of
    // the standard welcome. Auth-gated, so this only ever emails the caller's
    // own address (no abuse surface).
    if (waitlisted && (role === 'therapist' || role === 'clinic')) {
      const stateLabel = US_STATE_NAMES[String(state || '').toUpperCase()] || state || 'your state';
      await resend.emails.send({ from: FROM_EMAIL, to: email, subject: 'Your MatchedCare profile is ready for launch day', html: providerLaunchReadyEmail({ name: name || 'there', state: stateLabel, audience: role }) });
    } else {
      await resend.emails.send({ from: FROM_EMAIL, to: email, subject: 'Welcome to MatchedCare', html: welcomeEmail({ name: name || 'there', role: role || 'client' }) });
    }
    // Send welcome SMS if opted in
    if (smsOptIn && phone) {
      const smsBody = waitlisted
        ? `Thanks ${name || 'there'}! Your MatchedCare profile is ready. We'll text you the moment we launch in your state.`
        : `Welcome to MatchedCare, ${name || 'there'}! We'll text you when you're matched with a provider. View your dashboard: matchedcare.us`;
      await sendSMS(phone, smsBody);
    }
    res.json({ success: true });
  } catch (err) {
    safeError(res, 'send-welcome', err, 'Could not send welcome email.');
  }
});

app.post('/send-sms', requireAdmin, async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'to and message are required' });
    const sent = await sendSMS(to, message);
    res.json({ success: sent });
  } catch (err) {
    safeError(res, 'send-sms', err, 'Could not send SMS.');
  }
});

app.post('/test-email', requireAdmin, async (req, res) => {
  try {
    const testTo = req.body.to || 'alandiaz.wb@gmail.com';
    await resend.emails.send({ from: FROM_EMAIL, to: testTo, subject: 'MatchedCare — Test Email', html: emailWrapper(`<h1>Email is working!</h1><p class="subtitle">Your Resend integration is configured correctly.</p>`) });
    res.json({ success: true, sent_to: testTo });
  } catch (err) {
    safeError(res, 'test-email', err, 'Test email failed.');
  }
});

// Public contact form. Per-instance in-memory rate limit (5 / 10 min / IP) —
// not a fortress, but blocks the trivial spam case. Validates server-side
// because the contact form is unauthenticated.
const CONTACT_TO = process.env.CONTACT_TO_EMAIL || 'alandiaz.wb@gmail.com';
const CONTACT_RATE_WINDOW_MS = 10 * 60 * 1000;
const CONTACT_RATE_MAX = 5;
const contactRateHits = new Map();

function contactRateOk(ip) {
  const now = Date.now();
  const recent = (contactRateHits.get(ip) || []).filter((t) => now - t < CONTACT_RATE_WINDOW_MS);
  if (recent.length >= CONTACT_RATE_MAX) {
    contactRateHits.set(ip, recent);
    return false;
  }
  recent.push(now);
  contactRateHits.set(ip, recent);
  return true;
}

// Public error-reporting sink. Rate-limited per-IP, payload-truncated.
// Structured JSON to stdout so Railway log viewer can grep [client-error].
const ERROR_RATE_WINDOW_MS = 10 * 60 * 1000;
const ERROR_RATE_MAX = 50;
const errorRateHits = new Map();

function errorReportRateOk(ip) {
  const now = Date.now();
  const recent = (errorRateHits.get(ip) || []).filter((t) => now - t < ERROR_RATE_WINDOW_MS);
  if (recent.length >= ERROR_RATE_MAX) {
    errorRateHits.set(ip, recent);
    return false;
  }
  recent.push(now);
  errorRateHits.set(ip, recent);
  return true;
}

app.post('/report-error', async (req, res) => {
  try {
    const ipHeader = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    const ip = String(ipHeader).split(',')[0].trim() || 'unknown';
    if (!errorReportRateOk(ip)) return res.status(429).json({ error: 'Rate limited' });

    const message = String(req.body?.message || '').slice(0, 5000);
    const stack = String(req.body?.stack || '').slice(0, 10000);
    const url = String(req.body?.url || '').slice(0, 500);
    const userAgent = String(req.body?.userAgent || req.headers['user-agent'] || '').slice(0, 500);
    const context = String(req.body?.context || '').slice(0, 500);

    if (!message) return res.status(400).json({ error: 'message is required' });

    console.error('[client-error]', JSON.stringify({
      ts: new Date().toISOString(),
      ip,
      url,
      userAgent,
      context,
      message,
      stack,
    }));

    res.json({ received: true });
  } catch (err) {
    safeError(res, 'report-error', err, 'Could not log error.');
  }
});

app.post('/contact', async (req, res) => {
  try {
    const ipHeader = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    const ip = String(ipHeader).split(',')[0].trim() || 'unknown';
    if (!contactRateOk(ip)) {
      return res.status(429).json({ error: 'Too many messages. Please try again later.' });
    }

    const name = String(req.body?.name || '').trim().slice(0, 100);
    const email = safeEmail(req.body?.email);
    const subject = String(req.body?.subject || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 200);
    const message = String(req.body?.message || '').trim().slice(0, 5000);

    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Name, valid email, and message are required.' });
    }

    const subjectLine = subject ? `Contact form: ${subject}` : 'Contact form message';
    const html = emailWrapper(`
      <h1>New contact form submission</h1>
      <p class="subtitle">Sent from the MatchedCare contact page.</p>
      <div class="info-box"><p class="info-label">From</p><p class="info-value">${escapeHtml(name)}</p>
      <p style="font-size:13px;color:#6E7178;margin:4px 0 0">${escapeHtml(email)}</p></div>
      ${subject ? `<div class="info-box"><p class="info-label">Subject</p><p class="info-value">${escapeHtml(subject)}</p></div>` : ''}
      <div class="highlight"><p style="white-space:pre-wrap">${escapeHtml(message)}</p></div>
    `);

    await resend.emails.send({
      from: FROM_EMAIL,
      to: CONTACT_TO,
      reply_to: email,
      subject: subjectLine,
      html,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('contact form error:', err.message);
    res.status(500).json({ error: 'Could not send message. Please try again.' });
  }
});

app.post('/test-sms', requireAdmin, async (req, res) => {
  try {
    const testTo = req.body.to;
    if (!testTo) return res.status(400).json({ error: 'to phone number is required' });
    const sent = await sendSMS(testTo, 'MatchedCare: SMS notifications are working! This is a test message.');
    res.json({ success: sent, sent_to: testTo });
  } catch (err) {
    safeError(res, 'test-sms', err, 'Test SMS failed.');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// STRIPE ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

app.post('/create-setup-intent', rateLimit(setupIntentLimiter), requireUser, async (req, res) => {
  try {
    const user_id = req.authUser.id;
    const email = req.authUser.email;
    if (!email) return res.status(400).json({ error: 'Authenticated user email is required' });

    // Derive the plan and billable provider count from authoritative records
    // (the owner's clinic + its clinic_staff), NOT the request body — otherwise
    // a clinic could understate headcount or self-select a cheaper plan to
    // underpay. The client-sent plan_type/provider_count are ignored for pricing.
    const { plan_type: safePlanType, provider_count: safeProviderCount } =
      await resolveBillingPlan(user_id);
    if (!PLAN_PRICES[safePlanType]) {
      return res.status(400).json({ error: `Unknown plan_type: ${safePlanType}` });
    }

    // 1. Find or create the Stripe Customer for this user.
    let customer;
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data.length > 0) {
      customer = existing.data[0];
    } else {
      customer = await stripe.customers.create({
        email,
        metadata: { user_id, plan_type: safePlanType },
      });
    }

    // 2. UPSERT the subscriptions row so we never silently drop the customer
    //    id when the row hasn't been created yet (e.g. a brand-new signup).
    //    provider_count is persisted here so /start-billing can multiply the
    //    MH-group addon by the right headcount.
    await supabase
      .from('subscriptions')
      .upsert(
        {
          therapist_id: user_id,
          stripe_customer_id: customer.id,
          plan_type: safePlanType,
          provider_count: safeProviderCount,
          status: 'pending',
          payment_method_pending: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'therapist_id' }
      );

    // 3. Create the SetupIntent. `usage: 'off_session'` is critical — it
    //    tells Stripe this card will be charged later without the customer
    //    present (i.e. when the 5th referral triggers /start-billing).
    const setupIntent = await stripe.setupIntents.create({
      customer: customer.id,
      payment_method_types: ['card'],
      usage: 'off_session',
      metadata: { user_id, plan_type: safePlanType },
    });

    res.json({
      client_secret: setupIntent.client_secret,
      customer_id: customer.id,
      setup_intent_id: setupIntent.id,
    });
  } catch (err) {
    safeError(res, 'create-setup-intent', err, 'Could not start payment setup. Please try again.');
  }
});

app.post('/confirm-setup-intent', requireUser, async (req, res) => {
  try {
    const { setup_intent_id } = req.body;
    if (!setup_intent_id) return res.status(400).json({ error: 'setup_intent_id is required' });

    // Retrieve the SetupIntent from Stripe to verify it succeeded and that
    // it belongs to the authenticated user. Never trust the client.
    const si = await stripe.setupIntents.retrieve(setup_intent_id);
    if (!si || si.metadata?.user_id !== req.authUser.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (si.status !== 'succeeded') {
      return res.status(400).json({ error: `SetupIntent status is ${si.status}` });
    }

    // Make this card the default for invoices billed later.
    if (si.payment_method && si.customer) {
      await stripe.customers.update(si.customer, {
        invoice_settings: { default_payment_method: si.payment_method },
      });
    }

    // Saving a payment method IS the provider's voluntary opt-in to billing.
    // Stamp billing_opt_in + the account's pricing cohort here so the cohort is
    // pinned at opt-in time, not re-derived later when the switch state differs.
    const cohort = await resolveCohort(req.authUser.id);
    await supabase
      .from('subscriptions')
      .update({
        payment_method_pending: false,
        stripe_customer_id: si.customer,
        status: 'active',
        billing_opt_in: true,
        cohort,
        updated_at: new Date().toISOString(),
      })
      .eq('therapist_id', req.authUser.id);

    res.json({ success: true });
  } catch (err) {
    safeError(res, 'confirm-setup-intent', err, 'Could not confirm payment method.');
  }
});

// Self-healing reconciler. If a SetupIntent succeeded at Stripe but our DB
// never flipped payment_method_pending=false (webhook delayed, foreground
// confirm threw a swallowed error, etc.) the dashboard fires this on load
// to verify against Stripe directly and reconcile the subscription row.
app.post('/verify-payment-method', requireUser, async (req, res) => {
  try {
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('therapist_id', req.authUser.id)
      .single();
    if (!sub?.stripe_customer_id) {
      return res.json({ verified: false, reason: 'no_customer' });
    }

    const customer = await stripe.customers.retrieve(sub.stripe_customer_id);
    let defaultPm = customer?.invoice_settings?.default_payment_method;

    // No default set, but a card may still be saved — promote the most
    // recent one to default so /start-billing can use it later.
    if (!defaultPm) {
      const pms = await stripe.paymentMethods.list({
        customer: sub.stripe_customer_id,
        type: 'card',
        limit: 1,
      });
      if (pms.data.length > 0) {
        defaultPm = pms.data[0].id;
        await stripe.customers.update(sub.stripe_customer_id, {
          invoice_settings: { default_payment_method: defaultPm },
        });
      }
    }

    if (defaultPm) {
      // A saved default card is a confirmed voluntary opt-in (see
      // /confirm-setup-intent). Mirror the opt-in + cohort stamp here so a
      // delayed/missed confirm still records the provider's billing consent.
      const cohort = await resolveCohort(req.authUser.id);
      await supabase
        .from('subscriptions')
        .update({
          payment_method_pending: false,
          status: 'active',
          billing_opt_in: true,
          cohort,
          updated_at: new Date().toISOString(),
        })
        .eq('therapist_id', req.authUser.id);
      return res.json({ verified: true });
    }
    return res.json({ verified: false, reason: 'no_payment_method' });
  } catch (err) {
    safeError(res, 'verify-payment-method', err, 'Could not verify payment method.');
  }
});

// Each plan family has a founder phase (first 3 months) and a standard
// phase (every month after that). startBillingForTherapist installs a
// Stripe subscription_schedule that auto-transitions between them.
const PLAN_PRICES = {
  provider_founder: {
    founder: { base: 'price_1TeLZdPtdczvTubYtnbKnC9P' },
    standard: { base: 'price_1TeLZbPtdczvTubYegElJ7Wa' },
  },
  aba_founder: {
    founder: { base: 'price_1TeLZPPtdczvTubYVxI6Vifk' },
    standard: { base: 'price_1TeLZMPtdczvTubYctDtVhFb' },
  },
  mh_group_founder: {
    founder: { base: 'price_1TeLZZPtdczvTubYTp7HOgok', perProvider: 'price_1TeLZXPtdczvTubYMmArl1Ds' },
    standard: { base: 'price_1TeLZUPtdczvTubYA2dJQGHF', perProvider: 'price_1TeLZSPtdczvTubYolDwdmEd' },
  },
  // TODO(evaluations add-on): no Stripe product exists yet. These are NAMED
  // PLACEHOLDERS — replace with real Stripe price IDs before the evaluations
  // add-on is ever billable. Plumbing only: evaluation matching is free during
  // the founding period, so /start-billing is never invoked for this plan today.
  evaluations_addon: {
    founder: { base: 'price_TODO_EVALUATIONS_ADDON_FOUNDER' },
    standard: { base: 'price_TODO_EVALUATIONS_ADDON_STANDARD' },
  },
};

function buildPhaseItems(phase, providerCount) {
  const items = [{ price: phase.base }];
  if (phase.perProvider) {
    const qty = Math.max(1, Number(providerCount) || 1);
    items.push({ price: phase.perProvider, quantity: qty });
  }
  return items;
}

// Resolve a user's billing plan + billable provider count from authoritative
// data, never from client input. A clinic owner's plan follows their clinic
// type, and their headcount is the number of therapist staff they registered;
// a user with no clinic is a solo provider. Used at BOTH card-setup time and
// charge time so the two can never diverge from what the client claimed.
async function resolveBillingPlan(user_id) {
  const { data: clinics } = await supabase
    .from('clinics')
    .select('id, clinic_type')
    .eq('owner_id', user_id)
    .limit(1);
  const clinic = clinics && clinics[0];

  if (!clinic) return { plan_type: 'provider_founder', provider_count: 1 };
  if (clinic.clinic_type === 'aba') return { plan_type: 'aba_founder', provider_count: 1 };
  if (clinic.clinic_type === 'mh_group') {
    const { data: staff } = await supabase
      .from('clinic_staff')
      .select('id')
      .eq('clinic_id', clinic.id)
      .eq('staff_role', 'therapist');
    return { plan_type: 'mh_group_founder', provider_count: Math.max(1, (staff || []).length) };
  }
  // Unknown/unsupported clinic_type: safest billable default.
  return { plan_type: 'provider_founder', provider_count: 1 };
}

// Resolve the account's pricing cohort. 'founder' = grandfathered (joined while
// the platform was free) and keeps the founder->standard schedule. 'standard' =
// joined after monetization went live and starts at standard pricing with no
// founder discount. Defaults to the cheaper-for-the-user 'founder' if unknown.
async function resolveCohort(user_id) {
  try {
    const { data, error } = await supabase.rpc('account_cohort', { p_uid: user_id });
    if (error) throw error;
    return data === 'standard' ? 'standard' : 'founder';
  } catch (e) {
    console.warn('resolveCohort failed, defaulting to founder:', e.message);
    return 'founder';
  }
}

async function startBillingForTherapist({ therapist_id }) {
  const { data: sub, error: subErr } = await supabase
    .from('subscriptions')
    .select('stripe_customer_id, stripe_subscription_id, cohort, billing_opt_in')
    .eq('therapist_id', therapist_id)
    .single();
  if (subErr || !sub) throw new Error(`Subscription not found for therapist ${therapist_id}`);
  if (sub.stripe_subscription_id) {
    return { already_active: true, subscription_id: sub.stripe_subscription_id };
  }
  if (!sub.stripe_customer_id) throw new Error('No stripe_customer_id on subscription record');

  // INVARIANT 6 (structural): never auto-charge. Billing only proceeds for a
  // provider who voluntarily opted in (saved a payment method). Flipping the
  // monetization switch can therefore never charge anyone who hasn't opted in.
  if (!sub.billing_opt_in) {
    throw new Error(`Provider ${therapist_id} has not opted into billing; refusing to charge.`);
  }

  const cohort = sub.cohort || (await resolveCohort(therapist_id));

  // Re-derive plan + headcount authoritatively at charge time so a stale or
  // previously client-influenced subscriptions row can't cause underbilling.
  const { plan_type, provider_count } = await resolveBillingPlan(therapist_id);
  const plan = PLAN_PRICES[plan_type];
  if (!plan) throw new Error(`Unknown plan_type: ${plan_type}`);

  const customer = await stripe.customers.retrieve(sub.stripe_customer_id);
  const defaultPm = customer?.invoice_settings?.default_payment_method;
  if (!defaultPm) throw new Error('Customer has no default payment method saved');

  const qty = provider_count;

  try {
    // Founder cohort (grandfathered): 3 months at founder pricing, then standard
    // forever. Standard cohort (joined after monetization on): standard pricing
    // from day one — the founder discount is grandfathered to early providers,
    // never extended to late joiners. end_behavior='release' lets the
    // subscription continue standalone after the last phase finishes.
    const phases = cohort === 'standard'
      ? [{ items: buildPhaseItems(plan.standard, qty) }]
      : [
          { items: buildPhaseItems(plan.founder, qty), iterations: 3 },
          { items: buildPhaseItems(plan.standard, qty) },
        ];
    const schedule = await stripe.subscriptionSchedules.create({
      customer: sub.stripe_customer_id,
      start_date: 'now',
      end_behavior: 'release',
      default_settings: { default_payment_method: defaultPm },
      phases,
      metadata: { therapist_id, plan_type, cohort },
    });

    const subscriptionId = schedule.subscription;
    let status = 'active';
    let founderEndsAt = null;
    if (subscriptionId) {
      try {
        const liveSub = await stripe.subscriptions.retrieve(subscriptionId);
        status = liveSub.status || status;
      } catch (e) {
        console.warn('post-create subscription retrieve failed:', e.message);
      }
    }
    // Phase[0].end_date is when founder pricing ends (Unix seconds). Only the
    // founder cohort has a founder phase; standard cohort never gets one.
    if (cohort !== 'standard' && schedule.phases?.[0]?.end_date) {
      founderEndsAt = new Date(schedule.phases[0].end_date * 1000).toISOString();
    }

    await supabase
      .from('subscriptions')
      .update({
        stripe_subscription_id: subscriptionId,
        plan_type,
        cohort,
        provider_count: qty,
        billing_started_at: new Date().toISOString(),
        founder_ends_at: founderEndsAt,
        status,
        billing_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('therapist_id', therapist_id);

    return { success: true, subscription_id: subscriptionId, schedule_id: schedule.id, status };
  } catch (err) {
    console.error(`start-billing failed for ${therapist_id}:`, err.message);
    await supabase
      .from('subscriptions')
      .update({
        billing_error: err.message,
        updated_at: new Date().toISOString(),
      })
      .eq('therapist_id', therapist_id);
    throw err;
  }
}

// Shared cron-token middleware. Apply to endpoints intended for internal
// callers (cron, ops scripts) so they can't be hit from the public internet
// without the secret.
function requireCronToken(req, res, next) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return res.status(503).json({ error: 'Server cron secret is not configured' });
  const provided = req.header('x-cron-token') || req.query.token;
  if (provided !== expected) return res.status(401).json({ error: 'Invalid cron token' });
  next();
}

// Shared runner used by both /check-billing and the internal interval cron.
async function runBillingCheck() {
  // Free early access: never start/charge any subscription.
  if (FREE_MODE) return { checked: 0, results: [], free_mode: true };
  // INVARIANT 6 (structural): only ever charge providers who explicitly opted in
  // (billing_opt_in=true, set when they voluntarily saved a payment method).
  // Flipping the monetization switch on can never auto-charge a non-opted-in
  // provider because this is the sole automated billing path.
  const { data: rows, error } = await supabase
    .from('subscriptions')
    .select('therapist_id, plan_type, provider_count')
    .eq('billing_opt_in', true)
    .is('stripe_subscription_id', null);
  if (error) throw error;

  const results = [];
  for (const row of rows || []) {
    try {
      const result = await startBillingForTherapist({
        therapist_id: row.therapist_id,
        plan_type: row.plan_type,
        provider_count: row.provider_count,
      });
      results.push({ therapist_id: row.therapist_id, ...result });
    } catch (err) {
      results.push({ therapist_id: row.therapist_id, error: err.message });
    }
  }
  return { checked: (rows || []).length, results };
}

app.post('/start-billing', requireCronToken, async (req, res) => {
  try {
    // Free early access: refuse to start billing regardless of caller.
    if (FREE_MODE) return res.json({ skipped: true, free_mode: true });
    const { therapist_id, plan_type, provider_count } = req.body;
    if (!therapist_id || !plan_type) {
      return res.status(400).json({ error: 'therapist_id and plan_type are required' });
    }
    const result = await startBillingForTherapist({ therapist_id, plan_type, provider_count });
    res.json(result);
  } catch (err) {
    safeError(res, 'start-billing', err, 'Could not start billing.');
  }
});

app.get('/check-billing', requireCronToken, async (req, res) => {
  try {
    const result = await runBillingCheck();
    res.json(result);
  } catch (err) {
    safeError(res, 'check-billing', err, 'Billing check failed.');
  }
});

// Profile-completion reminders. Finds providers who signed up but haven't
// finished their profile (missing credentials/license/npi), aged 1h–7d, with
// fewer than 3 reminders sent, and emails a gentle nudge. Idempotent: skips
// anyone reminded within the last 24h. Consent: only providers who opted into
// notifications (profiles.sms_consent) — flip CONSENT_REQUIRED to treat the
// reminder as transactional and email all incomplete providers instead.
const REMINDER_MAX = 3;
const REMINDER_MIN_AGE_MS = 60 * 60 * 1000;          // 1 hour
const REMINDER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;    // 1 day between emails
const REMINDER_CONSENT_REQUIRED = false;
async function runIncompleteProfileCheck() {
  const now = Date.now();
  const minAge = new Date(now - REMINDER_MIN_AGE_MS).toISOString();
  const maxAge = new Date(now - REMINDER_MAX_AGE_MS).toISOString();
  const { data: rows, error } = await supabase
    .from('therapists')
    .select('user_id, credentials, license_type, npi, created_at, reminder_sent_count, last_reminder_at')
    .or('credentials.is.null,license_type.is.null,npi.is.null')
    .lt('created_at', minAge)
    .gt('created_at', maxAge)
    .lt('reminder_sent_count', REMINDER_MAX);
  if (error) throw error;

  let emailsSent = 0;
  const errors = [];
  for (const t of rows || []) {
    try {
      // Idempotency: don't email the same provider twice within 24h.
      if (t.last_reminder_at && (now - new Date(t.last_reminder_at).getTime()) < REMINDER_COOLDOWN_MS) continue;

      const { data: prof } = await supabase.from('profiles').select('sms_consent, full_name').eq('user_id', t.user_id).single();
      if (REMINDER_CONSENT_REQUIRED && !prof?.sms_consent) continue;

      // Email lives in auth.users — look it up with the service role.
      const { data: au, error: auErr } = await supabase.auth.admin.getUserById(t.user_id);
      const email = au?.user?.email;
      if (auErr || !email) { errors.push({ user_id: t.user_id, error: auErr?.message || 'no email found' }); continue; }

      await resend.emails.send({
        from: FROM_EMAIL,
        to: email,
        subject: "You're almost there — complete your MatchedCare profile",
        html: profileReminderEmail({ name: prof?.full_name }),
      });
      await supabase.from('therapists').update({
        reminder_sent_count: (t.reminder_sent_count || 0) + 1,
        last_reminder_at: new Date().toISOString(),
      }).eq('user_id', t.user_id);
      emailsSent++;
    } catch (e) {
      errors.push({ user_id: t.user_id, error: e?.message || String(e) });
    }
  }
  return { incomplete_found: (rows || []).length, emails_sent: emailsSent, errors };
}

app.get('/check-incomplete-profiles', requireCronToken, async (req, res) => {
  try {
    const result = await runIncompleteProfileCheck();
    res.json(result);
  } catch (err) {
    safeError(res, 'check-incomplete-profiles', err, 'Incomplete-profile check failed.');
  }
});

// /create-portal-session deliberately ignores any customer id from the
// client. The customer is looked up from the authed user's subscription row
// to prevent a leaked or guessed stripe_customer_id from opening another
// user's billing portal.
app.post('/create-portal-session', requireUser, async (req, res) => {
  try {
    const { return_url } = req.body || {};
    const { data: sub, error } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('therapist_id', req.authUser.id)
      .single();
    if (error || !sub?.stripe_customer_id) {
      return res.status(404).json({ error: 'No Stripe customer for this user' });
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: allowedReturnUrl(return_url),
    });
    res.json({ url: session.url });
  } catch (err) {
    safeError(res, 'create-portal-session', err, 'Could not open billing portal.');
  }
});

// Internal interval cron. Runs the same logic as /check-billing every 10
// minutes so the safety net fires without an external scheduler. If the
// process restarts the timer resets but no state is lost (the query is
// idempotent).
const BILLING_CRON_MS = 10 * 60 * 1000;
async function runBillingCronTick() {
  try {
    const result = await runBillingCheck();
    if (result.checked > 0) {
      console.log(`billing cron: processed ${result.checked} pending subscriptions`);
    }
  } catch (err) {
    console.error('billing cron error:', err.message);
  }
}
setInterval(runBillingCronTick, BILLING_CRON_MS);

// Warm-handoff follow-up cron (hourly). For accepted-but-not-booked matches,
// sends a 3-day nudge then a 7-day final nudge to both parties (email only).
// followup_count guards against duplicates; booked matches are skipped.
const FOLLOWUP_CRON_MS = 60 * 60 * 1000;
async function runFollowupTick() {
  try {
    const now = Date.now();
    const { data: rows, error } = await supabase.from('matches')
      .select('id, client_id, therapist_id, therapist_responded_at, followup_count, booked_at')
      .eq('match_status', 'accepted')
      .lt('followup_count', 2);
    if (error) throw error;
    for (const m of rows || []) {
      if (m.booked_at || !m.therapist_responded_at) continue;
      const ageDays = (now - new Date(m.therapist_responded_at).getTime()) / 86400000;
      const stage = m.followup_count || 0;
      const due = (stage === 0 && ageDays >= 3) || (stage === 1 && ageDays >= 7);
      if (!due) continue;
      const nextStage = stage + 1;
      const { data: cp } = await supabase.from('profiles').select('full_name, email').eq('user_id', m.client_id).single();
      const { data: pp } = await supabase.from('profiles').select('full_name, email').eq('user_id', m.therapist_id).single();
      const { data: th } = await supabase.from('therapists').select('display_name').eq('user_id', m.therapist_id).single();
      const clientName = (cp?.full_name || '').trim().split(/\s+/)[0] || 'there';
      const providerName = th?.display_name || pp?.full_name || 'your therapist';
      try {
        if (pp?.email) await resend.emails.send({ from: FROM_EMAIL, to: pp.email, subject: nextStage >= 2 ? 'Checking in on your MatchedCare match' : 'Have you connected with your client?', html: followupEmail({ toName: providerName, otherName: clientName, contactEmail: cp?.email, role: 'therapist', stage: nextStage }) });
        if (cp?.email) await resend.emails.send({ from: FROM_EMAIL, to: cp.email, subject: nextStage >= 2 ? 'Still here to help with your match' : 'Have you reached out to your therapist?', html: followupEmail({ toName: clientName, otherName: providerName, contactEmail: pp?.email, role: 'client', stage: nextStage }) });
      } catch (e) { console.error('followup email error:', e.message); }
      await supabase.from('matches').update({ followup_count: nextStage, last_followup_at: new Date().toISOString() }).eq('id', m.id);
    }
  } catch (err) {
    console.error('followup cron error:', err.message);
  }
}
setInterval(runFollowupTick, FOLLOWUP_CRON_MS);

// Profile-completion reminders are scheduled by the separate Railway cron service
// (cron-reminders.js -> GET /check-incomplete-profiles), so there is no in-process
// interval here — that keeps a single source of truth for the daily sweep.

// ═══════════════════════════════════════════════════════════════════════════
// OUT-OF-STATE WAITLIST + LAUNCH LEVER
// ═══════════════════════════════════════════════════════════════════════════

const US_STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'Washington, D.C.',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', PR: 'Puerto Rico',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

// Shared care off-ramp for patients — never let someone in need leave empty-handed.
function careResourcesHtml() {
  return `<div class="info-box"><p class="info-label">Need care now? Don't wait for us.</p>
    <p style="font-size:14px;color:#2C3038;line-height:1.8;margin:6px 0 0">
    &middot; <a href="https://findtreatment.gov" style="color:#4A7C9B;text-decoration:none">findtreatment.gov</a> — find treatment options near you<br>
    &middot; Call <strong>211</strong> for local health and social services<br>
    &middot; Your insurance company can provide a list of in-network therapists</p></div>`;
}

function optOutLine() {
  return `<p style="font-size:12px;color:#9A9DA4;margin-top:20px">You're receiving this because you joined the MatchedCare waitlist. Reply STOP to opt out, or email notifications@matchedcare.us to be removed.</p>`;
}

// Lightweight waitlist confirmation — provider/clinic email-only path.
function waitlistProviderEmail({ name, state, audience }) {
  const noun = audience === 'clinic' ? 'clinic' : 'practice';
  return emailWrapper(`
    <h1>You're on the founding list</h1>
    <p class="subtitle">${escapeHtml(name || 'there')}, thanks for raising your hand. MatchedCare is live in Florida and expanding state by state — and you're first in line for ${escapeHtml(state)}.</p>
    <div class="highlight"><p>The moment we launch in ${escapeHtml(state)}, you'll get <strong>Founding Provider</strong> status and first access to every match in your area.</p></div>
    <p style="font-size:14px;color:#6E7178;line-height:1.7">Want to be ready on day one? You can create your full ${escapeHtml(noun)} profile anytime — it'll go live automatically the moment we open ${escapeHtml(state)}.</p>
    <div class="cta-wrap"><a href="https://matchedcare.us" class="cta">Create My Full Profile</a></div>
    ${optOutLine()}`);
}

// Lightweight waitlist confirmation — patient notify-me path. No marketing tone.
function waitlistPatientEmail({ state }) {
  return emailWrapper(`
    <h1>You're on the list</h1>
    <p class="subtitle">Thanks for reaching out. MatchedCare isn't in ${escapeHtml(state)} yet, but we'll email you the moment we launch there.</p>
    ${careResourcesHtml()}
    ${optOutLine()}`);
}

// Full out-of-state account (provider/clinic) — profile is built, held for launch.
function providerLaunchReadyEmail({ name, state, audience }) {
  const noun = audience === 'clinic' ? 'clinic' : 'provider';
  return emailWrapper(`
    <h1>Your profile is ready for launch day</h1>
    <p class="subtitle">${escapeHtml(name || 'there')}, your MatchedCare ${escapeHtml(noun)} profile is complete and saved. There's nothing more to do right now.</p>
    <div class="info-box"><p class="info-label">Status</p><p class="info-value">Founding Provider — ${escapeHtml(state)}</p></div>
    <div class="highlight"><p>You'll go live the moment MatchedCare launches in ${escapeHtml(state)}, with first access to every match. We'll email you the day it happens.</p></div>
    <p style="font-size:14px;color:#6E7178;line-height:1.7">No payment method is needed, and there's nothing to complete in the meantime — you're all set.</p>
    ${optOutLine()}`);
}

// Launch day — we're live in [State].
function stateLiveEmail({ state }) {
  return emailWrapper(`
    <h1>We're live in ${escapeHtml(state)}</h1>
    <p class="subtitle">The wait is over — MatchedCare is now open in ${escapeHtml(state)}. Log in to get started.</p>
    <div class="cta-wrap"><a href="https://matchedcare.us" class="cta">Open MatchedCare</a></div>
    ${optOutLine()}`);
}

// Confirmation email for the lightweight waitlist paths. Abuse-hardened: only
// sends if the email was added to the waitlist for this audience within the last
// 10 minutes (else 403), and rate-limited to 5/hour/IP. This prevents the
// endpoint being used as an open email cannon.
const waitlistConfirmLimiter = makeRateLimiter(60 * 60 * 1000, 5);
app.post('/waitlist-confirm', rateLimit(waitlistConfirmLimiter), async (req, res) => {
  try {
    const email = safeEmail(req.body?.email);
    const audience = String(req.body?.audience || '').trim();
    if (!email) return res.status(400).json({ error: 'A valid email is required' });
    if (!['provider', 'clinic', 'patient'].includes(audience)) {
      return res.status(400).json({ error: 'Invalid audience' });
    }
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: row } = await supabase
      .from('waitlist')
      .select('email, state, full_name, created_at')
      .eq('email', email)
      .eq('audience', audience)
      .gte('created_at', tenMinAgo)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!row) {
      // No recent signup -> refuse. Do not reveal whether the email exists.
      return res.status(403).json({ error: 'No recent waitlist signup found for this email.' });
    }
    const stateLabel = US_STATE_NAMES[String(row.state || '').toUpperCase()] || row.state || 'your state';
    let subject, html;
    if (audience === 'patient') {
      subject = "You're on the MatchedCare list";
      html = waitlistPatientEmail({ state: stateLabel });
    } else {
      subject = "You're on the MatchedCare founding list";
      html = waitlistProviderEmail({ name: row.full_name, state: stateLabel, audience });
    }
    await resend.emails.send({ from: FROM_EMAIL, to: email, subject, html });
    res.json({ success: true });
  } catch (err) {
    safeError(res, 'waitlist-confirm', err, 'Could not send confirmation.');
  }
});

// Launch-day lever. Gated by a shared secret (x-launch-secret header matching
// LAUNCH_STATE_SECRET). Flips every waitlisted provider/clinic/patient in the
// state live, then emails the waitlist + flipped account holders.
app.post('/launch-state', async (req, res) => {
  try {
    const provided = String(req.headers['x-launch-secret'] || '');
    const expected = String(process.env.LAUNCH_STATE_SECRET || '');
    if (!expected || provided !== expected) return res.status(403).json({ error: 'Forbidden' });

    const state = String(req.body?.state || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(state)) return res.status(400).json({ error: 'state must be a 2-letter code' });
    const stateLabel = US_STATE_NAMES[state] || state;

    // 1. Providers: flip live + accepting.
    const { data: tUp } = await supabase.from('therapists')
      .update({ waitlisted: false, is_accepting: true })
      .eq('state', state).eq('waitlisted', true).select('user_id');
    // 2. Clinics: flip live + accepting (clinics uses accepts_new_clients).
    const { data: cUp } = await supabase.from('clinics')
      .update({ waitlisted: false, accepts_new_clients: true })
      .eq('state', state).eq('waitlisted', true).select('owner_id');
    // 3. Patient light accounts: flip live (do NOT forget these).
    const { data: pUp } = await supabase.from('profiles')
      .update({ waitlisted: false })
      .eq('state', state).eq('waitlisted', true).select('user_id');

    // Recipients: everyone on the waitlist for the state + every flipped holder.
    const emails = new Set();
    const { data: wl } = await supabase.from('waitlist').select('email').eq('state', state);
    (wl || []).forEach((r) => r.email && emails.add(r.email.toLowerCase()));

    const holderIds = [
      ...((tUp || []).map((t) => t.user_id)),
      ...((cUp || []).map((c) => c.owner_id)),
      ...((pUp || []).map((p) => p.user_id)),
    ].filter(Boolean);
    if (holderIds.length) {
      const { data: profs } = await supabase.from('profiles').select('email').in('user_id', holderIds);
      (profs || []).forEach((p) => p.email && emails.add(p.email.toLowerCase()));
    }

    let emailsSent = 0;
    for (const to of emails) {
      try {
        await resend.emails.send({ from: FROM_EMAIL, to, subject: `MatchedCare is now live in ${stateLabel}`, html: stateLiveEmail({ state: stateLabel }) });
        emailsSent++;
      } catch (e) {
        console.error('launch-state email error:', e.message);
      }
    }

    res.json({
      success: true,
      state,
      providers_flipped: (tUp || []).length,
      clinics_flipped: (cUp || []).length,
      patients_flipped: (pUp || []).length,
      emails_sent: emailsSent,
    });
  } catch (err) {
    safeError(res, 'launch-state', err, 'Could not launch state.');
  }
});

app.listen(PORT, () => {
  console.log(`MatchedCare Billing Server running on port ${PORT}`);
  console.log(`Email: ${process.env.RESEND_API_KEY ? 'ENABLED' : 'DISABLED'}`);
  console.log(`SMS: ${twilioClient ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Billing cron: interval=${BILLING_CRON_MS / 1000}s`);
  console.log(`FREE MODE: ${FREE_MODE ? 'ON (no charges; free for everyone)' : 'OFF (paid plans active)'}`);
});
