// Starts a POS / Stripe connection for the signed-in business (contract C3).
// POST {platform:"square"|"shopify"|"clover"|"stripe", shop_domain?, flow:"app"|"audit"}
// with Authorization: Bearer <owner JWT>  ->  {url}  (the provider's consent page).
// The OAuth state is made here, bound to the verified user, single use, 10 minutes.
// The provider callback parks the token in oauth_pending and hands the browser a
// one-time nonce; only oauth-confirm, called by this same user, activates it.

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const FN = `${supabaseUrl}/functions/v1`;
const STATE_TTL_MS = 10 * 60 * 1000;
const PLATFORMS = ["square", "shopify", "clover", "stripe"];
const LABEL: Record<string, string> = { square: "Square", shopify: "Shopify", clover: "Clover", stripe: "Stripe" };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const t = await r.text();
  const data = t ? JSON.parse(t) : null;
  if (!r.ok) throw new Error(data?.message || data?.error || r.statusText);
  return data;
}

async function authedUserId(req: Request) {
  const authorization = req.headers.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return "";
  const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceRoleKey, Authorization: authorization },
  });
  if (!r.ok) return "";
  const user = await r.json();
  return String(user?.id || "");
}

// Fails open: connecting a POS is an owner-facing flow and costs nothing.
async function underLimit(bucket: string, windowSeconds: number, max: number) {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/clicktide_rate_limit_hit`, {
      method: "POST",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_bucket: bucket, p_window_seconds: windowSeconds, p_max: max }),
    });
    if (!r.ok) return true;
    return (await r.json()) === true;
  } catch {
    return true;
  }
}

function randomHex(bytes: number) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeShop(v: unknown) {
  const d = String(v || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(d) ? d : "";
}

// Redirect URIs and scopes match what the live site sends today, so the provider app
// registrations need no change. Stripe asks for read_only: sync only reads charges.
function authorizeUrl(platform: string, state: string, shop: string): string {
  if (platform === "square") {
    const clientId = Deno.env.get("SQUARE_APP_ID") ?? "";
    if (!clientId) return "";
    return "https://connect.squareup.com/oauth2/authorize?" + new URLSearchParams({
      client_id: clientId,
      scope: "MERCHANT_PROFILE_READ ORDERS_READ PAYMENTS_READ CUSTOMERS_READ",
      redirect_uri: `${FN}/square-oauth-callback`,
      state,
      session: "false",
    });
  }
  if (platform === "shopify") {
    const clientId = Deno.env.get("SHOPIFY_CLIENT_ID") ?? "";
    if (!clientId || !shop) return "";
    return `https://${shop}/admin/oauth/authorize?` + new URLSearchParams({
      client_id: clientId,
      scope: "read_orders,read_customers",
      redirect_uri: `${FN}/shopify-oauth-callback`,
      state,
    });
  }
  if (platform === "clover") {
    const clientId = Deno.env.get("CLOVER_APP_ID") ?? "";
    if (!clientId) return "";
    return "https://www.clover.com/oauth/authorize?" + new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${FN}/clover-oauth-callback`,
      state,
    });
  }
  const clientId = Deno.env.get("STRIPE_CONNECT_CLIENT_ID") ?? "";
  if (!clientId) return "";
  return "https://connect.stripe.com/oauth/authorize?" + new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: "read_only",
    redirect_uri: `${FN}/stripe-oauth-callback`,
    state,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!serviceRoleKey) return json({ error: "Server is not configured" }, 500);

  const userId = await authedUserId(req);
  if (!userId) return json({ error: "Please sign in first." }, 401);

  let body: { platform?: unknown; shop_domain?: unknown; flow?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }

  const platform = String(body?.platform || "");
  if (!PLATFORMS.includes(platform)) return json({ error: "That platform can't be connected this way." }, 400);
  const flow = body?.flow == null || body.flow === "" ? "app" : String(body.flow);
  if (flow !== "app" && flow !== "audit") return json({ error: "Unknown flow" }, 400);
  const shop = platform === "shopify" ? normalizeShop(body?.shop_domain) : "";
  if (platform === "shopify" && !shop) return json({ error: "Enter your store's .myshopify.com domain." }, 400);

  if (!(await underLimit(`oauth-start:user:${userId}`, 600, 20))) {
    return json({ error: "Too many connection attempts — wait a few minutes and try again." }, 429);
  }

  const state = randomHex(32);
  const url = authorizeUrl(platform, state, shop);
  if (!url) return json({ error: `${LABEL[platform]} isn't set up on the server yet.` }, 503);

  try {
    await rest("/rest/v1/oauth_states", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        state,
        user_id: userId,
        platform,
        metadata: { flow, shop_domain: shop || null, server_created: true },
        expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
      }),
    });
  } catch (e) {
    console.error("oauth-start: could not store state", e);
    return json({ error: "Could not start the connection. Please try again." }, 500);
  }

  return json({ url });
});
