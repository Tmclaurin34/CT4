const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type CheckoutBody = {
  type?: string;
  plan?: string;
  amount?: number;
  email?: string;
  business_name?: string;
  user_id?: string;
  success_url?: string;
  cancel_url?: string;
};

const planPrices: Record<string, string | undefined> = {
  Local: Deno.env.get("LOCAL_PRICE_ID") || "price_1ThaasGWBWEX8wHssSYEbwEl",
  Growth: Deno.env.get("GROWTH_PRICE_ID") || "price_1TfFM4GWBWEX8wHsd0xaDyaA",
  Scale: Deno.env.get("SCALE_PRICE_ID") || "price_1TfFMgGWBWEX8wHsRS3XgPtb",
};

// 30-day free trial on every plan — card collected up front, first charge on day 30.
const TRIAL_DAYS = "30";

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

async function authedUserId(req: Request) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const authorization = req.headers.get("authorization") || "";
  if (!serviceRoleKey || !authorization.toLowerCase().startsWith("bearer ")) return "";

  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: authorization,
    },
  });
  if (!response.ok) return "";
  const user = await response.json();
  return String(user?.id || "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeSecretKey) return json({ error: "Stripe secret key is not configured" }, 500);

  let body: CheckoutBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const rawOrigin = req.headers.get("origin") || "";
  const origin = allowedRedirect(rawOrigin + "/") ? rawOrigin : "https://goclicktide.com";
  const isWalletTopup = body.type === "wallet_topup";
  const successUrl = safeUrl(body.success_url) || (isWalletTopup
    ? `${origin}/?session=wallet_success`
    : `${origin}/?session=success&plan=${encodeURIComponent(body.plan || "Growth")}`);
  const cancelUrl = safeUrl(body.cancel_url) || `${origin}/?session=cancelled`;

  const form = new URLSearchParams();
  form.set("success_url", successUrl);
  form.set("cancel_url", cancelUrl);
  form.set("allow_promotion_codes", "true");
  form.set("consent_collection[terms_of_service]", "required");
  form.set(
    "custom_text[terms_of_service_acceptance][message]",
    "I agree to Clicktide's Terms, Privacy Policy, Billing Policy, and authorize Clicktide to provide messaging, customer retention, platform connection, and gift fulfillment services for my business.",
  );
  if (body.user_id) form.set("client_reference_id", body.user_id);

  if (isWalletTopup) {
    const amount = Number(body.amount || 0);
    if (!body.user_id) return json({ error: "User id is required for wallet top-ups" }, 400);
    const authUserId = await authedUserId(req);
    if (!authUserId) return json({ error: "Login is required for wallet top-ups" }, 401);
    if (authUserId !== body.user_id) return json({ error: "Not allowed to top up this wallet" }, 403);
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
    form.set("metadata[user_id]", body.user_id);
    form.set("metadata[business_name]", body.business_name || "");
    form.set("metadata[amount]", amount.toFixed(2));
    form.set("payment_intent_data[metadata][type]", "wallet_topup");
    form.set("payment_intent_data[metadata][user_id]", body.user_id);
    form.set("payment_intent_data[metadata][business_name]", body.business_name || "");
    form.set("payment_intent_data[metadata][amount]", amount.toFixed(2));
  } else {
    const plan = body.plan && planPrices[body.plan] ? body.plan : "Growth";
    const priceId = planPrices[plan];
    if (!priceId) return json({ error: "Stripe price is not configured" }, 500);

    form.set("mode", "subscription");
    form.set("line_items[0][price]", priceId);
    form.set("line_items[0][quantity]", "1");
    form.set("subscription_data[trial_period_days]", TRIAL_DAYS);
    form.set("metadata[type]", "subscription");
    form.set("metadata[plan]", plan);
    form.set("metadata[business_name]", body.business_name || "");
    form.set("metadata[user_id]", body.user_id || "");
    form.set("subscription_data[metadata][plan]", plan);
    form.set("subscription_data[metadata][business_name]", body.business_name || "");
    form.set("subscription_data[metadata][user_id]", body.user_id || "");
  }

  if (body.email) form.set("customer_email", body.email);

  const stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });

  const data = await stripeResponse.json();
  if (!stripeResponse.ok) {
    return json({ error: data?.error?.message || "Stripe checkout failed" }, stripeResponse.status);
  }

  return json({ url: data.url, id: data.id });
});
