const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type CheckoutBody = {
  type?: string;
  plan?: string;
  campaign_mode?: string;
  amount?: number;
  email?: string; // ignored: Stripe gets the caller's login email
  business_name?: string;
  user_id?: string;
  success_url?: string;
  cancel_url?: string;
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY") || "";

// Prices are HARDCODED on purpose: stale GROWTH_PRICE_ID/SCALE_PRICE_ID env vars
// on the project would silently override fallbacks — never reintroduce env reads here.
const planPrices: Record<string, string> = {
  Local: "price_1TjhtKGWBWEX8wHsjfvhyPBa",   // $79/mo
  Growth: "price_1Tjhv8GWBWEX8wHsQ3nBFXDm",  // $199/mo
  Scale: "price_1TjhwWGWBWEX8wHsAtmldOt9",   // $449/mo
};
const canonicalPlans = Object.keys(planPrices);

function normalizePlan(plan: unknown) {
  const raw = String(plan || "").trim().toLowerCase();
  return canonicalPlans.find((name) => name.toLowerCase() === raw) || "";
}

// 30-day free trial, once: never for a business, login email or Stripe customer that already had
// a subscription. Card collected up front, first charge on day 30.
const TRIAL_DAYS = "30";
// A subscription in one of these states still bills, can be paid up, resumed (paused: trial ended
// without a card) or finished (incomplete: first payment awaiting authentication). The owner
// manages it in the Customer Portal instead of starting a second subscription.
const LIVE_STATUSES = ["trialing", "active", "past_due", "unpaid", "paused", "incomplete"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNAVAILABLE = "Checkout isn't available right now — please try again in a minute.";

// Redirect allowlist — checkout success/cancel URLs may only point at our own
// origins (production, Pages previews, local dev). Anything else falls back to
// the default, so a crafted request can't bounce buyers to an external site.
function allowedRedirect(url: string) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const localDev = (host === "localhost" || host === "127.0.0.1");
    if (u.protocol !== "https:" && !(u.protocol === "http:" && localDev)) return false;
    if (host === "goclicktide.com" || host === "www.goclicktide.com") return true;
    if (host === "clicktide-app.pages.dev" || host.endsWith(".clicktide-app.pages.dev")) return true;
    return localDev;
  } catch {
    return false;
  }
}
function safeUrl(value: unknown) {
  return typeof value === "string" && allowedRedirect(value) ? value : "";
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function authedUser(req: Request) {
  const authorization = req.headers.get("authorization") || "";
  if (!serviceRoleKey || !authorization.toLowerCase().startsWith("bearer ")) return null;
  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: authorization,
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const user = await response.json();
    const id = String(user?.id || "");
    if (!UUID.test(id)) return null;
    return { id, email: String(user?.email || "").trim().toLowerCase() };
  } catch {
    return null;
  }
}

function clientIp(req: Request) {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}

// Fails open: starting a checkout costs nothing and must keep working if the limiter is unreachable.
async function underLimit(bucket: string, windowSeconds: number, max: number) {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/clicktide_rate_limit_hit`, {
      method: "POST",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_bucket: bucket, p_window_seconds: windowSeconds, p_max: max }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return true;
    return (await r.json()) === true;
  } catch {
    return true;
  }
}

async function rest(path: string, init: RequestInit = {}) {
  const response = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(8000),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.message || data?.error || response.statusText);
  return data;
}

async function stripe(path: string, form?: URLSearchParams) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: form ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

// The plan a business is checking out with is recorded here, server-side, as
// clicktide.selected_plan. It is only a preference (shown in the back office and
// used to resume onboarding on another device). The real `plan` is written by
// stripe-webhook from the Stripe price once checkout completes — the database
// ignores `plan` and every billing column when they come from the browser
// (migration 20261126030000_protect_billing_columns).
async function recordSelectedPlan(userId: string, plan: string) {
  if (!serviceRoleKey || !userId || !plan) return;
  try {
    await fetch(`${supabaseUrl}/rest/v1/clicktide?user_id=eq.${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ selected_plan: plan }),
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    // Bookkeeping only — never block or fail a checkout because of it.
  }
}

// Stripe customer already linked to this business (by stripe-webhook) and whether this account,
// its login email or that customer ever had a subscription (migration 02_billing_subscription_state).
async function billingContext(userId: string, email: string) {
  const data = await rest("/rest/v1/rpc/clicktide_billing_checkout_context", {
    method: "POST",
    body: JSON.stringify({ p_user: userId, p_email: email || null }),
  });
  if (!data?.ok) throw new Error("No billing context");
  return { customerId: String(data.customer_id || ""), trialEligible: data.trial_eligible === true };
}

