// Clicktide Stripe webhook. v16 — billing integrity:
// (1) A bad, missing or stale (> 5 min) signature returns 401. Any v1 signature in the header may
//     match, so rolling the endpoint secret doesn't drop events.
// (2) A subscription is linked to a business ONLY through the user id create-checkout-session took
//     from the caller's verified login (client_reference_id / metadata.user_id) — never by email.
// (3) Subscription events re-read the subscription from Stripe and are applied by the SQL function
//     clicktide_billing_apply_subscription, which ignores events older than the last one applied for
//     that subscription and leaves no plan once the subscription stops paying.
// (4) Wallet money moves only through the locked ledger (clicktide_wallet_*): a top-up is credited
//     once Stripe says it is paid (also for delayed methods), refunds and chargebacks take the credit
//     back, a won chargeback gives it back.
// (5) A processing error returns 500 so Stripe retries; a checkout that matches no business row yet
//     is one too. Unhandled event types return 200 (acknowledged, no retry storm).
// Subscribe the endpoint to every type listed in `handlers` at the bottom.
type StripeEvent = {
  id: string;
  type: string;
  created?: number;
  data: { object: Record<string, unknown> };
};
type Obj = Record<string, unknown>;

const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY") || "";
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SIGNATURE_TOLERANCE_SECONDS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pricePlans: Record<string, string> = {
  // current ($79 / $199 / $449) — what checkout + the billing portal use now
  price_1TjhtKGWBWEX8wHsjfvhyPBa: "Local",
  price_1Tjhv8GWBWEX8wHsQ3nBFXDm: "Growth",
  price_1TjhwWGWBWEX8wHsAtmldOt9: "Scale",
  // legacy ($49 / $149 / $349) — keep mapping any pre-existing subscriptions
  price_1ThaasGWBWEX8wHssSYEbwEl: "Local",
  price_1ThbjeGWBWEX8wHsElMt4z3Z: "Growth",
  price_1ThbjeGWBWEX8wHsNrw2mjPF: "Scale",
};

function normalizePlan(value: unknown) {
  const raw = String(value || "").trim().toLowerCase();
  return ["Local", "Growth", "Scale"].find((plan) => plan.toLowerCase() === raw) || "";
}

function planFromPrice(priceId: unknown) {
  return pricePlans[String(priceId || "")] || "";
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Stripe sends ids either bare or as expanded objects.
function idOf(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return String((value as Obj).id || "");
  return "";
}

// create-checkout-session sets client_reference_id / metadata.user_id from the caller's verified
// login, so these are the only values that may bind billing to a business.
function verifiedUserId(...values: unknown[]) {
  for (const value of values) {
    const id = String(value || "").trim();
    if (UUID.test(id)) return id.toLowerCase();
  }
  return "";
}

function signatureParts(header: string) {
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === "t") timestamp = value;
    if (key === "v1" && value) signatures.push(value);
  }
  return { timestamp, signatures };
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
  const { timestamp, signatures } = signatureParts(sigHeader);
  if (!timestamp || !signatures.length) throw new Error("Missing Stripe signature");
  // Every delivery attempt (including retries) is signed when it is sent, so an old timestamp is a replay.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) throw new Error("Stale Stripe signature");

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`)));
  if (!signatures.some((signature) => safeEqual(digest, signature))) throw new Error("Invalid Stripe signature");
}

async function stripeGet(path: string, allowMissing = false): Promise<Obj | null> {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${stripeSecretKey}` },
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json().catch(() => ({}));
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) throw new Error(data?.error?.message || "Stripe API request failed");
  return data as Obj;
}

async function rpc(fn: string, args: Record<string, unknown>): Promise<Obj> {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON error body; the status below says enough
  }
  if (!response.ok) throw new Error(`${fn} failed: ${(data as Obj | null)?.message || response.status}`);
  return (data && typeof data === "object" ? data : {}) as Obj;
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

// ---- Wallet top-ups ---------------------------------------------------------------------------

