const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3001;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.FROM_EMAIL || 'MatchedCare <notifications@matchedcare.us>';

app.use(cors({
  origin: ['https://matchedcare.us', 'https://www.matchedcare.us', 'http://localhost:5173', 'http://localhost:3000'],
  methods: ['GET', 'POST'],
  credentials: true
}));

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
        await supabase.from('subscriptions').update({ stripe_customer_id: session.customer, status: 'trialing', updated_at: new Date().toISOString() }).eq('therapist_id', session.metadata.user_id);
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
  res.json({ status: 'ok', service: 'matchedcare-billing', email: !!process.env.RESEND_API_KEY });
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
  return emailWrapper(`
    <h1>You've been matched!</h1>
    <p class="subtitle">Great news, ${clientName}. We've found a provider who fits what you're looking for.</p>
    <div class="info-box">
      <p class="info-label">Your Match</p>
      <p class="info-value">${providerName}</p>
      ${providerCredentials ? `<p style="font-size:13px;color:#6E7178;margin:4px 0 0">${providerCredentials} · ${providerType || 'Provider'}</p>` : ''}
      ${matchScore ? `<p style="margin:8px 0 0"><span class="score">${Math.round(matchScore)}% compatibility</span></p>` : ''}
    </div>
    ${explanation ? `<div class="highlight"><p>${explanation}</p></div>` : ''}
    <div class="info-box">
      <p class="info-label">Contact</p>
      <p class="info-value"><a href="mailto:${providerEmail}" style="color:#4A7C9B;text-decoration:none">${providerEmail}</a></p>
    </div>
    <p style="font-size:14px;color:#6E7178;line-height:1.6">Your provider has been notified and is ready to connect. You can reach out directly or log in to your dashboard to send a message.</p>
    <div class="cta-wrap"><a href="https://matchedcare.us?v=dashboard" class="cta">Go to Dashboard →</a></div>
  `);
}

