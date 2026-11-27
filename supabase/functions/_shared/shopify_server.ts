// Server-side Shopify helpers shared by shopify-webhooks, shopify-app and
// shopify-oauth-callback. Pure logic lives in ./shopify.js (unit-tested).
import { entitlementFromSubscriptions, isTestShop, migrateBody, refreshBody, SHOPIFY_API_VERSION, SUBSCRIPTION_QUERY, tokenAction, tokenFields, usageEventFor } from "./shopify.js";

export const SUPA = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
export const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// Shopify billing stays OFF until the owner flips it (Supabase secret
// SHOPIFY_BILLING_ENABLED=true). While off, Clicktide reads the subscription
// and logs what it would do, but never writes an entitlement.
export const BILLING_ENABLED = (Deno.env.get("SHOPIFY_BILLING_ENABLED") ?? "") === "true";
export const APP_HANDLE = Deno.env.get("SHOPIFY_APP_HANDLE") ?? "clicktide-3";

export async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPA}${path}`, {
    ...init,
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const t = await r.text();
  const data = t ? JSON.parse(t) : null;
  if (!r.ok) throw new Error(data?.message || data?.error || r.statusText);
  return data;
}

export async function rpc(name: string, args: Record<string, unknown>) {
  return await rest(`/rest/v1/rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
}

