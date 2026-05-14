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
    const metadataRole = req.authUser.app_metadata?.role || req.authUser.user_metadata?.role;
    if (metadataRole === 'admin') return next();

    const { data } = await supabase
      .from('profiles')
      .select('role')
      .eq('user_id', req.authUser.id)
      .single();

    if (data?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
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
    await twilioClient.messages.create({ body: message, from: TWILIO_PHONE, to: phone });
    console.log('SMS sent to:', phone);
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
      if (data) await supabase.from('subscriptions').update({ stripe_subscription_id: sub.id, status: sub.status === 'active' ? 'active' : sub.status, updated_at: new Date().toISOString() }).eq('therapist_id', data.therapist_id);
      break;
    }
    case 'customer.subscription.deleted': {
      await supabase.from('subscriptions').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('stripe_subscription_id', event.data.object.id);
      break;
    }
  }
  res.json({ received: true });
});

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'matchedcare-billing', email: !!process.env.RESEND_API_KEY, sms: !!twilioClient });
});

app.get('/npi-lookup', async (req, res) => {
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
    console.error('npi-lookup:', err.message);
    res.status(500).json({ error: err.message });
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
    ${referralCount !== undefined ? `<p style="font-size:13px;color:#9A9DA4;margin-top:16px">This is referral #${escapeHtml(referralCount)}${referralCount < 5 ? ' of your 5 free referrals.' : '. Billing is now active.'}</p>` : ''}
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
    <div class="cta-wrap"><a href="https://matchedcare.us?v=dashboard" class="cta">View in Dashboard</a></div>`);
}

function welcomeEmail({ name, role }) {
  const msgs = { client: "We're here to help you find a provider who truly fits.", therapist: "Complete your profile and you'll start receiving matched client referrals. Your first 5 referrals are free.", clinic: "Once activated, you'll start receiving matched client referrals automatically." };
  return emailWrapper(`<h1>Welcome to MatchedCare</h1><p class="subtitle">${escapeHtml(name)}, your account has been created.</p><p style="font-size:14px;color:#6E7178;line-height:1.7">${escapeHtml(msgs[role] || msgs.client)}</p><div class="cta-wrap"><a href="https://matchedcare.us" class="cta">Get Started</a></div>`);
}

// ═══════════════════════════════════════════════════════════════════════════
// NOTIFICATION ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

app.post('/notify-match', requireUser, async (req, res) => {
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
    console.error('Error sending notifications:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/send-welcome', requireUser, async (req, res) => {
  try {
    const { name, role, phone, smsOptIn } = req.body;
    const email = req.authUser.email;
    if (!email) return res.status(400).json({ error: 'Authenticated user email is required' });
    await resend.emails.send({ from: FROM_EMAIL, to: email, subject: 'Welcome to MatchedCare', html: welcomeEmail({ name: name || 'there', role: role || 'client' }) });
    // Send welcome SMS if opted in
    if (smsOptIn && phone) {
      await sendSMS(phone, `Welcome to MatchedCare, ${name || 'there'}! We'll text you when you're matched with a provider. View your dashboard: matchedcare.us`);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/send-sms', requireAdmin, async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'to and message are required' });
    const sent = await sendSMS(to, message);
    res.json({ success: sent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/test-email', requireAdmin, async (req, res) => {
  try {
    const testTo = req.body.to || 'alandiaz.wb@gmail.com';
    await resend.emails.send({ from: FROM_EMAIL, to: testTo, subject: 'MatchedCare — Test Email', html: emailWrapper(`<h1>Email is working!</h1><p class="subtitle">Your Resend integration is configured correctly.</p>`) });
    res.json({ success: true, sent_to: testTo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/test-sms', requireAdmin, async (req, res) => {
  try {
    const testTo = req.body.to;
    if (!testTo) return res.status(400).json({ error: 'to phone number is required' });
    const sent = await sendSMS(testTo, 'MatchedCare: SMS notifications are working! This is a test message.');
    res.json({ success: sent, sent_to: testTo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// STRIPE ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

app.post('/create-setup-intent', requireUser, async (req, res) => {
  try {
    const { plan_type } = req.body;
    const user_id = req.authUser.id;
    const email = req.authUser.email;
    if (!email) return res.status(400).json({ error: 'Authenticated user email is required' });

    // 1. Find or create the Stripe Customer for this user.
    let customer;
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data.length > 0) {
      customer = existing.data[0];
    } else {
      customer = await stripe.customers.create({
        email,
        metadata: { user_id, plan_type: plan_type || 'provider_founder' },
      });
    }

    // 2. UPSERT the subscriptions row so we never silently drop the customer
    //    id when the row hasn't been created yet (e.g. a brand-new signup).
    await supabase
      .from('subscriptions')
      .upsert(
        {
          therapist_id: user_id,
          stripe_customer_id: customer.id,
          plan_type: plan_type || 'provider_founder',
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
      metadata: { user_id, plan_type: plan_type || 'provider_founder' },
    });

    res.json({
      client_secret: setupIntent.client_secret,
      customer_id: customer.id,
      setup_intent_id: setupIntent.id,
    });
  } catch (err) {
    console.error('create-setup-intent:', err.message);
    res.status(500).json({ error: err.message });
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

    await supabase
      .from('subscriptions')
      .update({
        payment_method_pending: false,
        stripe_customer_id: si.customer,
        status: 'active',
        updated_at: new Date().toISOString(),
      })
      .eq('therapist_id', req.authUser.id);

    res.json({ success: true });
  } catch (err) {
    console.error('confirm-setup-intent:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Clinic base plan includes the first 5 providers; the addon price bills each provider beyond 5.
const PRICES = {
  provider_founder: 'price_1TP9VOPtdczvTubYBbx3FaOR',
  provider_standard: 'price_1TP9VOPtdczvTubYD0iO68q8',
  clinic_founder_base: 'price_1TP9VPPtdczvTubYSorA5S9j',
  clinic_founder_addon: 'price_1TP9VQPtdczvTubYWj6HlaH5',
  clinic_standard_base: 'price_1TP9VRPtdczvTubYkTZhH07J',
  clinic_standard_addon: 'price_1TP9VSPtdczvTubYDTujrcPQ',
};
const CLINIC_BASE_PROVIDERS_INCLUDED = 5;

app.post('/start-billing', requireUser, async (req, res) => {
  try {
    const { stripe_customer_id, plan_type, provider_count } = req.body;
    if (!stripe_customer_id) return res.status(400).json({ error: 'stripe_customer_id is required' });
    const { data: ownedSub } = await supabase.from('subscriptions').select('therapist_id').eq('stripe_customer_id', stripe_customer_id).single();
    if (!ownedSub || ownedSub.therapist_id !== req.authUser.id) return res.status(403).json({ error: 'Forbidden' });

    let founderItems, standardItems;
    if (plan_type === 'clinic') {
      const addonQty = Math.max(0, (Number(provider_count) || 0) - CLINIC_BASE_PROVIDERS_INCLUDED);
      founderItems = [{ price: PRICES.clinic_founder_base }];
      standardItems = [{ price: PRICES.clinic_standard_base }];
      if (addonQty > 0) {
        founderItems.push({ price: PRICES.clinic_founder_addon, quantity: addonQty });
        standardItems.push({ price: PRICES.clinic_standard_addon, quantity: addonQty });
      }
    } else {
      founderItems = [{ price: PRICES.provider_founder }];
      standardItems = [{ price: PRICES.provider_standard }];
    }

    const schedule = await stripe.subscriptionSchedules.create({
      customer: stripe_customer_id,
      start_date: 'now',
      end_behavior: 'release',
      phases: [
        { items: founderItems, iterations: 3 },
        { items: standardItems },
      ],
    });
    res.json({ schedule_id: schedule.id, subscription_id: schedule.subscription, status: 'active' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/create-portal-session', requireUser, async (req, res) => {
  try {
    const { stripe_customer_id, return_url } = req.body;
    if (!stripe_customer_id) return res.status(400).json({ error: 'stripe_customer_id is required' });
    const { data: ownedSub } = await supabase.from('subscriptions').select('therapist_id').eq('stripe_customer_id', stripe_customer_id).single();
    if (!ownedSub || ownedSub.therapist_id !== req.authUser.id) return res.status(403).json({ error: 'Forbidden' });
    const session = await stripe.billingPortal.sessions.create({ customer: stripe_customer_id, return_url: allowedReturnUrl(return_url) });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`MatchedCare Billing Server running on port ${PORT}`);
  console.log(`Email: ${process.env.RESEND_API_KEY ? 'ENABLED' : 'DISABLED'}`);
  console.log(`SMS: ${twilioClient ? 'ENABLED' : 'DISABLED'}`);
});
