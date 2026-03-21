// ═══════════════════════════════════════════════════════════════════════════════
// MATCHEDCARE — Stripe Webhook & Referral Billing Server
// Deploy to: Railway, Render, Fly.io, or any Node.js host
// ═══════════════════════════════════════════════════════════════════════════════

const express = require("express");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const stripe = new Stripe(STRIPE_SECRET_KEY);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ── Price IDs ───────────────────────────────────────────────────────────────
const PRICES = {
  provider_founder:   "price_1TD5voQ9vFrlUZBqpkQQZEB8",  // $89.99/mo
  provider_standard:  "price_1TD60VQ9vFrlUZBqmeZY4tvw",  // $119.99/mo
  clinic_founder:     "price_1TD62SQ9vFrlUZBqlpzcEOlT",  // $375/mo
  clinic_standard:    "price_1TD64kQ9vFrlUZBqs49ylM8J",  // $500/mo
  clinic_addon_founder:  "price_1TD640Q9vFrlUZBqTkoFRRQO", // $37.50/mo
  clinic_addon_standard: "price_1TD668Q9vFrlUZBqcaPP7lTK", // $50/mo
};

const app = express();

// ── Webhook endpoint (raw body needed for signature verification) ────────────
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`Stripe event: ${event.type}`);

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object;
      // Find provider by stripe_customer_id
      const { data } = await supabase
        .from("subscriptions")
        .select("therapist_id")
        .eq("stripe_customer_id", sub.customer)
        .single();
      if (data) {
        await supabase.rpc("update_stripe_subscription", {
          p_provider_id: data.therapist_id,
          p_customer_id: sub.customer,
          p_subscription_id: sub.id,
          p_status: sub.status === "active" ? "active" : sub.status === "trialing" ? "trialing" : sub.status,
        });
      }
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const { data } = await supabase
        .from("subscriptions")
        .select("therapist_id")
        .eq("stripe_customer_id", sub.customer)
        .single();
      if (data) {
        await supabase.rpc("update_stripe_subscription", {
          p_provider_id: data.therapist_id,
          p_customer_id: sub.customer,
          p_subscription_id: sub.id,
          p_status: "canceled",
        });
      }
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object;
      console.warn(`Payment failed for customer ${invoice.customer}`);
      // Update status to past_due
      const { data } = await supabase
        .from("subscriptions")
        .select("therapist_id")
        .eq("stripe_customer_id", invoice.customer)
        .single();
      if (data) {
        await supabase
          .from("subscriptions")
          .update({ status: "past_due" })
          .eq("therapist_id", data.therapist_id);
      }
      break;
    }

    default:
      console.log(`Unhandled event: ${event.type}`);
  }

  res.json({ received: true });
});

// ── JSON body for all other routes ──────────────────────────────────────────
app.use(express.json());

// ── Start billing after 4th referral ────────────────────────────────────────
// Called by Supabase Edge Function or your matching system
app.post("/start-billing", async (req, res) => {
  try {
    const { provider_id, provider_type, email, name } = req.body;
    // provider_type: "provider" or "clinic"

    if (!provider_id || !email) {
      return res.status(400).json({ error: "provider_id and email required" });
    }

    const isClinic = provider_type === "clinic";
    const founderPrice = isClinic ? PRICES.clinic_founder : PRICES.provider_founder;
    const standardPrice = isClinic ? PRICES.clinic_standard : PRICES.provider_standard;

    // 1. Create or retrieve Stripe customer
    let customer;
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("therapist_id", provider_id)
      .single();

    if (sub?.stripe_customer_id) {
      customer = await stripe.customers.retrieve(sub.stripe_customer_id);
    } else {
      customer = await stripe.customers.create({
        email,
        name: name || email,
        metadata: { provider_id, provider_type },
      });
      // Save customer ID to Supabase
      await supabase
        .from("subscriptions")
        .update({ stripe_customer_id: customer.id })
        .eq("therapist_id", provider_id);
    }

    // 2. Create a Subscription Schedule:
    //    Phase 1: Founder pricing for 3 months
    //    Phase 2: Standard pricing ongoing
    const now = Math.floor(Date.now() / 1000);
    const threeMonthsLater = now + (90 * 24 * 60 * 60); // 90 days

    const schedule = await stripe.subscriptionSchedules.create({
      customer: customer.id,
      start_date: "now",
      end_behavior: "release", // continues as regular subscription after schedule ends
      phases: [
        {
          items: [{ price: founderPrice, quantity: 1 }],
          end_date: threeMonthsLater,
          metadata: { phase: "founder", provider_id },
        },
        {
          items: [{ price: standardPrice, quantity: 1 }],
          metadata: { phase: "standard", provider_id },
        },
      ],
    });

    // 3. Update Supabase with schedule info
    await supabase.rpc("update_stripe_subscription", {
      p_provider_id: provider_id,
      p_customer_id: customer.id,
      p_subscription_id: schedule.subscription,
      p_schedule_id: schedule.id,
      p_status: "active",
    });

    console.log(`Billing started for ${provider_id}: Founder → Standard in 90 days`);

    res.json({
      success: true,
      customer_id: customer.id,
      schedule_id: schedule.id,
      subscription_id: schedule.subscription,
      founder_price: founderPrice,
      standard_price: standardPrice,
      transition_date: new Date(threeMonthsLater * 1000).toISOString(),
    });

  } catch (err) {
    console.error("Start billing error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Collect payment method during signup (before billing starts) ─────────────
// Creates a SetupIntent so we have their card on file for when billing begins
app.post("/create-setup-intent", async (req, res) => {
  try {
    const { provider_id, email, name } = req.body;

    // Create Stripe customer
    const customer = await stripe.customers.create({
      email,
      name: name || email,
      metadata: { provider_id },
    });

    // Save customer ID
    await supabase
      .from("subscriptions")
      .update({ stripe_customer_id: customer.id })
      .eq("therapist_id", provider_id);

    // Create SetupIntent (collects card without charging)
    const setupIntent = await stripe.setupIntents.create({
      customer: customer.id,
      payment_method_types: ["card"],
      metadata: { provider_id },
    });

    res.json({
      client_secret: setupIntent.client_secret,
      customer_id: customer.id,
    });

  } catch (err) {
    console.error("Setup intent error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Customer portal (manage billing) ────────────────────────────────────────
app.post("/create-portal-session", async (req, res) => {
  try {
    const { stripe_customer_id, return_url } = req.body;
    const session = await stripe.billingPortal.sessions.create({
      customer: stripe_customer_id,
      return_url: return_url || "https://matchedcare.us",
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Portal session error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "matchedcare-billing", timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`MatchedCare Billing Server running on port ${PORT}`);
  console.log(`Webhook: POST /webhook`);
  console.log(`Start billing: POST /start-billing`);
  console.log(`Setup intent: POST /create-setup-intent`);
  console.log(`Customer portal: POST /create-portal-session`);
});