async function stripeHistory(customerId: string) {
  const r = await stripe(`subscriptions?customer=${encodeURIComponent(customerId)}&status=all&limit=100`);
  if (!r.ok) {
    if (r.data?.error?.code === "resource_missing") return { missing: true, live: false, hadSubscription: false };
    throw new Error(r.data?.error?.message || `Stripe subscription lookup failed (${r.status})`);
  }
  const subscriptions = Array.isArray(r.data?.data) ? r.data.data : [];
  return {
    missing: false,
    live: subscriptions.some((s: { status?: string }) => LIVE_STATUSES.includes(String(s?.status || ""))),
    hadSubscription: subscriptions.length > 0,
  };
}

async function portalUrl(customerId: string, origin: string) {
  const r = await stripe("billing_portal/sessions", new URLSearchParams({ customer: customerId, return_url: `${origin}/?billing=updated` }));
  return r.ok ? String(r.data?.url || "") : "";
}

// A subscription checkout this account completed in the last 24 h. Covers the gap before
// stripe-webhook links the Stripe customer to the business row, when billingContext still sees
// no history. Throws when Stripe can't be asked, so a trial is never granted by accident.
async function recentCompletedCheckout(userId: string) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rows = await rest(
    `/rest/v1/billing_checkout_sessions?user_id=eq.${userId}&mode=eq.subscription&created_at=gt.${encodeURIComponent(since)}&select=session_id&order=created_at.desc&limit=10`,
  );
  const ids = (Array.isArray(rows) ? rows : []).map((row) => String(row?.session_id || "")).filter((id) => /^cs_[A-Za-z0-9_]+$/.test(id));
  let completed = false;
  for (const id of ids) {
    const r = await stripe(`checkout/sessions/${id}?expand[]=subscription`);
    if (!r.ok) {
      if (r.data?.error?.code === "resource_missing") continue;
      throw new Error(r.data?.error?.message || `Stripe checkout lookup failed (${r.status})`);
    }
    if (r.data?.status !== "complete") continue;
    completed = true;
    const sub = r.data?.subscription;
    const status = sub && typeof sub === "object" ? String(sub.status || "") : "";
    // Not expanded (or not created yet): treat as live rather than open a second subscription.
    if (!status || LIVE_STATUSES.includes(status)) {
      return { completed, live: true, customerId: typeof r.data?.customer === "string" ? r.data.customer : "" };
    }
  }
  return { completed, live: false, customerId: "" };
}

// One open subscription checkout per account, so two tabs can't start two subscriptions (and two trials).
async function expireOpenCheckouts(userId: string) {
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const rows = await rest(
      `/rest/v1/billing_checkout_sessions?user_id=eq.${userId}&mode=eq.subscription&closed_at=is.null&created_at=gt.${encodeURIComponent(since)}&select=session_id&order=created_at.desc&limit=5`,
    );
    const open = (Array.isArray(rows) ? rows : []).map((row) => String(row?.session_id || "")).filter((id) => /^cs_[A-Za-z0-9_]+$/.test(id));
    for (const id of open) await stripe(`checkout/sessions/${id}/expire`, new URLSearchParams()).catch(() => null);
    if (open.length) {
      await rest(`/rest/v1/billing_checkout_sessions?user_id=eq.${userId}&closed_at=is.null`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ closed_at: new Date().toISOString() }),
      });
    }
  } catch (e) {
    console.warn("create-checkout-session: could not expire older checkouts", e);
  }
}

// One subscription checkout start per account at a time (migration 02: a lease that expires on
// its own after 15 s, released when this request ends). Throws when it can't be asked.
async function lockCheckout(userId: string) {
  return (await rest("/rest/v1/rpc/clicktide_billing_checkout_lock", {
    method: "POST",
    body: JSON.stringify({ p_user: userId, p_seconds: 15 }),
  })) === true;
}

async function unlockCheckout(userId: string) {
  try {
    await rest("/rest/v1/rpc/clicktide_billing_checkout_unlock", { method: "POST", body: JSON.stringify({ p_user: userId }) });
  } catch (e) {
    console.warn("create-checkout-session: could not release checkout lock (expires in 15 s)", e);
  }
}