async function creditTopup(session: Obj) {
  const metadata = (session.metadata || {}) as Record<string, string>;
  const sessionId = String(session.id || "");
  const userId = verifiedUserId(metadata.user_id, session.client_reference_id);
  if (!userId || !sessionId) {
    console.error(`stripe-webhook: wallet top-up ${sessionId} has no verified user id; nothing credited`);
    return { credited: false, reason: "no_user_id" };
  }
  // Delayed methods (bank debits) complete the session before the money arrives; those are
  // credited by checkout.session.async_payment_succeeded.
  if (session.payment_status !== "paid") {
    return { credited: false, reason: `payment_${String(session.payment_status || "unknown")}` };
  }
  if (String(session.currency || "").toLowerCase() !== "usd") {
    console.error(`stripe-webhook: wallet top-up ${sessionId} is not in USD; nothing credited`);
    return { credited: false, reason: "currency" };
  }
  const amount = Number(session.amount_total || 0) / 100;
  if (!Number.isFinite(amount) || amount <= 0) return { credited: false, reason: "no_amount" };

  const result = await rpc("clicktide_wallet_credit_topup", {
    p_user: userId,
    p_amount: amount,
    p_session_id: sessionId,
    p_payment_intent: idOf(session.payment_intent) || null,
    p_customer: idOf(session.customer) || null,
    p_note: metadata.business_name ? `Stripe Checkout top-up for ${metadata.business_name}` : "Stripe Checkout top-up",
  });
  if (result.ok !== true) {
    console.error(`stripe-webhook: wallet top-up ${sessionId} refused by the ledger: ${result.reason}`);
    return { credited: false, reason: String(result.reason || "refused") };
  }
  return {
    credited: result.duplicate !== true,
    duplicate: result.duplicate === true,
    balance: result.balance,
    recovered: result.recovered,
  };
}

async function reverseTopup(paymentIntent: string, reference: string, kind: "refund" | "dispute", target: number, description: string) {
  const result = await rpc("clicktide_wallet_reverse_topup", {
    p_payment_intent: paymentIntent,
    p_reference: reference,
    p_kind: kind,
    p_target: target,
    p_description: description,
  });
  if (result.skipped === "not_a_wallet_topup") {
    // A top-up whose credit is still being retried looks the same as a payment that never was a
    // top-up; make Stripe retry the reversal until the credit has landed.
    const intent = await stripeGet(`payment_intents/${encodeURIComponent(paymentIntent)}`, true);
    const meta = (intent?.metadata || {}) as Record<string, string>;
    if (meta.type === "wallet_topup" && intent?.status === "succeeded") {
      throw new Error(`Wallet top-up ${paymentIntent} is not credited yet; the ${kind} will be retried`);
    }
  }
  if (result.ok === false) console.error(`stripe-webhook: ${kind} ${reference} refused by the ledger: ${result.reason}`);
  if (Number(result.owed || 0) > 0) {
    console.error(`stripe-webhook: ${kind} ${reference} left $${result.owed} owed by business ${result.user_id}; it comes out of their next top-up`);
  }
  return result;
}

async function handleRefund(event: StripeEvent) {
  const charge = event.data.object;
  const chargeId = String(charge.id || "");
  const paymentIntent = idOf(charge.payment_intent);
  // amount_refunded is cumulative, so an older (smaller) delivery arriving late changes nothing.
  const refunded = Number(charge.amount_refunded || 0) / 100;
  if (!chargeId || !paymentIntent || !(refunded > 0)) return { ignored: "nothing_to_reverse" };
  return reverseTopup(paymentIntent, chargeId, "refund", refunded, "Top-up refunded");
}

