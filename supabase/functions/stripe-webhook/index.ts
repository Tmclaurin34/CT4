type StripeEvent = {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
};

const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY") || "";
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function signatureParts(header: string) {
  const parts = Object.fromEntries(header.split(",").map((part) => {
    const [key, value] = part.split("=");
    return [key, value];
  }));
  return { timestamp: parts.t || "", signature: parts.v1 || "" };
}

function hex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function verifyStripeSignature(rawBody: string, sigHeader: string) {
  if (!webhookSecret) throw new Error("Stripe webhook secret is not configured");
  const { timestamp, signature } = signatureParts(sigHeader);
  if (!timestamp || !signature) throw new Error("Missing Stripe signature");

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  if (!safeEqual(hex(digest), signature)) throw new Error("Invalid Stripe signature");
}

async function stripeGet(path: string) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${stripeSecretKey}` },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "Stripe API request failed");
  return data;
}

async function eventAlreadyProcessed(event: StripeEvent) {
  const response = await fetch(`${supabaseUrl}/rest/v1/stripe_webhook_events?id=eq.${encodeURIComponent(event.id)}&select=id&limit=1`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });
  if (!response.ok) throw new Error("Could not check Stripe webhook event");
  const rows = await response.json();
  return Array.isArray(rows) && rows.length > 0;
}

async function recordEventProcessed(event: StripeEvent) {
  const response = await fetch(`${supabaseUrl}/rest/v1/stripe_webhook_events`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      id: event.id,
      event_type: event.type,
      processed_at: new Date().toISOString(),
    }),
  });

  if (response.status === 409) return;
  if (!response.ok) throw new Error("Could not record Stripe webhook event");
}

async function updateClicktide(filters: string[], fields: Record<string, unknown>) {
  for (const filter of filters) {
    const response = await fetch(`${supabaseUrl}/rest/v1/clicktide?${filter}`, {
      method: "PATCH",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(fields),
    });
    if (response.ok) {
      const rows = await response.json();
      if (Array.isArray(rows) && rows.length) return true;
    }
  }
  return false;
}

async function walletSessionExists(sessionId: string) {
  const response = await fetch(`${supabaseUrl}/rest/v1/wallet?stripe_session_id=eq.${encodeURIComponent(sessionId)}&select=id&limit=1`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });
  if (!response.ok) throw new Error("Could not check gift wallet session");
  const rows = await response.json();
  return Array.isArray(rows) && rows.length > 0;
}

async function latestWalletBalance(userId: string) {
  const response = await fetch(`${supabaseUrl}/rest/v1/wallet?user_id=eq.${encodeURIComponent(userId)}&select=balance&order=created_at.desc&limit=1`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });
  if (!response.ok) throw new Error("Could not read gift wallet balance");
  const rows = await response.json();
  return Array.isArray(rows) && rows.length ? Number(rows[0].balance || 0) : 0;
}

async function insertWalletTopup(session: Record<string, unknown>) {
  const metadata = (session.metadata || {}) as Record<string, string>;
  const userId = metadata.user_id || String(session.client_reference_id || "");
  if (!userId) throw new Error("Wallet top-up is missing user id");

  const sessionId = String(session.id || "");
  if (sessionId && await walletSessionExists(sessionId)) return true;

  const amount = Number(session.amount_total || 0) / 100;
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Wallet top-up amount is invalid");

  const currentBalance = await latestWalletBalance(userId);
  const response = await fetch(`${supabaseUrl}/rest/v1/wallet`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      user_id: userId,
      desc: "Gift wallet top-up",
      amount,
      balance: currentBalance + amount,
      transaction_type: "topup",
      status: "posted",
      stripe_session_id: sessionId || null,
      stripe_payment_intent_id: session.payment_intent || null,
      stripe_customer_id: session.customer || null,
      note: metadata.business_name ? `Stripe Checkout top-up for ${metadata.business_name}` : "Stripe Checkout top-up",
    }),
  });

  if (response.status === 409) return true;
  if (!response.ok) throw new Error("Could not record gift wallet top-up");
  return true;
}

function subscriptionFields(subscription: Record<string, unknown>, fallback: Record<string, unknown> = {}) {
  const metadata = (subscription.metadata || fallback.metadata || {}) as Record<string, string>;
  const items = subscription.items as { data?: Array<{ price?: { id?: string } }> } | undefined;
  const periodEnd = subscription.current_period_end as number | undefined;
  return {
    plan: metadata.plan || fallback.plan || "Growth",
    stripe_customer_id: subscription.customer || fallback.customer || null,
    stripe_subscription_id: subscription.id || fallback.subscription || null,
    stripe_subscription_status: subscription.status || fallback.payment_status || null,
    stripe_price_id: items?.data?.[0]?.price?.id || fallback.price_id || null,
    stripe_current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
  };
}

async function handleCheckoutCompleted(session: Record<string, unknown>) {
  const metadata = (session.metadata || {}) as Record<string, string>;
  if (metadata.type === "wallet_topup" || session.mode === "payment") {
    return insertWalletTopup(session);
  }

  const subscriptionId = typeof session.subscription === "string" ? session.subscription : "";
  const subscription = subscriptionId ? await stripeGet(`subscriptions/${subscriptionId}`) : {};
  const fields = subscriptionFields(subscription, {
    metadata,
    customer: session.customer,
    subscription: session.subscription,
    payment_status: session.payment_status,
  });

  const filters = [];
  if (metadata.user_id) filters.push(`user_id=eq.${encodeURIComponent(metadata.user_id)}`);
  if (session.customer_email) filters.push(`email=eq.${encodeURIComponent(String(session.customer_email))}`);
  return updateClicktide(filters, fields);
}

async function handleSubscriptionChange(subscription: Record<string, unknown>) {
  const metadata = (subscription.metadata || {}) as Record<string, string>;
  const fields = subscriptionFields(subscription);

  const filters = [];
  if (metadata.user_id) filters.push(`user_id=eq.${encodeURIComponent(metadata.user_id)}`);
  if (subscription.customer) filters.push(`stripe_customer_id=eq.${encodeURIComponent(String(subscription.customer))}`);
  if (subscription.id) filters.push(`stripe_subscription_id=eq.${encodeURIComponent(String(subscription.id))}`);
  return updateClicktide(filters, fields);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!stripeSecretKey || !serviceRoleKey) return json({ error: "Server secrets are not configured" }, 500);

  const rawBody = await req.text();
  try {
    await verifyStripeSignature(rawBody, req.headers.get("stripe-signature") || "");
    const event = JSON.parse(rawBody) as StripeEvent;
    if (await eventAlreadyProcessed(event)) return json({ received: true, duplicate: true });

    if (event.type === "checkout.session.completed") {
      await handleCheckoutCompleted(event.data.object);
    }

    if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      await handleSubscriptionChange(event.data.object);
    }

    await recordEventProcessed(event);
    return json({ received: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Webhook failed" }, 400);
  }
});