async function rememberCheckout(sessionId: string, userId: string, trial: boolean) {
  if (!sessionId) return false;
  try {
    await rest("/rest/v1/billing_checkout_sessions", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ session_id: sessionId, user_id: userId, mode: "subscription", trial }),
    });
    return true;
  } catch (e) {
    console.warn("create-checkout-session: could not record checkout", e);
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!stripeSecretKey) return json({ error: "Stripe secret key is not configured" }, 500);
  if (!serviceRoleKey) return json({ error: "Server is not configured" }, 500);

  let body: CheckoutBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object") return json({ error: "Invalid JSON body" }, 400);

  const isWalletTopup = body.type === "wallet_topup";
  const isSubscription = !body.type || body.type === "subscription";
  if (!isWalletTopup && !isSubscription) return json({ error: "Invalid checkout type" }, 400);

  // Billing only ever attaches to the signed-in business: stripe-webhook links a checkout to the
  // user id set below and nothing else, so neither the account nor the email comes from the body.
  const user = await authedUser(req);
  if (!user) {
    return json({ error: isWalletTopup ? "Login is required for wallet top-ups" : "Login is required for checkout" }, 401);
  }
  if (body.user_id && String(body.user_id) !== user.id) {
    return json({ error: isWalletTopup ? "Not allowed to top up this wallet" : "Not allowed to start checkout for this account" }, 403);
  }
  if (!(await underLimit(`checkout:user:${user.id}`, 3600, 20)) || !(await underLimit(`checkout:ip:${clientIp(req)}`, 3600, 60))) {
    return json({ error: "Too many checkout attempts — please wait a few minutes and try again." }, 429);
  }

  // Shopify App Store rule 1.2: a business that came through Shopify (billed by Shopify, or
  // with an active Shopify connection) pays everything through Shopify, so no Stripe checkout:
  // plan changes go through Shopify (1.2.3) and Stripe-funded wallet top-ups are off for it.
  // Fails closed like the rest of this function.
  try {
    const [biz, shop] = await Promise.all([
      rest(`/rest/v1/clicktide?user_id=eq.${encodeURIComponent(user.id)}&select=billing_provider&limit=1`),
      rest(`/rest/v1/platform_connections?user_id=eq.${encodeURIComponent(user.id)}&platform=eq.shopify&is_active=eq.true&select=id&limit=1`),
    ]);
    const shopifyBilled = Array.isArray(biz) && biz[0]?.billing_provider === "shopify";
    const shopifyConnected = Array.isArray(shop) && shop.length > 0;
    if (shopifyBilled || shopifyConnected) {
      return json({
        code: "shopify_billing",
        error: isWalletTopup
          ? "Gift-wallet top-ups aren't available for Shopify stores yet."
          : "Shopify stores choose and change their Clicktide plan in Shopify.",
      }, 409);
    }
  } catch (e) {
    console.error("create-checkout-session: shopify billing check", e);
    return json({ error: UNAVAILABLE }, 503);
  }

  const subscriptionPlan = isSubscription ? normalizePlan(body.plan) : "";
  if (isSubscription && !subscriptionPlan) {
    return json({ error: `Unknown or missing plan: ${String(body.plan ?? "(none)").slice(0, 40)}` }, 400);
  }

  const rawOrigin = req.headers.get("origin") || "";
  const origin = allowedRedirect(rawOrigin + "/") ? rawOrigin : "https://goclicktide.com";
  const successUrl = safeUrl(body.success_url) || (isWalletTopup
    ? `${origin}/?session=wallet_success`
    : `${origin}/?session=success&plan=${encodeURIComponent(subscriptionPlan)}`);
  const cancelUrl = safeUrl(body.cancel_url) || `${origin}/?session=cancelled`;
  const businessName = String(body.business_name || "").slice(0, 200);

  const form = new URLSearchParams();
  form.set("success_url", successUrl);
  form.set("cancel_url", cancelUrl);
  form.set("consent_collection[terms_of_service]", "required");
  form.set(
    "custom_text[terms_of_service_acceptance][message]",
    "I agree to Clicktide's Terms, Privacy Policy, Billing Policy, and authorize Clicktide to provide messaging, customer retention, platform connection, and gift fulfillment services for my business.",
  );
  form.set("client_reference_id", user.id);

  let customerId = "";
  let trial = false;
  let locked = false;

  try {
    if (isWalletTopup) {
      const amount = Number(body.amount || 0);
      if (!Number.isFinite(amount) || amount < 25 || amount > 5000) {
        return json({ error: "Wallet top-up amount must be between $25 and $5,000" }, 400);
      }

      const cents = Math.round(amount * 100);
      form.set("mode", "payment");
      form.set("line_items[0][price_data][currency]", "usd");
      form.set("line_items[0][price_data][product_data][name]", "Clicktide gift wallet top-up");
      form.set("line_items[0][price_data][unit_amount]", String(cents));
      form.set("line_items[0][quantity]", "1");
      form.set("metadata[type]", "wallet_topup");
      form.set("metadata[user_id]", user.id);
      form.set("metadata[business_name]", businessName);
      form.set("metadata[amount]", amount.toFixed(2));
      form.set("payment_intent_data[metadata][type]", "wallet_topup");
      form.set("payment_intent_data[metadata][user_id]", user.id);
      form.set("payment_intent_data[metadata][business_name]", businessName);
      form.set("payment_intent_data[metadata][amount]", amount.toFixed(2));
    } else {
      // Two parallel requests (double click, two tabs) would otherwise both see no history and both
      // create a trial session. Fails closed like the trial lookups below.
      try {
        locked = await lockCheckout(user.id);
      } catch (e) {
        console.error("create-checkout-session: checkout lock", e);
        return json({ error: UNAVAILABLE }, 503);
      }
      if (!locked) {
        return json({ error: "A checkout is already being started for this account — please wait a few seconds and try again." }, 429);
      }

      let context;
      try {
        context = await billingContext(user.id, user.email);
      } catch (e) {
        console.error("create-checkout-session: billing context", e);
        return json({ error: UNAVAILABLE }, 503);
      }
      customerId = context.customerId;
      trial = context.trialEligible;

      if (customerId) {
        let history;
        try {
          history = await stripeHistory(customerId);
        } catch (e) {
          console.error("create-checkout-session: Stripe history", e);
          return json({ error: UNAVAILABLE }, 503);
        }
        if (history.missing) {
          customerId = "";
        } else if (history.live) {
          // Already subscribed: switching plans happens in the Customer Portal, not with a second subscription.
          const url = await portalUrl(customerId, origin);
          if (!url) return json({ error: "This account already has a subscription — use Manage billing to change your plan." }, 409);
          return json({ url, portal: true, plan: subscriptionPlan, price_id: planPrices[subscriptionPlan] });
        } else if (history.hadSubscription) {
          trial = false;
        }
      }

      let recent;
      try {
        recent = await recentCompletedCheckout(user.id);
      } catch (e) {
        console.error("create-checkout-session: recent checkouts", e);
        return json({ error: UNAVAILABLE }, 503);
      }
      if (recent.live) {
        // Completed moments ago (stripe-webhook may not have linked it yet): manage that subscription.
        const url = recent.customerId ? await portalUrl(recent.customerId, origin) : "";
        if (url) return json({ url, portal: true, plan: subscriptionPlan, price_id: planPrices[subscriptionPlan] });
        return json({ error: "Your subscription is being set up — refresh in a minute, then use Manage billing to make changes." }, 409);
      }
      if (recent.completed) trial = false;

      // Never substitute a plan silently — a $49 buyer must not get a $149 checkout.
      const plan = subscriptionPlan;
      const priceId = planPrices[plan];
      const campaignMode = body.campaign_mode === "skip" ? "skip" : "setup";

      form.set("mode", "subscription");
      form.set("allow_promotion_codes", "true");
      form.set("line_items[0][price]", priceId);
      form.set("line_items[0][quantity]", "1");
      if (trial) form.set("subscription_data[trial_period_days]", TRIAL_DAYS);
      form.set("metadata[type]", "subscription");
      form.set("metadata[plan]", plan);
      form.set("metadata[campaign_mode]", campaignMode);
      form.set("metadata[business_name]", businessName);
      form.set("metadata[user_id]", user.id);
      form.set("subscription_data[metadata][plan]", plan);
      form.set("subscription_data[metadata][campaign_mode]", campaignMode);
      form.set("subscription_data[metadata][business_name]", businessName);
      form.set("subscription_data[metadata][user_id]", user.id);

      await expireOpenCheckouts(user.id);
    }

    if (customerId) form.set("customer", customerId);
    else if (user.email) form.set("customer_email", user.email);

    let created = await stripe("checkout/sessions", form);
    if (!created.ok && customerId && created.data?.error?.param === "customer") {
      // The linked Stripe customer no longer exists; start this checkout from the login email.
      form.delete("customer");
      if (user.email) form.set("customer_email", user.email);
      created = await stripe("checkout/sessions", form);
    }
    if (!created.ok) {
      return json({ error: created.data?.error?.message || "Stripe checkout failed" }, created.status);
    }
    const data = created.data;

    if (isSubscription) {
      // Unrecorded, the next request couldn't see this session: keep the lock until it expires.
      if (!(await rememberCheckout(String(data.id || ""), user.id, trial))) locked = false;
      await recordSelectedPlan(user.id, subscriptionPlan);
    }

    return json({
      url: data.url,
      id: data.id,
      plan: isSubscription ? subscriptionPlan : undefined,
      price_id: isSubscription ? planPrices[subscriptionPlan] : undefined,
      trial: isSubscription ? trial : undefined,
    });
  } catch (e) {
    console.error("create-checkout-session:", e);
    return json({ error: UNAVAILABLE }, 502);
  } finally {
    // After rememberCheckout, so the next request sees this session (and expires or reuses it).
    if (locked) await unlockCheckout(user.id);
  }
});