async function handleDispute(event: StripeEvent) {
  const dispute = event.data.object;
  const disputeId = String(dispute.id || "");
  let paymentIntent = idOf(dispute.payment_intent);
  if (!paymentIntent && idOf(dispute.charge)) {
    const charge = await stripeGet(`charges/${encodeURIComponent(idOf(dispute.charge))}`, true);
    paymentIntent = idOf(charge?.payment_intent);
  }
  if (!disputeId || !paymentIntent) return { ignored: "no_payment_intent" };

  const status = String(dispute.status || "");
  if (event.type === "charge.dispute.funds_reinstated" || (event.type === "charge.dispute.closed" && status === "won")) {
    return rpc("clicktide_wallet_reinstate", {
      p_reference: disputeId,
      p_payment_intent: paymentIntent,
      p_description: "Chargeback won: top-up restored",
    });
  }
  if (event.type === "charge.dispute.closed") return { ignored: `dispute_${status || "closed"}` };
  // Inquiries (warning_*) move no money unless they turn into a chargeback (funds_withdrawn).
  if (status.startsWith("warning_") && event.type !== "charge.dispute.funds_withdrawn") return { ignored: "inquiry" };

  const amount = Number(dispute.amount || 0) / 100;
  if (!(amount > 0)) return { ignored: "no_amount" };
  return reverseTopup(paymentIntent, disputeId, "dispute", amount, "Top-up charged back");
}

// ---- Subscriptions ----------------------------------------------------------------------------

function subscriptionState(subscription: Obj) {
  const metadata = (subscription.metadata || {}) as Record<string, string>;
  const items = subscription.items as { data?: Array<{ price?: { id?: string }; current_period_end?: number }> } | undefined;
  const item = items?.data?.[0];
  const priceId = String(item?.price?.id || "");
  // Newer Stripe API versions moved current_period_end from the subscription onto its items.
  const periodEnd = Number(subscription.current_period_end || item?.current_period_end || 0);
  const trialStart = Number(subscription.trial_start || 0);
  return {
    id: String(subscription.id || ""),
    customer: idOf(subscription.customer),
    status: String(subscription.status || ""),
    priceId,
    // Price is the source of truth: after a Customer-Portal plan switch the Stripe
    // subscription's metadata.plan is stale, but the price ID always reflects the new plan.
    plan: planFromPrice(priceId) || normalizePlan(metadata.plan),
    periodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    trialStart: trialStart ? new Date(trialStart * 1000).toISOString() : null,
    userId: verifiedUserId(metadata.user_id),
  };
}

