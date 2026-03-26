const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3001;

// Supabase client with service role key (server-side only)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// CORS — allow your frontend domain
app.use(cors({
  origin: ['https://matchedcare.us', 'https://www.matchedcare.us', 'http://localhost:5173', 'http://localhost:3000'],
  methods: ['GET', 'POST'],
  credentials: true
}));

// Stripe webhook needs raw body
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('Webhook received:', event.type);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      console.log('Checkout session completed:', session.id);

      // If this was a setup mode session, save the customer ID and payment method
      if (session.mode === 'setup' && session.metadata?.user_id) {
        try {
          await supabase
            .from('subscriptions')
            .update({
              stripe_customer_id: session.customer,
              status: 'trialing',
              updated_at: new Date().toISOString()
            })
            .eq('therapist_id', session.metadata.user_id);

          console.log('Updated subscription for user:', session.metadata.user_id);
        } catch (err) {
          console.error('Error updating subscription:', err.message);
        }
      }
      break;
    }

    case 'customer.subscription.created': {
      const subscription = event.data.object;
      console.log('Subscription created:', subscription.id);
      break;
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      console.log('Subscription updated:', subscription.id, 'Status:', subscription.status);

      // Find the customer's user and update status
      try {
        const { data } = await supabase
          .from('subscriptions')
          .select('therapist_id')
          .eq('stripe_customer_id', subscription.customer)
          .single();

        if (data) {
          await supabase
            .from('subscriptions')
            .update({
              stripe_subscription_id: subscription.id,
              status: subscription.status === 'active' ? 'active' : subscription.status,
              updated_at: new Date().toISOString()
            })
            .eq('therapist_id', data.therapist_id);
        }
      } catch (err) {
        console.error('Error handling subscription update:', err.message);
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      console.log('Subscription cancelled:', subscription.id);

      try {
        await supabase
          .from('subscriptions')
          .update({
            status: 'cancelled',
            updated_at: new Date().toISOString()
          })
          .eq('stripe_subscription_id', subscription.id);
      } catch (err) {
        console.error('Error handling subscription deletion:', err.message);
      }
      break;
    }

    default:
      console.log('Unhandled event type:', event.type);
  }

  res.json({ received: true });
});

// JSON body parser for all other routes
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'matchedcare-billing' });
});

// ═══════════════════════════════════════════════════════════════════════════
// CREATE SETUP INTENT — Collects payment method without charging
// Uses Stripe Checkout in setup mode for hosted, secure card collection
// ═══════════════════════════════════════════════════════════════════════════
app.post('/create-setup-intent', async (req, res) => {
  try {
    const { email, user_id, plan_type } = req.body;

    if (!email || !user_id) {
      return res.status(400).json({ error: 'Email and user_id are required' });
    }

    // Check if customer already exists
    let customer;
    const existing = await stripe.customers.list({ email, limit: 1 });

    if (existing.data.length > 0) {
      customer = existing.data[0];
    } else {
      customer = await stripe.customers.create({
        email,
        metadata: { user_id, plan_type: plan_type || 'provider_founder' }
      });
    }

    // Update Supabase with Stripe customer ID
    await supabase
      .from('subscriptions')
      .update({
        stripe_customer_id: customer.id,
        updated_at: new Date().toISOString()
      })
      .eq('therapist_id', user_id);

    // Create Stripe Checkout Session in setup mode
    const session = await stripe.checkout.sessions.create({
      mode: 'setup',
      customer: customer.id,
      payment_method_types: ['card'],
      success_url: `${req.headers.origin || 'https://matchedcare.us'}?setup=success`,
      cancel_url: `${req.headers.origin || 'https://matchedcare.us'}?setup=cancelled`,
      metadata: { user_id, plan_type: plan_type || 'provider_founder' }
    });

    console.log('Setup session created:', session.id, 'for user:', user_id);
    res.json({ url: session.url, session_id: session.id });

  } catch (err) {
    console.error('Error creating setup intent:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// START BILLING — Called after 5th referral to create subscription
// Creates a Subscription Schedule: Founder price for 3 months → Standard
// ═══════════════════════════════════════════════════════════════════════════
app.post('/start-billing', async (req, res) => {
  try {
    const { stripe_customer_id, plan_type } = req.body;

    if (!stripe_customer_id) {
      return res.status(400).json({ error: 'stripe_customer_id is required' });
    }

    // Price IDs from your Stripe account
    const prices = {
      provider_founder: 'price_1TD5voQ9vFrlUZBqpkQQZEB8',     // $89.99/mo
      provider_standard: 'price_1TD60VQ9vFrlUZBqmeZY4tvw',     // $119.99/mo
      clinic_founder: 'price_1TD62SQ9vFrlUZBqlpzcEOlT',        // $375/mo
      clinic_standard: 'price_1TD64kQ9vFrlUZBqs49ylM8J',       // $500/mo
    };

    const founderPrice = plan_type === 'clinic' ? prices.clinic_founder : prices.provider_founder;
    const standardPrice = plan_type === 'clinic' ? prices.clinic_standard : prices.provider_standard;

    // Create subscription schedule: 3 months founder → standard
    const schedule = await stripe.subscriptionSchedules.create({
      customer: stripe_customer_id,
      start_date: 'now',
      end_behavior: 'release',
      phases: [
        {
          items: [{ price: founderPrice }],
          iterations: 3, // 3 months at founder price
        },
        {
          items: [{ price: standardPrice }],
          // No end — continues at standard price
        }
      ]
    });

    console.log('Subscription schedule created:', schedule.id);
    res.json({
      schedule_id: schedule.id,
      subscription_id: schedule.subscription,
      status: 'active'
    });

  } catch (err) {
    console.error('Error starting billing:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// CREATE PORTAL SESSION — Let providers manage their subscription
// ═══════════════════════════════════════════════════════════════════════════
app.post('/create-portal-session', async (req, res) => {
  try {
    const { stripe_customer_id, return_url } = req.body;

    if (!stripe_customer_id) {
      return res.status(400).json({ error: 'stripe_customer_id is required' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: stripe_customer_id,
      return_url: return_url || 'https://matchedcare.us'
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error('Error creating portal session:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`MatchedCare Billing Server running on port ${PORT}`);
});