const CLIENT_ID = Deno.env.get("SHOPIFY_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("SHOPIFY_CLIENT_SECRET") ?? "";

export type ShopConn = { id: string; shop_domain?: string | null; access_token: string; refresh_token?: string | null; token_expires_at?: string | null; raw_response?: Record<string, unknown> | null };

// Keep a Shopify connection's offline token usable (expiring tokens, see shopify.js).
// Mutates conn and saves the new token. "auth" = the store must reinstall/reconnect.
export async function freshShopifyToken(conn: ShopConn, force = false): Promise<"ok" | "auth" | "transient"> {
  const action = tokenAction(conn, Date.now(), force);
  if (action === "ok") return "ok";
  const shop = String(conn.shop_domain || "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) || !CLIENT_ID || !CLIENT_SECRET) return "auth";
  const body = action === "migrate" ? migrateBody(CLIENT_ID, CLIENT_SECRET, conn) : refreshBody(CLIENT_ID, CLIENT_SECRET, conn);
  let r: Response;
  try {
    r = await fetch(`https://${shop}/admin/oauth/access_token`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
  } catch { return "transient"; }
  const d = await r.json().catch(() => ({}));
  const f = tokenFields(d, Date.now());
  if (!r.ok || !f.access_token) {
    console.error(`shopify token ${action} failed`, shop, r.status, JSON.stringify(d).slice(0, 200));
    return r.status >= 400 && r.status < 500 ? "auth" : "transient";
  }
  conn.access_token = f.access_token;
  conn.refresh_token = f.refresh_token || conn.refresh_token || null;
  conn.token_expires_at = f.token_expires_at;
  const raw = { ...(conn.raw_response || {}), refresh_expires_at: f.refresh_expires_at };
  conn.raw_response = raw;
  try {
    await rest(`/rest/v1/platform_connections?id=eq.${conn.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ access_token: conn.access_token, refresh_token: conn.refresh_token, token_expires_at: conn.token_expires_at, raw_response: raw, updated_at: new Date().toISOString() }),
    });
  } catch (e) { console.error("saving refreshed shopify token failed", conn.id, e); }
  return "ok";
}

export async function adminGraphql(shop: string, token: string, query: string, variables: Record<string, unknown> = {}) {
  const r = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body?.data) throw new Error(`shopify graphql ${r.status} ${JSON.stringify(body?.errors || "").slice(0, 200)}`);
  return body.data;
}

export async function sha256Hex(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function legacyId(gid: unknown) {
  const m = String(gid || "").match(/(\d+)$/);
  return m ? m[1] : String(gid || "");
}

// Read the shop's current App Pricing subscription and (when billing is on)
// apply it as the business's entitlement. Shopify App Pricing sends no
// subscription webhooks (since 2026-04-28), so this runs on app open, after
// install, after plan selection, and nightly.
export async function reconcileBilling(shop: string) {
  const conns = await rest(`/rest/v1/platform_connections?platform=eq.shopify&shop_domain=ilike.${encodeURIComponent(shop)}&is_active=eq.true&access_token=neq.&select=id,shop_domain,access_token,refresh_token,token_expires_at,raw_response&order=updated_at.desc&limit=1`);
  const conn = Array.isArray(conns) && conns[0] ? conns[0] as ShopConn : null;
  if (conn && await freshShopifyToken(conn) === "auth") throw new Error(`shopify token for ${shop} needs reinstall`);
  const token = conn?.access_token;
  let ent;
  let devStore = true; // unknown counts as a development store: usage billing stays off
  if (!token) ent = { status: "canceled", raw_status: "UNINSTALLED", plan: null, period_end: null, sub_id: null, test: false };
  else {
    const data = await adminGraphql(shop, token, SUBSCRIPTION_QUERY);
    devStore = isTestShop(data?.shop?.plan);
    ent = entitlementFromSubscriptions(data?.currentAppInstallation?.activeSubscriptions || [], { devStore });
  }
  if (!BILLING_ENABLED) {
    console.log(`shopify billing (dry run, flag off) ${shop}: ${JSON.stringify(ent)}`);
    return { dry_run: true, entitlement: ent };
  }
  const applied = await rpc("clicktide_shopify_apply_entitlement", {
    p_shop: shop, p_plan: ent.plan, p_status: ent.status, p_period_end: ent.period_end, p_sub_id: ent.sub_id, p_raw_status: ent.raw_status,
  });
  // A website-first business that just subscribed through Shopify: stop its Stripe plan at the
  // end of the period it already paid for, so it never pays twice (idempotent per subscription).
  // (apply_entitlement queues them in shopify_stripe_switch; processStripeSwitches retries.)
  if (((applied as { stripe_cancel?: unknown[] })?.stripe_cancel || []).length) await processStripeSwitches();
  // Usage-billing limits (cycle, plan limit, test/dev). A test charge or development store never
  // gets usage billing; an unknown period end leaves the cycle unknown, so usage is refused.
  let usage: unknown = null;
  try {
    usage = await rpc("clicktide_shopify_usage_sync", {
      p_shop: shop, p_plan: ent.plan, p_period_end: ent.period_end,
      p_test_or_dev: !!(ent as { test?: boolean }).test || devStore,
      p_trialing: ent.status !== "active" && ent.status !== "past_due",
      p_capped: (ent as { capped_amount?: number | null }).capped_amount ?? null,
      p_balance_used: (ent as { balance_used?: number | null }).balance_used ?? null,
    });
  } catch (e) { console.error("shopify usage sync failed", shop, e); }
  return { dry_run: false, entitlement: ent, applied, usage };
}

const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
export async function cancelStripeAtPeriodEnd(subId: string): Promise<string> {
  if (!/^sub_[A-Za-z0-9_]+$/.test(String(subId || ""))) return "skipped: not a Stripe subscription id";
  if (!STRIPE_KEY) return "skipped: no STRIPE_SECRET_KEY";
  try {
    const r = await fetch(`https://api.stripe.com/v1/subscriptions/${subId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${STRIPE_KEY}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": `ct-shopify-switch-${subId}` },
      body: "cancel_at_period_end=true",
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok && !/canceled/i.test(String(d?.error?.message || ""))) {
      console.error("stripe cancel_at_period_end failed", subId, r.status, JSON.stringify(d?.error || d).slice(0, 200));
      return `failed ${r.status} ${String(d?.error?.code || "")}`.trim();
    }
    // Done only once Stripe itself says it won't bill again: read it back (a 404 is not proof;
    // it may be the wrong Stripe account or key).
    const g = await fetch(`https://api.stripe.com/v1/subscriptions/${subId}`, { headers: { Authorization: `Bearer ${STRIPE_KEY}` } });
    const sub = await g.json().catch(() => ({}));
    if (g.ok && (sub?.status === "canceled" || sub?.cancel_at_period_end === true)) {
      return `ok (${sub.status}${sub.cancel_at_period_end ? `, ends ${sub.cancel_at ?? sub.current_period_end ?? "?"}` : ""})`;
    }
    return `failed: not confirmed (${g.status} ${String(sub?.status || sub?.error?.code || "")})`;
  } catch (e) { return `failed ${e instanceof Error ? e.message : String(e)}`; }
}

// Every queued Stripe subscription not yet confirmed stopped (runs after a switch and on each
// 10-minute usage job, so a Stripe outage is retried rather than leaving a double charge).
export async function processStripeSwitches() {
  const out = { pending: 0, done: 0, failed: 0, stuck: [] as Array<{ user_id: string; stripe_subscription_id: string; attempts: number; last: string }> };
  const rows = await rest("/rest/v1/shopify_stripe_switch?done_at=is.null&select=stripe_subscription_id,user_id,attempts&order=requested_at&limit=50") as Array<{ stripe_subscription_id: string; user_id: string; attempts: number }>;
  out.pending = (rows || []).length;
  for (const r of rows || []) {
    const res = await cancelStripeAtPeriodEnd(r.stripe_subscription_id);
    const ok = res.startsWith("ok");
    console.log(`shopify billing: ${r.user_id} switched from Stripe; cancel ${r.stripe_subscription_id} at period end -> ${res}`);
    await rest(`/rest/v1/shopify_stripe_switch?stripe_subscription_id=eq.${encodeURIComponent(r.stripe_subscription_id)}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ attempts: (r.attempts || 0) + 1, last_result: res.slice(0, 300), ...(ok ? { done_at: new Date().toISOString() } : {}) }),
    }).catch((e) => console.error("saving stripe switch result failed", e));
    if (ok) out.done++;
    else {
      out.failed++;
      // reported to support by shopify-webhooks (usage job), rate-limited
      if ((r.attempts || 0) + 1 >= 5) out.stuck.push({ user_id: r.user_id, stripe_subscription_id: r.stripe_subscription_id, attempts: (r.attempts || 0) + 1, last: res.slice(0, 200) });
    }
  }
  return out;
}

// ---- usage billing: report Shopify-billed wallet rows to the App Events API ----
// https://shopify.dev/docs/api/app-events. App-level token (client credentials, 60 minutes),
// one event per request, idempotency key = wallet row id (Shopify enforces it permanently for
// billing events). A 202 means accepted; billing validation results appear only in the Dev
// Dashboard logs. Failed rows stay queued and are retried (clicktide_shopify_usage_pending
// backs each failure off, up to once every 6 hours; the overdue alert emails support).
const APP_EVENTS_URL = "https://api.shopify.com/app/2026-10/events";
let appEventsToken = { tok: "", exp: 0 };
async function appEventsAuth(force = false) {
  if (!force && appEventsToken.tok && Date.now() < appEventsToken.exp) return appEventsToken.tok;
  const r = await fetch("https://api.shopify.com/auth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "Clicktide/1.0 (+https://goclicktide.com)" },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "client_credentials" }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d?.access_token) throw new Error(`app events auth ${r.status}`);
  appEventsToken = { tok: String(d.access_token), exp: Date.now() + 50 * 60 * 1000 };
  return appEventsToken.tok;
}

export async function reportUsage(limit = 200) {
  // One reporter at a time: the nightly run and the 10-minute run can overlap.
  const holder = crypto.randomUUID();
  if (await rpc("clicktide_shopify_usage_lease", { p_holder: holder, p_seconds: 600 }) !== true) return { skipped: "another run holds the lease" };
  let ok = false;
  try { const out = await reportUsageLeased(limit); ok = true; return out; }
  finally {
    await rpc("clicktide_shopify_usage_release", { p_holder: holder, p_ok: ok }).catch((e) => console.error("usage lease release failed", e));
  }
}

async function reportUsageLeased(limit: number) {
  // Keep limits fresh (the gate refuses anything synced more than 3h ago, and App Pricing sends
  // no subscription webhooks, so a downgrade/cancel is only seen here): re-read the subscription
  // of any Shopify-billed business whose limits are missing or older than 1 hour.
  if (BILLING_ENABLED) {
    try {
      const billed = await rest("/rest/v1/clicktide?billing_provider=eq.shopify&select=user_id,shopify_shop_domain&limit=500") as Array<{ user_id: string; shopify_shop_domain: string | null }>;
      const since = encodeURIComponent(new Date(Date.now() - 3600e3).toISOString());
      const fresh = await rest(`/rest/v1/shopify_usage_limits?synced_at=gt.${since}&select=user_id&limit=1000`) as Array<{ user_id: string }>;
      const ok = new Set((fresh || []).map((x) => x.user_id));
      for (const b of billed || []) {
        if (ok.has(b.user_id) || !b.shopify_shop_domain) continue;
        try { await reconcileBilling(b.shopify_shop_domain); } catch (e) { console.error("usage limits refresh failed", b.shopify_shop_domain, e); }
      }
    } catch (e) { console.error("usage limits refresh failed", e); }
  }
  let stripeSwitch: unknown = null;
  try { stripeSwitch = await processStripeSwitches(); } catch (e) { console.error("stripe switch retry failed", e); }
  // Cancel unreported charge/refund pairs (a postcard that failed and was refunded never bills).
  let netted = 0;
  try { netted = Number(await rpc("clicktide_shopify_usage_net", {})) || 0; } catch (e) { console.error("usage netting failed", e); }
  const rows = await rpc("clicktide_shopify_usage_pending", { p_limit: limit }) as Array<Record<string, unknown>>;
  const out = { stripeSwitch, netted, pending: Array.isArray(rows) ? rows.length : 0, sent: 0, failed: 0, skipped: 0 };
  if (!out.pending) return out;
  let tok = await appEventsAuth();
  for (const row of rows) {
    const id = Number(row.id);
    const shopId = String(row.merchant_id || "");
    const ev = /^\d+$/.test(shopId) ? usageEventFor(row, shopId, Date.now()) : null;
    if (!ev) {
      await rpc("clicktide_shopify_usage_mark", { p_id: id, p_ok: false, p_error: /^\d+$/.test(shopId) ? "not a billable kind" : "no Shopify shop id" })
        .catch((e) => console.error("usage mark failed", id, e));
      out.skipped++;
      continue;
    }
    const send = (t: string) => fetch(APP_EVENTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${t}`, "User-Agent": "Clicktide/1.0 (+https://goclicktide.com)" },
      body: JSON.stringify(ev),
    });
    let r: Response;
    try {
      r = await send(tok);
      if (r.status === 401) { tok = await appEventsAuth(true); r = await send(tok); }
    } catch (e) {
      // network error: unknown whether Shopify got it; mark as a failure (retried later under the
      // same idempotency key, so Shopify can't bill it twice) and keep going
      const msg = e instanceof Error ? e.message : String(e);
      console.error("shopify usage event network error", id, msg);
      await rpc("clicktide_shopify_usage_mark", { p_id: id, p_ok: false, p_error: `network: ${msg}`.slice(0, 300) })
        .catch((e2) => console.error("usage mark failed after network error", id, e2));
      out.failed++;
      continue;
    }
    if (r.status >= 200 && r.status < 300) {
      // Shopify accepted it. If recording that fails, the row stays claimed (never netted: it has
      // next_at set) and is re-sent after the claim expires; the idempotency key makes that a no-op.
      try { await rpc("clicktide_shopify_usage_mark", { p_id: id, p_ok: true, p_error: null }); out.sent++; }
      catch (e) { console.error("usage mark failed after 2xx; will re-send under the same key", id, e); out.failed++; }
    } else {
      const text = (await r.text().catch(() => "")).slice(0, 200);
      console.error("shopify usage event failed", id, r.status, text);
      await rpc("clicktide_shopify_usage_mark", { p_id: id, p_ok: false, p_error: `HTTP ${r.status} ${text}` })
        .catch((e) => console.error("usage mark failed", id, e));
      out.failed++;
      if (r.status === 429) break; // rate limited: the next run continues
    }
  }
  return out;
}

// ---- Shopify sign-in (non-embedded app, App Store 2.3.x and "seamless sign up") ----
// A store installed from Shopify gets its own Clicktide account, created here (no password,
// no e-mail round trip). Opening the app from the Shopify admin then signs that account in
// with a one-time link. Accounts that were made on the website and linked to a store by the
// owner (claim flow) are never signed in this way: those owners log in themselves.
export const APP_BASE_URL = Deno.env.get("APP_BASE_URL") ?? "https://goclicktide.com";
// A domain Clicktide controls and never receives mail at: nobody can pre-register or read these.
export const PROVISION_EMAIL_DOMAIN = "shopify-users.goclicktide.com";

async function authAdmin(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPA}/auth/v1/admin${path}`, {
    ...init,
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: d as Record<string, any> };
}

function randHex(n: number) {
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
}

// The Clicktide account Clicktide created for exactly this store?
export async function provisionedFor(userId: string, shop: string): Promise<boolean> {
  const u = await authAdmin(`/users/${encodeURIComponent(userId)}`);
  return u.ok && String(u.data?.app_metadata?.shopify_shop || "").toLowerCase() === shop.toLowerCase();
}

// Where to send the merchant: goclicktide.com/#ct_sso=<one-time code>. The code is in the URL
// fragment (never sent to a server or logged), lives 60 seconds, is single use and bound to the
// account and shop (clicktide_shopify_sso_mint; refused for staff or without an active store
// connection). The page swaps it for a session at shopify-sso.
export async function ssoUrlFor(userId: string, shop: string): Promise<string | null> {
  if (!(await provisionedFor(userId, shop))) return null;
  const code = await rpc("clicktide_shopify_sso_mint", { p_user: userId, p_shop: shop });
  if (typeof code !== "string" || !/^[0-9a-f]{64}$/.test(code)) return null;
  return `${APP_BASE_URL}/#ct_sso=${code}`;
}