async function applySubscription(event: StripeEvent, subscription: Obj, sessionUserId: string, email: string) {
  const state = subscriptionState(subscription);
  if (!state.id.startsWith("sub_") || !state.status) return { applied: false, reason: "no_subscription" };
  // Unknown price and no metadata.plan (e.g. made in the Stripe Dashboard): it never binds a business,
  // but a row that already tracks it must still see it end. With p_plan null the SQL only touches
  // that row, keeps its plan while it pays and clears it once it stops.
  if (!state.plan && sessionUserId) {
    console.warn(`stripe-webhook: checkout subscription ${state.id} is not on a Clicktide plan price; not linked`);
    return { applied: false, reason: "not_a_clicktide_plan" };
  }
  if (sessionUserId && state.userId && sessionUserId !== state.userId) {
    console.error(`stripe-webhook: checkout user ${sessionUserId} != subscription ${state.id} user ${state.userId}; not linked`);
    return { applied: false, reason: "user_mismatch" };
  }
  const result = await rpc("clicktide_billing_apply_subscription", {
    p_event_id: event.id,
    p_event_created: new Date(Number(event.created || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    p_subscription_id: state.id,
    p_customer_id: state.customer || null,
    p_user_id: state.plan ? (sessionUserId || state.userId || null) : null,
    p_status: state.status,
    p_price_id: state.priceId || null,
    p_plan: state.plan || null,
    p_current_period_end: state.periodEnd,
    p_trial_start: state.trialStart,
    p_email: email || null,
  });
  if (!state.plan && result.reason === "no_row") {
    console.warn(`stripe-webhook: subscription ${state.id} is not on a Clicktide plan price and no business tracks it; ignored`);
    return { applied: false, reason: "not_a_clicktide_plan" };
  }
  if (result.reason === "row_tracks_another_subscription") {
    console.warn(`stripe-webhook: subscription ${state.id} (${state.status}) not applied; the business tracks another live subscription`);
  } else if (result.reason === "no_row") {
    console.warn(`stripe-webhook: subscription ${state.id} matches no business row (${result.match})`);
  }
  return result;
}

async function handleSubscriptionEvent(event: StripeEvent) {
  const snapshot = event.data.object;
  const id = String(snapshot.id || "");
  if (!id.startsWith("sub_")) return { applied: false, reason: "no_subscription" };
  // The payload is the state at event time; a retried or late delivery must not write that back.
  const live = await stripeGet(`subscriptions/${encodeURIComponent(id)}`, true);
  return applySubscription(event, live || snapshot, "", "");
}

async function handleCheckout(event: StripeEvent) {
  const session = event.data.object;
  const metadata = (session.metadata || {}) as Record<string, string>;
  if (session.mode === "payment" && metadata.type === "wallet_topup") return creditTopup(session);
  if (session.mode !== "subscription") return { ignored: "not_a_clicktide_checkout" };

  const userId = verifiedUserId(session.client_reference_id, metadata.user_id);
  if (!userId) {
    console.error(`stripe-webhook: checkout ${String(session.id || "")} has no verified user id; not linked to any business`);
    return { applied: false, reason: "no_user_id" };
  }
  const subscriptionId = idOf(session.subscription);
  if (!subscriptionId) return { applied: false, reason: "no_subscription" };
  const subscription = await stripeGet(`subscriptions/${encodeURIComponent(subscriptionId)}`);
  const details = (session.customer_details || {}) as Record<string, string>;
  const result = await applySubscription(event, subscription || {}, userId, String(details.email || session.customer_email || ""));
  // The business row is created at signup, before checkout; if it isn't there yet, let Stripe retry.
  if (result.reason === "no_row") throw new Error(`No Clicktide business row for checkout ${String(session.id || "")} yet`);
  return result;
}

async function handleAsyncPaymentFailed(event: StripeEvent) {
  const session = event.data.object;
  const metadata = (session.metadata || {}) as Record<string, string>;
  if (session.mode === "payment" && metadata.type === "wallet_topup") {
    console.warn(`stripe-webhook: wallet top-up ${String(session.id || "")} payment failed; nothing credited`);
    return { credited: false, reason: "async_payment_failed" };
  }
  return handleCheckout(event);
}

const handlers: Record<string, (event: StripeEvent) => Promise<unknown>> = {
  "checkout.session.completed": handleCheckout,
  "checkout.session.async_payment_succeeded": handleCheckout,
  "checkout.session.async_payment_failed": handleAsyncPaymentFailed,
  "customer.subscription.created": handleSubscriptionEvent,
  "customer.subscription.updated": handleSubscriptionEvent,
  "customer.subscription.deleted": handleSubscriptionEvent,
  "customer.subscription.paused": handleSubscriptionEvent,
  "customer.subscription.resumed": handleSubscriptionEvent,
  "charge.refunded": handleRefund,
  "charge.dispute.created": handleDispute,
  "charge.dispute.funds_withdrawn": handleDispute,
  "charge.dispute.funds_reinstated": handleDispute,
  "charge.dispute.closed": handleDispute,
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!stripeSecretKey || !serviceRoleKey) return json({ error: "Server secrets are not configured" }, 500);

  const rawBody = await req.text();

  // 1) Authenticate. A bad/missing signature is junk or a secret mismatch — return 401 so
  // it is clearly distinguishable from a real processing failure when scanning the logs.
  try {
    await verifyStripeSignature(rawBody, req.headers.get("stripe-signature") || "");
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Signature verification failed" }, 401);
  }

  // 2) Process. On a processing error return 500 so Stripe RETRIES until it succeeds —
  // a real billing event is never silently dropped on a transient hiccup.
  try {
    const event = JSON.parse(rawBody) as StripeEvent;
    if (!event?.id || !event?.type || !event?.data?.object) return json({ error: "Malformed event" }, 400);
    if (await eventAlreadyProcessed(event)) return json({ received: true, duplicate: true });

    const handler = handlers[event.type];
    const result = handler ? await handler(event) : undefined;

    await recordEventProcessed(event);
    return json(result === undefined ? { received: true } : { received: true, result });
  } catch (error) {
    console.error("stripe-webhook:", error);
    return json({ error: error instanceof Error ? error.message : "Webhook failed" }, 500);
  }
});