function providerMatchEmail({ providerName, clientName, clientEmail, matchScore, concerns, explanation, referralCount }) {
  return emailWrapper(`
    <h1>New client referral</h1>
    <p class="subtitle">${providerName}, you have a new matched client.</p>
    <div class="info-box">
      <p class="info-label">Client</p>
      <p class="info-value">${clientName}</p>
      ${matchScore ? `<p style="margin:8px 0 0"><span class="score">${Math.round(matchScore)}% compatibility</span></p>` : ''}
    </div>
    ${concerns && concerns.length > 0 ? `<div class="info-box"><p class="info-label">Primary Concerns</p><p style="font-size:14px;color:#2C3038;margin:4px 0 0">${concerns.join(', ')}</p></div>` : ''}
    ${explanation ? `<div class="highlight"><p><strong>Why you were matched:</strong> ${explanation}</p></div>` : ''}
    <div class="info-box">
      <p class="info-label">Client Contact</p>
      <p class="info-value"><a href="mailto:${clientEmail}" style="color:#4A7C9B;text-decoration:none">${clientEmail}</a></p>
    </div>
    ${referralCount !== undefined ? `<p style="font-size:13px;color:#9A9DA4;margin-top:16px">This is referral #${referralCount}${referralCount < 5 ? ' of your 5 free referrals.' : '. Billing is now active.'}</p>` : ''}
    <div class="cta-wrap"><a href="https://matchedcare.us?v=dashboard" class="cta">View in Dashboard →</a></div>
  `);
}

function clinicMatchEmail({ clinicName, clientName, clientEmail, serviceType, matchScore, explanation, ageGroup }) {
  const serviceLabels = { aba: 'ABA Services', speech: 'Speech Therapy', occupational_therapy: 'Occupational Therapy' };
  return emailWrapper(`
    <h1>New client matched to your clinic</h1>
    <p class="subtitle">${clinicName}, a new client has been matched to your practice.</p>
    <div class="info-box">
      <p class="info-label">Client</p>
      <p class="info-value">${clientName}</p>
      <p style="font-size:13px;color:#6E7178;margin:4px 0 0">Service: ${serviceLabels[serviceType] || serviceType}${ageGroup ? ' · Age group: ' + ageGroup : ''}</p>
      ${matchScore ? `<p style="margin:8px 0 0"><span class="score">${Math.round(matchScore)}% compatibility</span></p>` : ''}
    </div>
    ${explanation ? `<div class="highlight"><p>${explanation}</p></div>` : ''}
    <div class="info-box">
      <p class="info-label">Client Contact</p>
      <p class="info-value"><a href="mailto:${clientEmail}" style="color:#4A7C9B;text-decoration:none">${clientEmail}</a></p>
    </div>
    <p style="font-size:14px;color:#6E7178;line-height:1.6">Please assign this client to an available provider and reach out to schedule an initial consultation.</p>
    <div class="cta-wrap"><a href="https://matchedcare.us?v=dashboard" class="cta">View in Dashboard →</a></div>
  `);
}

function welcomeEmail({ name, role }) {
  const msgs = {
    client: "We're here to help you find a provider who truly fits. Your information is safe, confidential, and never shared without your permission.",
    therapist: "Thank you for joining our network. Complete your profile and you'll start receiving matched client referrals. Your first 5 referrals are free.",
    clinic: "Thank you for registering your clinic. Once activated, you'll start receiving matched client referrals automatically."
  };
  return emailWrapper(`
    <h1>Welcome to MatchedCare</h1>
    <p class="subtitle">${name}, your account has been created.</p>
    <p style="font-size:14px;color:#6E7178;line-height:1.7">${msgs[role] || msgs.client}</p>
    <div class="cta-wrap"><a href="https://matchedcare.us" class="cta">Get Started →</a></div>
  `);
}

// ═══════════════════════════════════════════════════════════════════════════
// EMAIL ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

app.post('/notify-match', async (req, res) => {
  try {
    const { match_id, match_type } = req.body;
    if (!match_id) return res.status(400).json({ error: 'match_id is required' });

    if (match_type === 'clinic') {
      const { data: match } = await supabase.from('clinic_matches').select('*').eq('id', match_id).single();
      if (!match) return res.status(404).json({ error: 'Clinic match not found' });

      const { data: clientProfile } = await supabase.from('profiles').select('full_name, email').eq('user_id', match.client_id).single();
      const { data: clinic } = await supabase.from('clinics').select('clinic_name, email, owner_id').eq('id', match.clinic_id).single();
      const { data: ownerProfile } = await supabase.from('profiles').select('email').eq('user_id', clinic?.owner_id).single();

      const clientEmail = clientProfile?.email;
      const clinicEmail = clinic?.email || ownerProfile?.email;

      if (clientEmail) {
        await resend.emails.send({ from: FROM_EMAIL, to: clientEmail, subject: `You've been matched with ${clinic?.clinic_name || 'a clinic'}!`, html: clientMatchEmail({ clientName: clientProfile?.full_name || 'there', providerName: clinic?.clinic_name || 'Your Clinic', providerCredentials: null, providerType: match.service_type, matchScore: match.composite_score, providerEmail: clinicEmail || '', explanation: match.explanation }) });
      }
      if (clinicEmail) {
        await resend.emails.send({ from: FROM_EMAIL, to: clinicEmail, subject: `New client matched to ${clinic?.clinic_name}`, html: clinicMatchEmail({ clinicName: clinic?.clinic_name || 'Your Clinic', clientName: clientProfile?.full_name || 'New Client', clientEmail: clientEmail || '', serviceType: match.service_type, matchScore: match.composite_score, explanation: match.explanation, ageGroup: null }) });
      }
      res.json({ success: true, type: 'clinic', emails_sent: [clientEmail, clinicEmail].filter(Boolean).length });

    } else {
      const { data: match } = await supabase.from('matches').select('*').eq('id', match_id).single();
      if (!match) return res.status(404).json({ error: 'Match not found' });

      const { data: clientProfile } = await supabase.from('profiles').select('full_name, email').eq('user_id', match.client_id).single();
      const { data: providerProfile } = await supabase.from('profiles').select('full_name, email').eq('user_id', match.therapist_id).single();
      const { data: therapist } = await supabase.from('therapists').select('credentials, provider_type').eq('user_id', match.therapist_id).single();
      const { data: sub } = await supabase.from('subscriptions').select('referral_count').eq('therapist_id', match.therapist_id).single();
      const { data: clientSummary } = await supabase.from('client_summaries').select('primary_concerns').eq('client_id', match.client_id).single();

      const clientEmail = clientProfile?.email;
      const providerEmail = providerProfile?.email;

      if (clientEmail) {
        await resend.emails.send({ from: FROM_EMAIL, to: clientEmail, subject: `You've been matched with ${providerProfile?.full_name || 'a provider'}!`, html: clientMatchEmail({ clientName: clientProfile?.full_name || 'there', providerName: providerProfile?.full_name || 'Your Provider', providerCredentials: therapist?.credentials, providerType: therapist?.provider_type, matchScore: match.composite_score, providerEmail: providerEmail || '', explanation: match.explanation }) });
      }
      if (providerEmail) {
        await resend.emails.send({ from: FROM_EMAIL, to: providerEmail, subject: `New client referral — ${clientProfile?.full_name || 'New Client'}`, html: providerMatchEmail({ providerName: providerProfile?.full_name || 'there', clientName: clientProfile?.full_name || 'New Client', clientEmail: clientEmail || '', matchScore: match.composite_score, concerns: clientSummary?.primary_concerns || [], explanation: match.explanation, referralCount: sub?.referral_count }) });
      }
      res.json({ success: true, type: 'provider', emails_sent: [clientEmail, providerEmail].filter(Boolean).length });
    }
  } catch (err) {
    console.error('Error sending match emails:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/send-welcome', async (req, res) => {
  try {
    const { email, name, role } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    await resend.emails.send({ from: FROM_EMAIL, to: email, subject: 'Welcome to MatchedCare', html: welcomeEmail({ name: name || 'there', role: role || 'client' }) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/test-email', async (req, res) => {
  try {
    const testTo = req.body.to || 'alandiaz.wb@gmail.com';
    await resend.emails.send({ from: FROM_EMAIL, to: testTo, subject: 'MatchedCare — Test Email', html: emailWrapper(`<h1>Email is working!</h1><p class="subtitle">Your Resend integration is configured correctly.</p>`) });
    res.json({ success: true, sent_to: testTo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// STRIPE ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

app.post('/create-setup-intent', async (req, res) => {
  try {
    const { email, user_id, plan_type } = req.body;
    if (!email || !user_id) return res.status(400).json({ error: 'Email and user_id are required' });
    let customer;
    const existing = await stripe.customers.list({ email, limit: 1 });
    customer = existing.data.length > 0 ? existing.data[0] : await stripe.customers.create({ email, metadata: { user_id, plan_type: plan_type || 'provider_founder' } });
    await supabase.from('subscriptions').update({ stripe_customer_id: customer.id, updated_at: new Date().toISOString() }).eq('therapist_id', user_id);
    const session = await stripe.checkout.sessions.create({ mode: 'setup', customer: customer.id, payment_method_types: ['card'], success_url: `${req.headers.origin || 'https://matchedcare.us'}?setup=success`, cancel_url: `${req.headers.origin || 'https://matchedcare.us'}?setup=cancelled`, metadata: { user_id, plan_type: plan_type || 'provider_founder' } });
    res.json({ url: session.url, session_id: session.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/start-billing', async (req, res) => {
  try {
    const { stripe_customer_id, plan_type } = req.body;
    if (!stripe_customer_id) return res.status(400).json({ error: 'stripe_customer_id is required' });
    const prices = { provider_founder: 'price_1TD5voQ9vFrlUZBqpkQQZEB8', provider_standard: 'price_1TD60VQ9vFrlUZBqmeZY4tvw', clinic_founder: 'price_1TD62SQ9vFrlUZBqlpzcEOlT', clinic_standard: 'price_1TD64kQ9vFrlUZBqs49ylM8J' };
    const founderPrice = plan_type === 'clinic' ? prices.clinic_founder : prices.provider_founder;
    const standardPrice = plan_type === 'clinic' ? prices.clinic_standard : prices.provider_standard;
    const schedule = await stripe.subscriptionSchedules.create({ customer: stripe_customer_id, start_date: 'now', end_behavior: 'release', phases: [{ items: [{ price: founderPrice }], iterations: 3 }, { items: [{ price: standardPrice }] }] });
    res.json({ schedule_id: schedule.id, subscription_id: schedule.subscription, status: 'active' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/create-portal-session', async (req, res) => {
  try {
    const { stripe_customer_id, return_url } = req.body;
    if (!stripe_customer_id) return res.status(400).json({ error: 'stripe_customer_id is required' });
    const session = await stripe.billingPortal.sessions.create({ customer: stripe_customer_id, return_url: return_url || 'https://matchedcare.us' });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`MatchedCare Billing Server running on port ${PORT}`);
  console.log(`Email notifications: ${process.env.RESEND_API_KEY ? 'ENABLED' : 'DISABLED'}`);
});