// shopify-sso: one-time code -> session for the store's own account, created server-side.
export async function sessionForSsoCode(code: string): Promise<Record<string, unknown> | null> {
  const t = await rpc("clicktide_shopify_sso_take", { p_code: code }) as Record<string, any>;
  if (!t?.ok) return null;
  const userId = String(t.user_id), shop = String(t.shop);
  const u = await authAdmin(`/users/${encodeURIComponent(userId)}`);
  const email = String(u.data?.email || "");
  if (!u.ok || !email || String(u.data?.app_metadata?.shopify_shop || "").toLowerCase() !== shop) return null;
  const g = await authAdmin("/generate_link", { method: "POST", body: JSON.stringify({ type: "magiclink", email }) });
  const hashed = String(g.data?.hashed_token || g.data?.properties?.hashed_token || "");
  if (!g.ok || !hashed) { console.error("shopify sso link failed", shop, g.status); return null; }
  const v = await fetch(`${SUPA}/auth/v1/verify`, {
    method: "POST", headers: { apikey: SRK, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", token_hash: hashed }),
  });
  const sess = await v.json().catch(() => ({})) as Record<string, any>;
  if (!v.ok || !sess?.access_token) { console.error("shopify sso verify failed", shop, v.status); return null; }
  return { access_token: sess.access_token, refresh_token: sess.refresh_token, expires_in: sess.expires_in, expires_at: sess.expires_at, user: sess.user, shop };
}

async function shopProfile(shop: string, token: string) {
  try {
    const r = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST", headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ shop { name contactEmail email ianaTimezone } }" }),
    });
    const s = (await r.json().catch(() => ({})))?.data?.shop;
    if (s) return { name: String(s.name || "").replace(/[<>]/g, "").slice(0, 120), email: String(s.contactEmail || s.email || "").slice(0, 200), tz: String(s.ianaTimezone || "") };
  } catch (e) { console.error("shop profile lookup failed", shop, e); }
  return { name: "", email: "", tz: "" };
}

