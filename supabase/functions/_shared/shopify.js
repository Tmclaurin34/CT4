// Shared Shopify helpers (plain JS: Deno imports it, the jsc test rig loads it).
// Tests: supabase/functions/_shared/run_shopify_tests.sh

export const SHOPIFY_API_VERSION = "2026-10";
export const SHOPIFY_SCOPES = "read_orders,read_customers";
export const LIVE_STATUSES = ["active", "trialing", "past_due"];

export function isShopDomain(s) {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(String(s || ""));
}

export function bytesToBase64(bytes) {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "", i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += abc[(n >> 18) & 63] + abc[(n >> 12) & 63] + abc[(n >> 6) & 63] + abc[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8);
    out += abc[(n >> 18) & 63] + abc[(n >> 12) & 63] + (i + 1 < bytes.length ? abc[(n >> 6) & 63] : "=") + "=";
  }
  return out;
}

export function bytesToHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
  return s;
}

// Constant-time string compare (length leak only).
export function safeEqual(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function utf8(s) { return new TextEncoder().encode(s); }

async function hmacBytes(subtle, secret, message) {
  const key = await subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", key, typeof message === "string" ? utf8(message) : message));
}

// Webhooks: base64(HMAC-SHA256(raw body, client secret)) == X-Shopify-Hmac-Sha256.
export async function verifyWebhookHmac(rawBody, header, secret, subtle) {
  if (!secret || !header) return false;
  return safeEqual(bytesToBase64(await hmacBytes(subtle, secret, rawBody)), String(header).trim());
}

// OAuth / app-URL requests: hex HMAC of the sorted query string without hmac/signature.
export function queryHmacMessage(params) {
  const parts = [];
  for (const [k, v] of params) if (k !== "hmac" && k !== "signature") parts.push(`${k}=${v}`);
  return parts.sort().join("&");
}
export async function verifyQueryHmac(params, secret, subtle) {
  const list = Array.from(params);
  const h = (list.find(([k]) => k === "hmac") || [])[1];
  if (!secret || !h) return false;
  return safeEqual(bytesToHex(await hmacBytes(subtle, secret, queryHmacMessage(list))), String(h).toLowerCase());
}

// Shopify request timestamps older than a day are replays.
export function freshTimestamp(ts, now) {
  const t = Number(ts);
  return Number.isFinite(t) && Math.abs((now || Date.now()) / 1000 - t) < 86400;
}

// ---- billing: Shopify App Pricing subscription -> Clicktide entitlement ----
const PLAN_PRICES = { 79: "Local", 199: "Growth", 449: "Scale" };

export function planFromSubscription(sub) {
  const name = String((sub && sub.name) || "").toLowerCase();
  for (const p of ["Local", "Growth", "Scale"]) if (name.indexOf(p.toLowerCase()) >= 0) return p;
  const items = (sub && sub.lineItems) || [];
  for (const li of items) {
    const amt = Math.round(Number(li && li.plan && li.plan.pricingDetails && li.plan.pricingDetails.price && li.plan.pricingDetails.price.amount));
    if (PLAN_PRICES[amt]) return PLAN_PRICES[amt];
  }
  return "";
}

// subs: currentAppInstallation.activeSubscriptions. opts: { now, devStore, allowTest }.
// Returns the Stripe-style status the paywall reads ('trialing'/'active' = access).
export function entitlementFromSubscriptions(subs, opts) {
  const now = (opts && opts.now) || Date.now();
  const list = (Array.isArray(subs) ? subs : []).filter(Boolean);
  // A test charge only unlocks Clicktide on a development store (app review), never a real shop.
  const usable = list.filter((s) => !s.test || (opts && (opts.devStore || opts.allowTest)));
  const rank = { ACTIVE: 0, FROZEN: 1, PENDING: 2 };
  usable.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
  const s = usable[0];
  if (!s) return { status: "canceled", raw_status: list.length ? "TEST_IGNORED" : "NONE", plan: null, period_end: null, sub_id: null };
  const plan = planFromSubscription(s) || null;
  let status;
  switch (String(s.status)) {
    case "ACTIVE": {
      const trialEnd = Date.parse(s.createdAt) + (Number(s.trialDays) || 0) * 86400000;
      status = Number.isFinite(trialEnd) && trialEnd > now ? "trialing" : "active";
      break;
    }
    case "FROZEN": status = "unpaid"; break;       // store's Shopify bill unpaid: paywalled
    case "PENDING": status = "incomplete"; break;  // merchant hasn't approved yet
    default: status = "canceled";                  // CANCELLED / DECLINED / EXPIRED
  }
  if (!plan && (status === "active" || status === "trialing")) status = "incomplete"; // unknown plan: no access
  return { status, raw_status: String(s.status), plan, period_end: s.currentPeriodEnd || null, sub_id: s.id || null };
}

export const SUBSCRIPTION_QUERY = `query ClicktideBilling {
  shop { id name myshopifyDomain plan { partnerDevelopment } }
  currentAppInstallation {
    activeSubscriptions {
      id name status test trialDays createdAt currentPeriodEnd
      lineItems { plan { pricingDetails { ... on AppRecurringPricing { price { amount currencyCode } interval } } } }
    }
  }
}`;

// Shopify App Pricing's hosted plan page for this shop.
export function planSelectionUrl(shopDomain, appHandle) {
  const store = String(shopDomain || "").replace(/\.myshopify\.com$/, "");
  return `https://admin.shopify.com/store/${encodeURIComponent(store)}/charges/${encodeURIComponent(appHandle)}/pricing_plans`;
}

// Fields of a compliance payload we need; everything else is dropped before storage.
export function compliancePayload(topic, body) {
  const b = body || {};
  const cu = b.customer || {};
  if (topic === "shop/redact") return { shop_id: b.shop_id || null, shop_domain: b.shop_domain || null };
  return {
    shop_id: b.shop_id || null, shop_domain: b.shop_domain || null,
    customer: { id: cu.id || null, email: cu.email || null, phone: cu.phone || null },
    orders: (b.orders_to_redact || b.orders_requested || []).map(String).slice(0, 5000),
    data_request_id: (b.data_request && b.data_request.id) || null,
  };
}

export const HANDLED_TOPICS = ["customers/data_request", "customers/redact", "shop/redact", "app/uninstalled", "app_subscriptions/update"];

// ---- expiring offline access tokens ----
// Shopify no longer accepts non-expiring offline tokens on the Admin API. Install asks
// for an expiring one (expiring=1); it is renewed with its refresh token (which rotates),
// and a legacy non-expiring token is migrated once via token exchange.
export const TOKEN_REFRESH_BEFORE_MS = 5 * 60 * 1000;
export const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
export const OFFLINE_TOKEN_TYPE = "urn:shopify:params:oauth:token-type:offline-access-token";

// Fields to store from an access_token response (code grant, refresh or migration).
export function tokenFields(d, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const exp = Number(d && d.expires_in);
  const rexp = Number(d && d.refresh_token_expires_in);
  return {
    access_token: String((d && d.access_token) || ""),
    refresh_token: (d && d.refresh_token) ? String(d.refresh_token) : null,
    token_expires_at: Number.isFinite(exp) && exp > 0 ? new Date(t + exp * 1000).toISOString() : null,
    refresh_expires_at: Number.isFinite(rexp) && rexp > 0 ? new Date(t + rexp * 1000).toISOString() : null,
  };
}

// "refresh" | "migrate" | "ok" for a stored connection.
export function tokenAction(conn, now, force) {
  const t = Number.isFinite(now) ? now : Date.now();
  if (!conn || !conn.access_token) return "ok";
  if (!conn.refresh_token) return "migrate";
  const exp = Date.parse(conn.token_expires_at || "");
  if (force || !Number.isFinite(exp) || exp < t + TOKEN_REFRESH_BEFORE_MS) return "refresh";
  return "ok";
}

export function refreshBody(clientId, clientSecret, conn) {
  return { client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: conn.refresh_token };
}
export function migrateBody(clientId, clientSecret, conn) {
  return { client_id: clientId, client_secret: clientSecret, grant_type: TOKEN_EXCHANGE, subject_token: conn.access_token,
           subject_token_type: OFFLINE_TOKEN_TYPE, requested_token_type: OFFLINE_TOKEN_TYPE, expiring: "1" };
}