export type ClaimResult =
  | { ok: true; userId: string; shop: string; created: boolean }
  | { ok: false; reason: "expired" | "website_account" | "failed"; shop?: string };

// Install from Shopify finished (claim token in hand): attach the store to the Clicktide
// account Clicktide made for it before (reinstall), or make that account now. A store owned
// by a website account is left for its owner to claim after logging in.
export async function provisionForClaim(claim: string): Promise<ClaimResult> {
  const hash = await sha256Hex(claim);
  const info = await rpc("clicktide_shopify_claim_info", { p_token_hash: hash }) as Record<string, any>;
  if (!info?.ok) return { ok: false, reason: "expired" };
  const shop = String(info.shop_domain || "").toLowerCase();
  const owner = info.owner ? String(info.owner) : "";
  if (owner) {
    if (!(await provisionedFor(owner, shop))) return { ok: false, reason: "website_account", shop };
    const r = await rpc("clicktide_shopify_claim", { p_token_hash: hash, p_user: owner }) as Record<string, any>;
    return r?.ok ? { ok: true, userId: owner, shop, created: false } : { ok: false, reason: "failed", shop };
  }
  // New store: create its account and business profile, then claim.
  const rows = await rest(`/rest/v1/shopify_install_claims?token_hash=eq.${hash}&select=connection_id&limit=1`) as Array<{ connection_id: string }>;
  const conn = rows?.[0] ? (await rest(`/rest/v1/platform_connections?id=eq.${rows[0].connection_id}&select=access_token,merchant_name&limit=1`) as Array<{ access_token: string; merchant_name: string }>)?.[0] : null;
  const prof = conn?.access_token ? await shopProfile(shop, conn.access_token) : { name: "", email: "", tz: "" };
  const name = prof.name || conn?.merchant_name || shop.replace(/\.myshopify\.com$/, "");
  const slug = shop.replace(/\.myshopify\.com$/, "").slice(0, 50);
  let email = `${slug}@${PROVISION_EMAIL_DOMAIN}`;
  const create = () => authAdmin("/users", {
    method: "POST",
    body: JSON.stringify({ email, email_confirm: true, app_metadata: { shopify_shop: shop, signup: "shopify" }, user_metadata: { business_name: name } }),
  });
  let cu = await create();
  if (!cu.ok && (cu.status === 422 || cu.status === 409)) { email = `${slug}-${randHex(3)}@${PROVISION_EMAIL_DOMAIN}`; cu = await create(); }
  const userId = String(cu.data?.id || "");
  if (!cu.ok || !userId) { console.error("shopify account create failed", shop, cu.status, JSON.stringify(cu.data).slice(0, 200)); return { ok: false, reason: "failed", shop }; }
  try {
    await rest("/rest/v1/clicktide", {
      method: "POST", headers: { Prefer: "return=minimal" },
      // Owner alerts and receipts go to the store's contact address from Shopify, never the
      // internal sign-in address.
      body: JSON.stringify({ user_id: userId, business_name: name, email: prof.email || null, business_email: prof.email || null, onboarding_complete: true, business_type: "other", churn_days: 60 }),
    });
    const r = await rpc("clicktide_shopify_claim", { p_token_hash: hash, p_user: userId }) as Record<string, any>;
    if (!r?.ok) throw new Error(`claim ${r?.error || "failed"}`);
    return { ok: true, userId, shop, created: true };
  } catch (e) {
    console.error("shopify account setup failed; removing the half-made account", shop, e);
    await rest(`/rest/v1/clicktide?user_id=eq.${userId}`, { method: "DELETE" }).catch(() => {});
    await authAdmin(`/users/${userId}`, { method: "DELETE" }).catch(() => {});
    return { ok: false, reason: "failed", shop };
  }
}
